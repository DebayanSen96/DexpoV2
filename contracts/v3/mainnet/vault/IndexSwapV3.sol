// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../../interfaces/IProtocolCoreOwnable.sol";
import "../../interfaces/IOracle.sol";

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
}

interface IPositionModule {
    function getPositionValue(address vault, address token) external view returns (uint256);
}

interface IFeeCollector {
    function distributePerformanceFee(address token, uint256 totalProfit, uint16 vaultPerformanceFeeBps, address vaultOwner) external returns (uint256 vaultOwnerNet, uint256 protocolFee);
    function protocolCutBps() external view returns (uint16);
}

interface IModuleRegistry {
    function getSwapModule() external view returns (address);
    function getStakingModule() external view returns (address);
    function getLendModule() external view returns (address);
    function getBorrowModule() external view returns (address);
    function getOracle() external view returns (address);
}

interface ISwapModule {
    function swap(address vault, address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut);
    function swapWithSlippage(address vault, address tokenIn, address tokenOut, uint256 amountIn, uint256 slippageBps) external returns (uint256 amountOut);
}

contract IndexSwapV3 is Initializable, ERC20Upgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    
    address public protocolCore;
    address public safe;
    address public moduleRegistry;
    address public oracle;
    
    struct TokenWeight {
        address token;
        uint16 weightBps;
    }
    
    TokenWeight[] public portfolio;
    mapping(address => bool) public isPortfolioToken;
    mapping(address => uint256) public tokenIndex;
    address public lendModule;
    address public borrowModule;
    address public feeCollector;
    
    uint16 public performanceFeeBps;
    address public vaultOwner;
    uint256 public highWaterMarkUsd;
    uint256 public totalDepositsUsd;
    uint256 public totalWithdrawalsUsd;
    
    uint256 public constant BPS_DIVISOR = 10000;
    uint256 public minDepositAmount;
    uint256 public lockupSeconds;
    uint256 public maxSlippageBps;
    
    mapping(address => uint256) public userDepositTimestamp;
    mapping(address => uint256) public userCostBasisUsd;
    
    event Deposit(address indexed user, uint256 shares, uint256 valueUsd);
    event Withdrawal(address indexed user, uint256 shares, uint256[] amounts);
    event PortfolioUpdated(TokenWeight[] newPortfolio);
    event Rebalanced(address indexed caller);
    event OracleUpdated(address indexed newOracle);
    event ModuleRegistryUpdated(address indexed newRegistry);
    event ModulesUpdated(address lendModule, address borrowModule);
    event LockupUpdated(uint256 newLockupSeconds);
    event MaxSlippageUpdated(uint256 newSlippageBps);
    event SafeUpdated(address indexed newSafe);
    
    error NotAuthorized();
    error ZeroAmount();
    error BelowMinimum();
    error LockupActive();
    error InvalidPrice();
    error AlreadyInitialized();
    
    modifier onlySafeOrProtocolOwner() {
        bool isSafeOwner = msg.sender == safe;
        if (!isSafeOwner && safe != address(0)) {
            try IVaultSafe(safe).isOwner(msg.sender) returns (bool result) {
                isSafeOwner = result;
            } catch {}
        }
        bool isVaultOwner = msg.sender == vaultOwner;
        bool isProtocolOwner = false;
        
        if (protocolCore != address(0)) {
            try IProtocolCoreOwnable(protocolCore).owner() returns (address po) {
                isProtocolOwner = (msg.sender == po);
            } catch {}
        }
        
        if (!isSafeOwner && !isVaultOwner && !isProtocolOwner) revert NotAuthorized();
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
    
    constructor() {
        _disableInitializers();
    }
    
    struct InitParams {
        address protocolCore;
        address vaultOwner;
        address moduleRegistry;
        address feeCollector;
        address lendModule;
        address borrowModule;
        uint16 performanceFeeBps;
        uint256 lockupSeconds;
    }
    
    function initialize(
        InitParams calldata params,
        string calldata _name,
        string calldata _symbol,
        TokenWeight[] calldata _portfolio
    ) external initializer {
        require(params.protocolCore != address(0), "Invalid core");
        require(params.vaultOwner != address(0), "Invalid owner");
        require(params.moduleRegistry != address(0), "Invalid registry");
        require(_portfolio.length > 0, "Empty portfolio");
        
        __ERC20_init(_name, _symbol);
        __ReentrancyGuard_init();
        
        protocolCore = params.protocolCore;
        safe = params.vaultOwner;
        vaultOwner = params.vaultOwner;
        moduleRegistry = params.moduleRegistry;
        oracle = IModuleRegistry(params.moduleRegistry).getOracle();
        lockupSeconds = params.lockupSeconds;
        maxSlippageBps = 100;
        
        feeCollector = params.feeCollector;
        lendModule = params.lendModule;
        borrowModule = params.borrowModule;
        performanceFeeBps = params.performanceFeeBps;
        
        _setPortfolioInternal(_portfolio);
    }
    
    function _setPortfolioInternal(TokenWeight[] calldata _portfolio) internal {
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
        
        totalDepositsUsd += totalValueUsd;
        if (highWaterMarkUsd == 0) {
            highWaterMarkUsd = getTotalValueUsd();
        }
        
        userDepositTimestamp[msg.sender] = block.timestamp;
        userCostBasisUsd[msg.sender] += totalValueUsd;
        
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
        
        totalDepositsUsd += depositValueUsd;
        if (highWaterMarkUsd == 0) {
            highWaterMarkUsd = getTotalValueUsd();
        }
        
        userDepositTimestamp[msg.sender] = block.timestamp;
        userCostBasisUsd[msg.sender] += depositValueUsd;
        
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
        uint256 userTotalShares = balanceOf(msg.sender);
        
        uint256 userProportionalCostBasis = (userCostBasisUsd[msg.sender] * shares) / userTotalShares;
        
        amounts = new uint256[](portfolio.length);
        uint256 withdrawValueUsd = 0;
        
        for (uint256 i = 0; i < portfolio.length; i++) {
            address token = portfolio[i].token;
            uint256 balance = IERC20(token).balanceOf(address(this));
            uint256 amount = (balance * shares) / supply;
            
            if (amount > 0) {
                amounts[i] = amount;
                withdrawValueUsd += _getTokenValueUsd(token, amount);
            }
        }
        
        uint256 feeAmountUsd = 0;
        if (withdrawValueUsd > userProportionalCostBasis && performanceFeeBps > 0 && feeCollector != address(0)) {
            uint256 profitUsd = withdrawValueUsd - userProportionalCostBasis;
            feeAmountUsd = (profitUsd * performanceFeeBps) / BPS_DIVISOR;
        }
        
        for (uint256 i = 0; i < portfolio.length; i++) {
            if (amounts[i] > 0) {
                address token = portfolio[i].token;
                uint256 feeAmount = 0;
                
                if (feeAmountUsd > 0 && withdrawValueUsd > 0) {
                    feeAmount = (amounts[i] * feeAmountUsd) / withdrawValueUsd;
                    if (feeAmount > 0 && vaultOwner != address(0)) {
                        IERC20(token).forceApprove(feeCollector, feeAmount);
                        IFeeCollector(feeCollector).distributePerformanceFee(
                            token,
                            feeAmount,
                            performanceFeeBps,
                            vaultOwner
                        );
                        amounts[i] -= feeAmount;
                    }
                }
                
                IERC20(token).safeTransfer(msg.sender, amounts[i]);
            }
        }
        
        userCostBasisUsd[msg.sender] -= userProportionalCostBasis;
        totalWithdrawalsUsd += withdrawValueUsd;
        
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
        
        address swapModule = IModuleRegistry(moduleRegistry).getSwapModule();
        require(swapModule != address(0), "Swap module not set");
        
        IERC20(baseToken).forceApprove(swapModule, amountBase);
        amountOut = ISwapModule(swapModule).swapWithSlippage(
            address(this),
            baseToken,
            tokenToBuy,
            amountBase,
            maxSlippageBps
        );
    }
    
    function sellToken(address tokenToSell, address baseToken, uint256 amountToken) 
        external 
        onlySafeOrProtocolOwner 
        nonReentrant 
        returns (uint256 amountOut) 
    {
        if (amountToken == 0) revert ZeroAmount();
        
        address swapModule = IModuleRegistry(moduleRegistry).getSwapModule();
        require(swapModule != address(0), "Swap module not set");
        
        IERC20(tokenToSell).forceApprove(swapModule, amountToken);
        amountOut = ISwapModule(swapModule).swapWithSlippage(
            address(this),
            tokenToSell,
            baseToken,
            amountToken,
            maxSlippageBps
        );
    }
    
    function setPortfolio(TokenWeight[] calldata _portfolio) external onlySafeOrProtocolOwner {
        _setPortfolioInternal(_portfolio);
    }
    
    function setOracle(address _oracle) external onlySafeOrProtocolOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }
    
    function setModuleRegistry(address _registry) external onlySafeOrProtocolOwner {
        require(_registry != address(0), "Invalid registry");
        moduleRegistry = _registry;
        oracle = IModuleRegistry(_registry).getOracle();
        emit ModuleRegistryUpdated(_registry);
    }
    
    function setModules(address _lendModule, address _borrowModule) external onlySafeOrProtocolOwner {
        lendModule = _lendModule;
        borrowModule = _borrowModule;
        emit ModulesUpdated(_lendModule, _borrowModule);
    }
    
    function setFeeCollector(address _feeCollector) external onlySafeOrProtocolOwner {
        feeCollector = _feeCollector;
    }
    
    function getProfitUsd() public view returns (uint256 profitUsd) {
        uint256 currentTvl = getTotalValueUsd();
        uint256 netDeposits = totalDepositsUsd > totalWithdrawalsUsd ? totalDepositsUsd - totalWithdrawalsUsd : 0;
        
        if (currentTvl > netDeposits) {
            profitUsd = currentTvl - netDeposits;
        }
        
        if (currentTvl > highWaterMarkUsd && highWaterMarkUsd > 0) {
            uint256 hwmProfit = currentTvl - highWaterMarkUsd;
            if (hwmProfit < profitUsd) {
                profitUsd = hwmProfit;
            }
        }
    }
    
    function harvestProfitUsd(address feeToken) external onlySafeOrProtocolOwner nonReentrant returns (uint256 profitUsd, uint256 vaultOwnerNet, uint256 protocolFee) {
        uint256 currentTvl = getTotalValueUsd();
        
        if (currentTvl <= highWaterMarkUsd) return (0, 0, 0);
        
        profitUsd = currentTvl - highWaterMarkUsd;
        highWaterMarkUsd = currentTvl;
        
        if (feeCollector == address(0) || performanceFeeBps == 0 || vaultOwner == address(0)) {
            return (profitUsd, 0, 0);
        }
        
        uint256 feeAmountUsd = (profitUsd * performanceFeeBps) / BPS_DIVISOR;
        
        uint256 feeTokenPrice = IOracle(oracle).priceUsdE18(feeToken);
        uint8 feeTokenDecimals = IERC20Metadata(feeToken).decimals();
        uint256 feeTokenAmount = (feeAmountUsd * (10 ** feeTokenDecimals)) / feeTokenPrice;
        
        uint256 feeTokenBalance = IERC20(feeToken).balanceOf(address(this));
        if (feeTokenAmount > feeTokenBalance) {
            feeTokenAmount = feeTokenBalance;
        }
        
        if (feeTokenAmount > 0) {
            IERC20(feeToken).forceApprove(feeCollector, feeTokenAmount);
            (vaultOwnerNet, protocolFee) = IFeeCollector(feeCollector).distributePerformanceFee(
                feeToken,
                feeTokenAmount,
                performanceFeeBps,
                vaultOwner
            );
        }
        
        return (profitUsd, vaultOwnerNet, protocolFee);
    }
    
    function setPerformanceFee(uint16 _feeBps) external onlySafeOrProtocolOwner {
        require(_feeBps <= 3000, "Fee too high");
        performanceFeeBps = _feeBps;
    }
    
    function setVaultOwner(address _owner) external onlySafeOrProtocolOwner {
        require(_owner != address(0), "Invalid owner");
        vaultOwner = _owner;
    }

    function setSafe(address _safe) external onlySafeOrProtocolOwner {
        require(_safe != address(0), "Invalid safe");
        safe = _safe;
        emit SafeUpdated(_safe);
    }
    
    function resetHighWaterMark() external onlySafeOrProtocolOwner {
        highWaterMarkUsd = getTotalValueUsd();
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
    
    function approveToken(address token, address spender, uint256 amount) external onlySafeOrProtocolOwner {
        require(token != address(0), "Invalid token");
        require(spender != address(0), "Invalid spender");
        IERC20(token).forceApprove(spender, amount);
    }
    
    function executeModuleAction(
        address module,
        bytes calldata data
    ) external onlySafeOrProtocolOwner nonReentrant returns (bytes memory) {
        require(module != address(0), "Invalid module");
        
        address registeredLend = IModuleRegistry(moduleRegistry).getLendModule();
        address registeredBorrow = IModuleRegistry(moduleRegistry).getBorrowModule();
        address registeredStaking = IModuleRegistry(moduleRegistry).getStakingModule();
        address registeredSwap = IModuleRegistry(moduleRegistry).getSwapModule();
        
        require(
            module == registeredLend || 
            module == registeredBorrow || 
            module == registeredStaking ||
            module == registeredSwap,
            "Module not registered"
        );
        
        (bool success, bytes memory result) = module.call(data);
        require(success, "Module call failed");
        
        return result;
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
