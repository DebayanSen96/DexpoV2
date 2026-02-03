// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IProtocolCoreOwnable.sol";
import "../interfaces/IOracle.sol";
import "../interfaces/ISwapRouter.sol";

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
}

interface IPositionModule {
    function getPositionValue(address vault, address token) external view returns (uint256);
}

contract IndexSwapV3 is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    address public immutable protocolCore;
    address public immutable safe;
    address public oracle;
    address public swapRouter;
    
    struct TokenWeight {
        address token;
        uint16 weightBps;
    }
    
    TokenWeight[] public portfolio;
    mapping(address => bool) public isPortfolioToken;
    mapping(address => uint256) public tokenIndex;
    mapping(address => uint24) public tokenPoolFee;
    
    address public lendModule;
    address public borrowModule;
    
    uint256 public constant BPS_DIVISOR = 10000;
    uint256 public minDepositAmount;
    uint256 public lockupSeconds;
    uint256 public maxSlippageBps = 100;
    uint24 public defaultPoolFee = 3000;
    
    mapping(address => uint256) public userDepositTimestamp;
    
    event Deposit(address indexed user, uint256 shares, uint256 valueUsd);
    event Withdrawal(address indexed user, uint256 shares, uint256[] amounts);
    event PortfolioUpdated(TokenWeight[] newPortfolio);
    event Rebalanced(address indexed caller);
    event OracleUpdated(address indexed newOracle);
    event SwapRouterUpdated(address indexed newRouter);
    event ModulesUpdated(address lendModule, address borrowModule);
    event LockupUpdated(uint256 newLockupSeconds);
    event MaxSlippageUpdated(uint256 newSlippageBps);
    
    error NotAuthorized();
    error ZeroAmount();
    error BelowMinimum();
    error LockupActive();
    error InvalidPrice();
    
    modifier onlySafeOrProtocolOwner() {
        bool isSafeOwner = IVaultSafe(safe).isOwner(msg.sender);
        bool isProtocolOwner = false;
        
        if (protocolCore != address(0)) {
            try IProtocolCoreOwnable(protocolCore).owner() returns (address po) {
                isProtocolOwner = (msg.sender == po);
            } catch {}
        }
        
        if (!isSafeOwner && !isProtocolOwner) revert NotAuthorized();
        _;
    }
    
    modifier whenNotPaused() {
        if (protocolCore != address(0)) {
            try IProtocolCoreOwnable(protocolCore).isGlobalPaused() returns (bool paused) {
                require(!paused, "Globally paused");
            } catch {}
            
            try IProtocolCoreOwnable(protocolCore).isVaultPaused(address(this)) returns (bool paused) {
                require(!paused, "Vault paused");
            } catch {}
        }
        _;
    }
    
    constructor(
        address _protocolCore,
        address _safe,
        address _oracle,
        address _swapRouter,
        string memory _name,
        string memory _symbol,
        TokenWeight[] memory _portfolio,
        uint256 _lockupSeconds
    ) ERC20(_name, _symbol) {
        require(_protocolCore != address(0), "Invalid core");
        require(_safe != address(0), "Invalid safe");
        require(_oracle != address(0), "Invalid oracle");
        require(_swapRouter != address(0), "Invalid router");
        require(_portfolio.length > 0, "Empty portfolio");
        
        protocolCore = _protocolCore;
        safe = _safe;
        oracle = _oracle;
        swapRouter = _swapRouter;
        lockupSeconds = _lockupSeconds;
        
        _setPortfolio(_portfolio);
    }
    
    function deposit(uint256[] calldata amounts) external nonReentrant whenNotPaused returns (uint256 shares) {
        require(amounts.length == portfolio.length, "Invalid amounts length");
        
        uint256 totalValueUsd = 0;
        
        for (uint256 i = 0; i < portfolio.length; i++) {
            if (amounts[i] > 0) {
                address token = portfolio[i].token;
                IERC20(token).safeTransferFrom(msg.sender, address(this), amounts[i]);
                
                uint256 valueUsd = _getTokenValueUsd(token, amounts[i]);
                if (valueUsd == 0) revert InvalidPrice();
                totalValueUsd += valueUsd;
            }
        }
        
        if (totalValueUsd == 0) revert ZeroAmount();
        if (minDepositAmount > 0 && totalValueUsd < minDepositAmount) revert BelowMinimum();
        
        uint256 supply = totalSupply();
        if (supply == 0) {
            shares = totalValueUsd;
        } else {
            uint256 currentTvlUsd = getTotalValueUsd();
            require(currentTvlUsd > 0, "Zero TVL");
            shares = (totalValueUsd * supply) / currentTvlUsd;
        }
        
        require(shares > 0, "Zero shares");
        _mint(msg.sender, shares);
        
        userDepositTimestamp[msg.sender] = block.timestamp;
        
        emit Deposit(msg.sender, shares, totalValueUsd);
    }
    
    function depositSingle(address depositToken, uint256 depositAmount) 
        external 
        nonReentrant 
        whenNotPaused 
        returns (uint256 shares) 
    {
        if (depositAmount == 0) revert ZeroAmount();
        
        IERC20(depositToken).safeTransferFrom(msg.sender, address(this), depositAmount);
        
        uint256 depositValueUsd = _getTokenValueUsd(depositToken, depositAmount);
        if (depositValueUsd == 0) revert InvalidPrice();
        
        if (minDepositAmount > 0 && depositValueUsd < minDepositAmount) revert BelowMinimum();
        
        uint256 supply = totalSupply();
        if (supply == 0) {
            shares = depositValueUsd;
        } else {
            uint256 currentTvlUsd = getTotalValueUsd();
            shares = (depositValueUsd * supply) / currentTvlUsd;
        }
        
        require(shares > 0, "Zero shares");
        _mint(msg.sender, shares);
        
        userDepositTimestamp[msg.sender] = block.timestamp;
        
        emit Deposit(msg.sender, shares, depositValueUsd);
    }
    
    function withdraw(uint256 shares) external nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (shares == 0) revert ZeroAmount();
        require(balanceOf(msg.sender) >= shares, "Insufficient balance");
        
        if (lockupSeconds > 0) {
            if (block.timestamp < userDepositTimestamp[msg.sender] + lockupSeconds) {
                revert LockupActive();
            }
        }
        
        uint256 supply = totalSupply();
        amounts = new uint256[](portfolio.length);
        
        for (uint256 i = 0; i < portfolio.length; i++) {
            address token = portfolio[i].token;
            uint256 balance = IERC20(token).balanceOf(address(this));
            uint256 amount = (balance * shares) / supply;
            
            if (amount > 0) {
                amounts[i] = amount;
                IERC20(token).safeTransfer(msg.sender, amount);
            }
        }
        
        _burn(msg.sender, shares);
        
        emit Withdrawal(msg.sender, shares, amounts);
    }
    
    function buyToken(address baseToken, address tokenToBuy, uint256 amountBase) 
        external 
        onlySafeOrProtocolOwner 
        nonReentrant 
        returns (uint256 amountOut) 
    {
        if (amountBase == 0) revert ZeroAmount();
        
        uint256 amountOutMin = _calculateMinOutput(baseToken, tokenToBuy, amountBase);
        
        IERC20(baseToken).forceApprove(swapRouter, amountBase);
        
        uint24 fee = _getPoolFee(tokenToBuy);
        
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: baseToken,
            tokenOut: tokenToBuy,
            fee: fee,
            recipient: address(this),
            amountIn: amountBase,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });
        
        amountOut = ISwapRouter(swapRouter).exactInputSingle(params);
    }
    
    function sellToken(address tokenToSell, address baseToken, uint256 amountToken) 
        external 
        onlySafeOrProtocolOwner 
        nonReentrant 
        returns (uint256 amountOut) 
    {
        if (amountToken == 0) revert ZeroAmount();
        
        uint256 amountOutMin = _calculateMinOutput(tokenToSell, baseToken, amountToken);
        
        IERC20(tokenToSell).forceApprove(swapRouter, amountToken);
        
        uint24 fee = _getPoolFee(tokenToSell);
        
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenToSell,
            tokenOut: baseToken,
            fee: fee,
            recipient: address(this),
            amountIn: amountToken,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });
        
        amountOut = ISwapRouter(swapRouter).exactInputSingle(params);
    }
    
    function _calculateMinOutput(address tokenIn, address tokenOut, uint256 amountIn) internal view returns (uint256) {
        uint256 priceIn = IOracle(oracle).priceUsdE18(tokenIn);
        uint256 priceOut = IOracle(oracle).priceUsdE18(tokenOut);
        
        if (priceIn == 0 || priceOut == 0) return 0;
        
        uint8 decimalsIn = IERC20Metadata(tokenIn).decimals();
        uint8 decimalsOut = IERC20Metadata(tokenOut).decimals();
        
        uint256 valueUsd = (amountIn * priceIn) / (10 ** decimalsIn);
        uint256 expectedOut = (valueUsd * (10 ** decimalsOut)) / priceOut;
        
        return (expectedOut * (10000 - maxSlippageBps)) / 10000;
    }
    
    function _getPoolFee(address token) internal view returns (uint24) {
        uint24 fee = tokenPoolFee[token];
        return fee > 0 ? fee : defaultPoolFee;
    }
    
    function setPortfolio(TokenWeight[] calldata _portfolio) external onlySafeOrProtocolOwner {
        _setPortfolio(_portfolio);
    }
    
    function _setPortfolio(TokenWeight[] memory _portfolio) internal {
        require(_portfolio.length > 0, "Empty portfolio");
        
        uint256 totalWeight = 0;
        for (uint256 i = 0; i < _portfolio.length; i++) {
            totalWeight += _portfolio[i].weightBps;
        }
        require(totalWeight == BPS_DIVISOR, "Weights must sum to 100%");
        
        for (uint256 i = 0; i < portfolio.length; i++) {
            isPortfolioToken[portfolio[i].token] = false;
        }
        delete portfolio;
        
        for (uint256 i = 0; i < _portfolio.length; i++) {
            portfolio.push(_portfolio[i]);
            isPortfolioToken[_portfolio[i].token] = true;
            tokenIndex[_portfolio[i].token] = i;
        }
        
        emit PortfolioUpdated(_portfolio);
    }
    
    function setOracle(address _oracle) external onlySafeOrProtocolOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }
    
    function setSwapRouter(address _router) external onlySafeOrProtocolOwner {
        require(_router != address(0), "Invalid router");
        swapRouter = _router;
        emit SwapRouterUpdated(_router);
    }
    
    function setModules(address _lendModule, address _borrowModule) external onlySafeOrProtocolOwner {
        lendModule = _lendModule;
        borrowModule = _borrowModule;
        emit ModulesUpdated(_lendModule, _borrowModule);
    }
    
    function setMinDepositAmount(uint256 _minAmount) external onlySafeOrProtocolOwner {
        minDepositAmount = _minAmount;
    }
    
    function setLockupSeconds(uint256 _lockupSeconds) external onlySafeOrProtocolOwner {
        lockupSeconds = _lockupSeconds;
        emit LockupUpdated(_lockupSeconds);
    }
    
    function setMaxSlippage(uint256 _slippageBps) external onlySafeOrProtocolOwner {
        require(_slippageBps <= 1000, "Slippage too high");
        maxSlippageBps = _slippageBps;
        emit MaxSlippageUpdated(_slippageBps);
    }
    
    function setPoolFee(address token, uint24 fee) external onlySafeOrProtocolOwner {
        tokenPoolFee[token] = fee;
    }
    
    function setDefaultPoolFee(uint24 fee) external onlySafeOrProtocolOwner {
        defaultPoolFee = fee;
    }
    
    function approveToken(address token, address spender, uint256 amount) external onlySafeOrProtocolOwner {
        require(token != address(0), "Invalid token");
        require(spender != address(0), "Invalid spender");
        IERC20(token).forceApprove(spender, amount);
    }
    
    function getTotalValueUsd() public view returns (uint256 totalUsd) {
        for (uint256 i = 0; i < portfolio.length; i++) {
            address token = portfolio[i].token;
            if (token == address(0)) continue;
            uint256 balance = IERC20(token).balanceOf(address(this));
            totalUsd += _getTokenValueUsd(token, balance);
        }
        
        if (lendModule != address(0)) {
            try IPositionModule(lendModule).getPositionValue(address(this), address(0)) returns (uint256 lendValue) {
                totalUsd += lendValue;
            } catch {}
        }
        
        if (borrowModule != address(0)) {
            try IPositionModule(borrowModule).getPositionValue(address(this), address(0)) returns (uint256 borrowValue) {
                if (totalUsd > borrowValue) {
                    totalUsd -= borrowValue;
                } else {
                    totalUsd = 0;
                }
            } catch {}
        }
    }
    
    function getSharePrice() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e18;
        return (getTotalValueUsd() * 1e18) / supply;
    }
    
    function getPortfolio() external view returns (TokenWeight[] memory) {
        return portfolio;
    }
    
    function _getTokenValueUsd(address token, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        
        uint256 priceUsd = IOracle(oracle).priceUsdE18(token);
        uint8 decimals = IERC20Metadata(token).decimals();
        
        return (amount * priceUsd) / (10 ** decimals);
    }
    
    receive() external payable {}
}
