// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../../interfaces/IProtocolCoreOwnable.sol";
import "hardhat/console.sol";

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
    function submitTransaction(address to, uint256 value, bytes calldata data) external returns (bytes32);
}

interface IMockSwapRouter {
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);
    function swapFrom(address tokenIn, address tokenOut, uint256 amountIn, address from, address recipient) external returns (uint256 amountOut);
    function priceUsdE18(address token) external view returns (uint256);
}

interface IPositionModule {
    function getPositionValue(address vault, address token) external view returns (uint256);
}

interface IStakingModule {
    function depositNative(address vault) external payable returns (uint256);
}

contract IndexSwap is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    address public immutable protocolCore;
    address public immutable safe;
    address public swapRouter;
    
    struct TokenWeight {
        address token;
        uint16 weightBps;
    }
    
    TokenWeight[] public portfolio;
    mapping(address => bool) public isPortfolioToken;
    mapping(address => uint256) public tokenIndex;
    
    address public lendModule;
    address public borrowModule;
    address public stakingModule;
    
    uint256 public constant BPS_DIVISOR = 10000;
    uint256 public minDepositAmount;
    uint256 public lockupSeconds;
    
    mapping(address => uint256) public userDepositTimestamp;
    
    event Deposit(address indexed user, uint256 shares, uint256[] amounts);
    event Withdrawal(address indexed user, uint256 shares, uint256[] amounts);
    event PortfolioUpdated(TokenWeight[] newPortfolio);
    event Rebalanced(address indexed caller);
    event SwapRouterUpdated(address indexed newRouter);
    event ModulesUpdated(address lendModule, address borrowModule, address stakingModule);
    event NativeDeposited(address indexed user, uint256 amount);
    event NativeWithdrawn(address indexed user, uint256 amount);
    event LockupUpdated(uint256 newLockupSeconds);
    
    modifier onlySafeOrProtocolOwner() {
        bool isSafeOwner = IVaultSafe(safe).isOwner(msg.sender);
        bool isProtocolOwner = false;
        
        if (protocolCore != address(0)) {
            try IProtocolCoreOwnable(protocolCore).owner() returns (address po) {
                isProtocolOwner = (msg.sender == po);
            } catch {}
        }
        
        require(isSafeOwner || isProtocolOwner, "Not authorized");
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
        address _swapRouter,
        string memory _name,
        string memory _symbol,
        TokenWeight[] memory _portfolio,
        uint256 _lockupSeconds
    ) ERC20(_name, _symbol) {
        require(_protocolCore != address(0), "Invalid core");
        require(_safe != address(0), "Invalid safe");
        require(_swapRouter != address(0), "Invalid router");
        require(_portfolio.length > 0, "Empty portfolio");
        
        protocolCore = _protocolCore;
        safe = _safe;
        swapRouter = _swapRouter;
        lockupSeconds = _lockupSeconds;
        
        _setPortfolio(_portfolio);
    }
    
    function deposit(uint256[] calldata amounts) external nonReentrant whenNotPaused returns (uint256 shares) {
        require(amounts.length == portfolio.length, "DEPOSIT: Invalid amounts length");
        
        uint256 totalValueUsd = 0;
        
        for (uint256 i = 0; i < portfolio.length; i++) {
            if (amounts[i] > 0) {
                address token = portfolio[i].token;
                IERC20(token).safeTransferFrom(msg.sender, address(this), amounts[i]);
                
                uint256 valueUsd = _getTokenValueUsd(token, amounts[i]);
                require(valueUsd > 0, "DEPOSIT: Token price is zero");
                totalValueUsd += valueUsd;
            }
        }
        
        require(totalValueUsd > 0, "DEPOSIT: Zero deposit value");
        if (minDepositAmount > 0) {
            require(totalValueUsd >= minDepositAmount, "DEPOSIT: Below minimum");
        }
        
        uint256 supply = totalSupply();
        if (supply == 0) {
            shares = totalValueUsd;
        } else {
            uint256 currentTvlUsd = getTotalValueUsd();
            require(currentTvlUsd > 0, "DEPOSIT: Current TVL is zero");
            shares = (totalValueUsd * supply) / currentTvlUsd;
        }
        
        require(shares > 0, "DEPOSIT: Zero shares calculated");
        _mint(msg.sender, shares);
        
        userDepositTimestamp[msg.sender] = block.timestamp;
        
        emit Deposit(msg.sender, shares, amounts);
    }
    
    function depositWithAutoAllocation(address depositToken, uint256 depositAmount) 
        external 
        nonReentrant 
        whenNotPaused 
        returns (uint256 shares) 
    {
        require(depositAmount > 0, "Zero amount");
        
        IERC20(depositToken).safeTransferFrom(msg.sender, address(this), depositAmount);
        
        uint256 depositValueUsd = _getTokenValueUsd(depositToken, depositAmount);
        require(depositValueUsd > 0, "Zero value");
        
        if (minDepositAmount > 0) {
            require(depositValueUsd >= minDepositAmount, "Below minimum");
        }
        
        uint256[] memory amounts = new uint256[](portfolio.length);
        
        for (uint256 i = 0; i < portfolio.length; i++) {
            address targetToken = portfolio[i].token;
            uint16 weightBps = portfolio[i].weightBps;
            
            uint256 targetAmount = (depositAmount * weightBps) / BPS_DIVISOR;
            
            if (targetAmount > 0 && depositToken != targetToken) {
                IERC20(depositToken).forceApprove(swapRouter, targetAmount);
                uint256 received = IMockSwapRouter(swapRouter).swapFrom(
                    depositToken,
                    targetToken,
                    targetAmount,
                    address(this),
                    address(this)
                );
                amounts[i] = received;
            } else if (depositToken == targetToken) {
                amounts[i] = targetAmount;
            }
        }
        
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
        
        emit Deposit(msg.sender, shares, amounts);
    }
    
    function withdraw(uint256 shares) external nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        require(shares > 0, "Zero shares");
        require(balanceOf(msg.sender) >= shares, "Insufficient balance");
        
        if (lockupSeconds > 0) {
            require(
                block.timestamp >= userDepositTimestamp[msg.sender] + lockupSeconds,
                "Lockup period active"
            );
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
    
    function rebalance() external onlySafeOrProtocolOwner nonReentrant {
        uint256 totalValueUsd = getTotalValueUsd();
        require(totalValueUsd > 0, "Zero TVL");
        
        for (uint256 i = 0; i < portfolio.length; i++) {
            address token = portfolio[i].token;
            uint16 targetWeightBps = portfolio[i].weightBps;
            
            uint256 currentBalance = IERC20(token).balanceOf(address(this));
            uint256 currentValueUsd = _getTokenValueUsd(token, currentBalance);
            
            uint256 targetValueUsd = (totalValueUsd * targetWeightBps) / BPS_DIVISOR;
            
            if (currentValueUsd < targetValueUsd) {
                uint256 deficitUsd = targetValueUsd - currentValueUsd;
                _rebalanceDeficit(token, deficitUsd);
            } else if (currentValueUsd > targetValueUsd) {
                uint256 excessUsd = currentValueUsd - targetValueUsd;
                _rebalanceSurplus(token, excessUsd);
            }
        }
        
        emit Rebalanced(msg.sender);
    }
    
    function _rebalanceDeficit(address token, uint256 deficitUsd) internal {
        for (uint256 i = 0; i < portfolio.length; i++) {
            address sourceToken = portfolio[i].token;
            if (sourceToken == token) continue;
            
            uint256 sourceBalance = IERC20(sourceToken).balanceOf(address(this));
            if (sourceBalance == 0) continue;
            
            uint256 sourceValueUsd = _getTokenValueUsd(sourceToken, sourceBalance);
            uint256 swapAmountUsd = deficitUsd < sourceValueUsd ? deficitUsd : sourceValueUsd;
            
            uint256 swapAmount = _usdToTokenAmount(sourceToken, swapAmountUsd);
            if (swapAmount > sourceBalance) swapAmount = sourceBalance;
            
            if (swapAmount > 0) {
                IERC20(sourceToken).forceApprove(swapRouter, swapAmount);
                IMockSwapRouter(swapRouter).swapFrom(
                    sourceToken,
                    token,
                    swapAmount,
                    address(this),
                    address(this)
                );
                
                deficitUsd -= swapAmountUsd;
                if (deficitUsd == 0) break;
            }
        }
    }
    
    function _rebalanceSurplus(address token, uint256 excessUsd) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 swapAmount = _usdToTokenAmount(token, excessUsd);
        if (swapAmount > balance) swapAmount = balance;
        
        if (swapAmount > 0) {
            address targetToken = portfolio[0].token;
            if (targetToken == token && portfolio.length > 1) {
                targetToken = portfolio[1].token;
            }
            
            IERC20(token).forceApprove(swapRouter, swapAmount);
            IMockSwapRouter(swapRouter).swapFrom(
                token,
                targetToken,
                swapAmount,
                address(this),
                address(this)
            );
        }
    }
    
    function setPortfolio(TokenWeight[] calldata _portfolio) external onlySafeOrProtocolOwner {
        _setPortfolio(_portfolio);
    }
    
    function _setPortfolio(TokenWeight[] memory _portfolio) internal {
        require(_portfolio.length > 0, "Empty portfolio");
        
        uint256 totalWeight = 0;
        for (uint256 i = 0; i < _portfolio.length; i++) {
            // Allow address(0) for native ETH staking vaults
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
    
    function setSwapRouter(address _router) external onlySafeOrProtocolOwner {
        require(_router != address(0), "Invalid router");
        swapRouter = _router;
        emit SwapRouterUpdated(_router);
    }
    
    function setModules(address _lendModule, address _borrowModule, address _stakingModule) external {
        if (lendModule != address(0) || borrowModule != address(0) || stakingModule != address(0)) {
            bool isSafeOwner = IVaultSafe(safe).isOwner(msg.sender);
            bool isProtocolOwner = false;
            
            if (protocolCore != address(0)) {
                try IProtocolCoreOwnable(protocolCore).owner() returns (address po) {
                    isProtocolOwner = (msg.sender == po);
                } catch {}
            }
            
            require(isSafeOwner || isProtocolOwner, "Not authorized");
        }
        
        lendModule = _lendModule;
        borrowModule = _borrowModule;
        stakingModule = _stakingModule;
        emit ModulesUpdated(_lendModule, _borrowModule, _stakingModule);
    }
    
    function setMinDepositAmount(uint256 _minAmount) external onlySafeOrProtocolOwner {
        minDepositAmount = _minAmount;
    }
    
    function setLockupSeconds(uint256 _lockupSeconds) external onlySafeOrProtocolOwner {
        lockupSeconds = _lockupSeconds;
        emit LockupUpdated(_lockupSeconds);
    }
    
    function approveToken(address token, address spender, uint256 amount) external onlySafeOrProtocolOwner {
        require(token != address(0), "Invalid token");
        require(spender != address(0), "Invalid spender");
        IERC20(token).approve(spender, amount);
    }
    
    function getTotalValueUsd() public view returns (uint256 totalUsd) {
        bool hasNativeEth = false;
        
        for (uint256 i = 0; i < portfolio.length; i++) {
            address token = portfolio[i].token;
            if (token == address(0)) {
                hasNativeEth = true;
                continue;
            }
            uint256 balance = IERC20(token).balanceOf(address(this));
            totalUsd += _getTokenValueUsd(token, balance);
        }
        
        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0 || hasNativeEth) {
            uint256 ethPriceUsd = IMockSwapRouter(swapRouter).priceUsdE18(address(0));
            if (ethPriceUsd > 0 && ethBalance > 0) {
                totalUsd += (ethBalance * ethPriceUsd) / 1e18;
            }
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
        
        if (stakingModule != address(0)) {
            try IPositionModule(stakingModule).getPositionValue(address(this), address(0)) returns (uint256 stakingValue) {
                uint256 ethPrice = IMockSwapRouter(swapRouter).priceUsdE18(address(0));
                if (ethPrice > 0) {
                    totalUsd += (stakingValue * ethPrice) / 1e18;
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
        
        uint256 priceUsd = IMockSwapRouter(swapRouter).priceUsdE18(token);
        
        // Native ETH uses 18 decimals
        uint8 decimals = token == address(0) ? 18 : IERC20Metadata(token).decimals();
        
        return (amount * priceUsd) / (10 ** decimals);
    }
    
    function _usdToTokenAmount(address token, uint256 usdValue) internal view returns (uint256) {
        if (usdValue == 0) return 0;
        
        uint256 priceUsd = IMockSwapRouter(swapRouter).priceUsdE18(token);
        require(priceUsd > 0, "Invalid price");
        
        // Native ETH uses 18 decimals
        uint8 decimals = token == address(0) ? 18 : IERC20Metadata(token).decimals();
        return (usdValue * (10 ** decimals)) / priceUsd;
    }
    
    function depositNative() external payable nonReentrant whenNotPaused returns (uint256 shares) {
        require(msg.value > 0, "Zero deposit");
        
        uint256 ethPriceUsd = IMockSwapRouter(swapRouter).priceUsdE18(address(0));
        require(ethPriceUsd > 0, "ETH price not set");
        
        uint256 depositValueUsd = (msg.value * ethPriceUsd) / 1e18;
        
        if (minDepositAmount > 0) {
            require(depositValueUsd >= minDepositAmount, "Below minimum");
        }
        
        uint256 supply = totalSupply();
        if (supply == 0) {
            shares = depositValueUsd;
        } else {
            uint256 currentTvlUsd = getTotalValueUsd();
            require(currentTvlUsd > 0, "Current TVL is zero");
            shares = (depositValueUsd * supply) / currentTvlUsd;
        }
        
        require(shares > 0, "Zero shares");
        _mint(msg.sender, shares);
        
        userDepositTimestamp[msg.sender] = block.timestamp;
        
        emit NativeDeposited(msg.sender, msg.value);
    }
    
    function withdrawNative(uint256 shares) external nonReentrant whenNotPaused returns (uint256 ethAmount) {
        require(shares > 0, "Zero shares");
        require(balanceOf(msg.sender) >= shares, "Insufficient balance");
        
        if (lockupSeconds > 0) {
            require(
                block.timestamp >= userDepositTimestamp[msg.sender] + lockupSeconds,
                "Lockup period active"
            );
        }
        
        uint256 supply = totalSupply();
        uint256 ethBalance = address(this).balance;
        ethAmount = (ethBalance * shares) / supply;
        
        require(ethAmount > 0, "Zero ETH amount");
        require(address(this).balance >= ethAmount, "Insufficient ETH");
        
        _burn(msg.sender, shares);
        
        (bool success, ) = payable(msg.sender).call{value: ethAmount}("");
        require(success, "ETH transfer failed");
        
        emit NativeWithdrawn(msg.sender, ethAmount);
    }
    
    function getNativeBalance() external view returns (uint256) {
        return address(this).balance;
    }
    
    event NativeTransferredToStaking(uint256 amount);
    
    function transferNativeToStaking(uint256 amount) external onlySafeOrProtocolOwner nonReentrant {
        require(stakingModule != address(0), "Staking module not set");
        require(amount > 0 && amount <= address(this).balance, "Invalid amount");
        
        IStakingModule(stakingModule).depositNative{value: amount}(address(this));
        
        emit NativeTransferredToStaking(amount);
    }
    
    receive() external payable {}
}
