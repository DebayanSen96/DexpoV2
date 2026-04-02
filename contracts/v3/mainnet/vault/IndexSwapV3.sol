// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../../interfaces/IProtocolCoreOwnable.sol";
import "../../interfaces/IOracle.sol";

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
    function swap(address vault, address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes32 adapterId) external returns (uint256 amountOut);
    function swapWithSlippage(address vault, address tokenIn, address tokenOut, uint256 amountIn, uint256 slippageBps) external returns (uint256 amountOut);
}

interface ILendingModule {
    function supply(address vault, address token, uint256 amount, bytes32 adapterId) external returns (uint256 shares);
    function withdraw(address vault, address token, uint256 amount) external returns (uint256 withdrawn);
    function withdrawAll(address vault, address token) external returns (uint256 withdrawn);
}

interface IStakingModule {
    function depositBond(address vault, uint256 amount, bytes calldata validatorData) external;
    function claimRewards(address vault) external returns (uint256);
    function claimRewards(address vault, uint256 cumulativeFeeShares, bytes32[] calldata rewardsProof) external returns (uint256);
    function getPositionValue(address vault, address token) external view returns (uint256);
}

interface IWrappedNativeToken is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

contract IndexSwapV3 is Initializable, ERC20Upgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {
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
    uint256 private constant DEAD_SHARES = 1e3;
    address private constant DEAD_ADDRESS = address(1);
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
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event VaultOwnerUpdated(address indexed oldOwner, address indexed newOwner);
    event PerformanceFeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event MinDepositUpdated(uint256 oldAmount, uint256 newAmount);
    event HighWaterMarkReset(uint256 newHighWaterMark);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NativeDeposit(address indexed user, address indexed wrappedToken, uint256 assets, uint256 shares);
    
    error NotAuthorized();
    error ZeroAmount();
    error BelowMinimum();
    error LockupActive();
    error InvalidPrice();
    error AlreadyInitialized();
    error TokenNotInPortfolio();
    error StrandedTokenBalance(address token, uint256 balance);
    error ActiveExternalPosition(address token, uint256 valueUsd);
    error ActiveStrategyPosition();
    error InvalidCommand();
    error CannotRescuePortfolioToken();

    enum ModuleCommand {
        LEND_SUPPLY,
        LEND_WITHDRAW,
        LEND_WITHDRAW_ALL,
        SWAP,
        SWAP_WITH_SLIPPAGE,
        STAKE_BOND,
        STAKE_CLAIM
    }
    
    modifier onlySafeOrProtocolOwner() {
        if (
            msg.sender != safe &&
            msg.sender != vaultOwner &&
            (protocolCore == address(0) || msg.sender != IProtocolCoreOwnable(protocolCore).owner())
        ) revert NotAuthorized();
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

    function _authorizeUpgrade(address newImplementation) internal override {
        if (protocolCore == address(0) || msg.sender != IProtocolCoreOwnable(protocolCore).owner()) revert NotAuthorized();
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
        __UUPSUpgradeable_init();
        
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
            address oldToken = portfolio[i].token;
            bool stillPresent = false;
            for (uint256 j = 0; j < _portfolio.length; j++) {
                if (_portfolio[j].token == oldToken) {
                    stillPresent = true;
                    break;
                }
            }
            if (!stillPresent) {
                uint256 bal = IERC20(oldToken).balanceOf(address(this));
                if (bal > 0) revert StrandedTokenBalance(oldToken, bal);
                uint256 externalValueUsd = _getTokenExternalPositionValueUsd(oldToken);
                if (externalValueUsd > 0) revert ActiveExternalPosition(oldToken, externalValueUsd);
            }
            isPortfolioToken[oldToken] = false;
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
        uint256 supplyBefore = totalSupply();
        uint256 tvlBeforeUsd = supplyBefore == 0 ? 0 : getTotalValueUsd();
        uint256 totalValueUsd = 0;

        for (uint256 i = 0; i < portfolio.length; i++) {
            if (amounts[i] > 0) {
                address token = portfolio[i].token;
                uint256 valueUsd = _getTokenValueUsd(token, amounts[i]);
                if (valueUsd == 0) revert InvalidPrice();
                totalValueUsd += valueUsd;
                IERC20(token).safeTransferFrom(msg.sender, address(this), amounts[i]);
            }
        }

        if (totalValueUsd == 0) revert ZeroAmount();
        if (minDepositAmount > 0 && totalValueUsd < minDepositAmount) revert BelowMinimum();

        shares = _quoteDepositShares(totalValueUsd, supplyBefore, tvlBeforeUsd);
        require(shares > 0, "Zero shares");
        uint256 existingShares = balanceOf(msg.sender);
        _mint(msg.sender, shares);

        totalDepositsUsd += totalValueUsd;
        if (highWaterMarkUsd == 0) {
            highWaterMarkUsd = getTotalValueUsd();
        }
        
        _updateWeightedTimestamp(msg.sender, existingShares, shares);
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
        if (!isPortfolioToken[depositToken]) revert TokenNotInPortfolio();
        uint256 supplyBefore = totalSupply();
        uint256 tvlBeforeUsd = supplyBefore == 0 ? 0 : getTotalValueUsd();
        IERC20(depositToken).safeTransferFrom(msg.sender, address(this), depositAmount);
        shares = _mintSharesForDeposit(msg.sender, depositToken, depositAmount, supplyBefore, tvlBeforeUsd);
    }

    function depositNative(address wrappedToken)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (!isPortfolioToken[wrappedToken]) revert TokenNotInPortfolio();
        uint256 supplyBefore = totalSupply();
        uint256 tvlBeforeUsd = supplyBefore == 0 ? 0 : getTotalValueUsd();
        IWrappedNativeToken(wrappedToken).deposit{value: msg.value}();
        shares = _mintSharesForDeposit(msg.sender, wrappedToken, msg.value, supplyBefore, tvlBeforeUsd);
        emit NativeDeposit(msg.sender, wrappedToken, msg.value, shares);
    }

    function _mintSharesForDeposit(
        address receiver,
        address depositToken,
        uint256 depositAmount,
        uint256 supplyBefore,
        uint256 tvlBeforeUsd
    )
        internal
        returns (uint256 shares)
    {
        uint256 depositValueUsd = _getTokenValueUsd(depositToken, depositAmount);
        if (depositValueUsd == 0) revert InvalidPrice();

        if (minDepositAmount > 0 && depositValueUsd < minDepositAmount) revert BelowMinimum();

        shares = _quoteDepositShares(depositValueUsd, supplyBefore, tvlBeforeUsd);
        require(shares > 0, "Zero shares");
        uint256 existingShares = balanceOf(receiver);
        _mint(receiver, shares);

        totalDepositsUsd += depositValueUsd;
        if (highWaterMarkUsd == 0) {
            highWaterMarkUsd = getTotalValueUsd();
        }

        userCostBasisUsd[receiver] += depositValueUsd;
        _updateWeightedTimestamp(receiver, existingShares, shares);

        emit Deposit(receiver, shares, depositValueUsd);
    }

    function _quoteDepositShares(
        uint256 depositValueUsd,
        uint256 supplyBefore,
        uint256 tvlBeforeUsd
    ) internal returns (uint256 shares) {
        if (supplyBefore == 0) {
            shares = depositValueUsd;
            require(shares > DEAD_SHARES, "Below dead shares minimum");
            _mint(DEAD_ADDRESS, DEAD_SHARES);
            shares -= DEAD_SHARES;
        } else if (supplyBefore <= DEAD_SHARES) {
            // If only dead shares remain, treat the next depositor as a fresh bootstrap.
            // This prevents residual dust TVL from poisoning the exchange rate forever.
            shares = depositValueUsd;
        } else {
            require(tvlBeforeUsd > 0, "Zero TVL");
            shares = (depositValueUsd * supplyBefore) / tvlBeforeUsd;
        }
    }
    
    function _updateWeightedTimestamp(address user, uint256 existingShares, uint256 newShares) internal {
        uint256 existingTimestamp = userDepositTimestamp[user];
        uint256 newTimestamp = block.timestamp;
        
        if (existingShares == 0) {
            userDepositTimestamp[user] = newTimestamp;
        } else {
            uint256 totalShares = existingShares + newShares;
            uint256 weightedTimestamp = (existingTimestamp * existingShares + newTimestamp * newShares) / totalShares;
            userDepositTimestamp[user] = weightedTimestamp;
        }
    }
    
    function withdraw(uint256 shares) external nonReentrant whenNotPaused returns (uint256[] memory amounts) {
        if (shares == 0) revert ZeroAmount();
        require(balanceOf(msg.sender) >= shares, "Insufficient balance");
        
        if (lockupSeconds > 0) {
            if (block.timestamp < userDepositTimestamp[msg.sender] + lockupSeconds) {
                revert LockupActive();
            }
        }

        // Safety: prevent underpayment when part of the vault value is deployed in strategy modules.
        if (_hasAnyExternalPosition()) revert ActiveStrategyPosition();
        
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

        _burn(msg.sender, shares);
        userCostBasisUsd[msg.sender] -= userProportionalCostBasis;
        totalWithdrawalsUsd += withdrawValueUsd;
        
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
        address old = feeCollector;
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(old, _feeCollector);
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
        
        if (feeCollector == address(0) || performanceFeeBps == 0 || vaultOwner == address(0)) {
            highWaterMarkUsd = currentTvl;
            return (profitUsd, 0, 0);
        }
        
        uint256 feeAmountUsd = (profitUsd * performanceFeeBps) / BPS_DIVISOR;
        
        uint256 feeTokenPrice = IOracle(oracle).priceUsdE18(feeToken);
        uint8 feeTokenDecimals = IERC20Metadata(feeToken).decimals();
        uint256 feeTokenAmount = (feeAmountUsd * (10 ** feeTokenDecimals)) / feeTokenPrice;
        
        uint256 feeTokenBalance = IERC20(feeToken).balanceOf(address(this));
        uint256 maxExtractable = feeTokenBalance / 2;
        if (feeTokenAmount > maxExtractable) {
            feeTokenAmount = maxExtractable;
        }

        uint256 extractedFeeUsd = 0;
        if (feeTokenAmount > 0) {
            extractedFeeUsd = (feeTokenAmount * feeTokenPrice) / (10 ** feeTokenDecimals);
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

        if (currentTvl > extractedFeeUsd) {
            highWaterMarkUsd = currentTvl - extractedFeeUsd;
        } else {
            highWaterMarkUsd = 0;
        }
        
        return (profitUsd, vaultOwnerNet, protocolFee);
    }
    
    function setPerformanceFee(uint16 _feeBps) external onlySafeOrProtocolOwner {
        require(_feeBps <= 3000, "Fee too high");
        uint16 old = performanceFeeBps;
        performanceFeeBps = _feeBps;
        emit PerformanceFeeUpdated(old, _feeBps);
    }
    
    function setVaultOwner(address _owner) external onlySafeOrProtocolOwner {
        require(_owner != address(0), "Invalid owner");
        address old = vaultOwner;
        vaultOwner = _owner;
        emit VaultOwnerUpdated(old, _owner);
    }

    function setSafe(address _safe) external onlySafeOrProtocolOwner {
        require(_safe != address(0), "Invalid safe");
        safe = _safe;
        emit SafeUpdated(_safe);
    }
    
    function resetHighWaterMark() external onlySafeOrProtocolOwner {
        highWaterMarkUsd = getTotalValueUsd();
        emit HighWaterMarkReset(highWaterMarkUsd);
    }
    
    function setMinDepositAmount(uint256 _minAmount) external onlySafeOrProtocolOwner {
        uint256 old = minDepositAmount;
        minDepositAmount = _minAmount;
        emit MinDepositUpdated(old, _minAmount);
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

    error SpenderNotRegisteredModule();

    function approveToken(address token, address spender, uint256 amount) external onlySafeOrProtocolOwner {
        require(token != address(0), "Invalid token");
        require(spender != address(0), "Invalid spender");
        if (!_isRegisteredSpender(spender)) revert SpenderNotRegisteredModule();
        IERC20(token).forceApprove(spender, amount);
    }

    function _isRegisteredSpender(address spender) internal view returns (bool) {
        if (spender == feeCollector) return true;
        if (moduleRegistry == address(0)) return false;
        if (spender == IModuleRegistry(moduleRegistry).getSwapModule()) return true;
        if (spender == IModuleRegistry(moduleRegistry).getLendModule()) return true;
        if (spender == IModuleRegistry(moduleRegistry).getBorrowModule()) return true;
        if (spender == IModuleRegistry(moduleRegistry).getStakingModule()) return true;
        return false;
    }

    function rescueToken(address token, address to, uint256 amount) external onlySafeOrProtocolOwner {
        if (isPortfolioToken[token]) revert CannotRescuePortfolioToken();
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Zero amount");
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
    
    function executeModuleAction(
        ModuleCommand command,
        bytes calldata params
    ) external onlySafeOrProtocolOwner nonReentrant returns (bytes memory) {
        if (command == ModuleCommand.LEND_SUPPLY) {
            (address token, uint256 amount, bytes32 adapterId) = abi.decode(params, (address, uint256, bytes32));
            address lend = IModuleRegistry(moduleRegistry).getLendModule();
            require(lend != address(0), "Lend module not set");
            IERC20(token).forceApprove(lend, amount);
            uint256 shares = ILendingModule(lend).supply(address(this), token, amount, adapterId);
            return abi.encode(shares);
        } else if (command == ModuleCommand.LEND_WITHDRAW) {
            (address token, uint256 amount) = abi.decode(params, (address, uint256));
            address lend = IModuleRegistry(moduleRegistry).getLendModule();
            require(lend != address(0), "Lend module not set");
            uint256 withdrawn = ILendingModule(lend).withdraw(address(this), token, amount);
            return abi.encode(withdrawn);
        } else if (command == ModuleCommand.LEND_WITHDRAW_ALL) {
            address token = abi.decode(params, (address));
            address lend = IModuleRegistry(moduleRegistry).getLendModule();
            require(lend != address(0), "Lend module not set");
            uint256 withdrawn = ILendingModule(lend).withdrawAll(address(this), token);
            return abi.encode(withdrawn);
        } else if (command == ModuleCommand.SWAP) {
            (address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes32 adapterId) = abi.decode(params, (address, address, uint256, uint256, bytes32));
            address swap = IModuleRegistry(moduleRegistry).getSwapModule();
            require(swap != address(0), "Swap module not set");
            IERC20(tokenIn).forceApprove(swap, amountIn);
            uint256 amountOut = ISwapModule(swap).swap(address(this), tokenIn, tokenOut, amountIn, minAmountOut, adapterId);
            return abi.encode(amountOut);
        } else if (command == ModuleCommand.SWAP_WITH_SLIPPAGE) {
            (address tokenIn, address tokenOut, uint256 amountIn, uint256 slippageBps) = abi.decode(params, (address, address, uint256, uint256));
            address swap = IModuleRegistry(moduleRegistry).getSwapModule();
            require(swap != address(0), "Swap module not set");
            IERC20(tokenIn).forceApprove(swap, amountIn);
            uint256 amountOut = ISwapModule(swap).swapWithSlippage(address(this), tokenIn, tokenOut, amountIn, slippageBps);
            return abi.encode(amountOut);
        } else if (command == ModuleCommand.STAKE_BOND) {
            (address token, uint256 amount, bytes memory validatorData) = abi.decode(params, (address, uint256, bytes));
            address staking = IModuleRegistry(moduleRegistry).getStakingModule();
            require(staking != address(0), "Staking module not set");
            IERC20(token).forceApprove(staking, amount);
            IStakingModule(staking).depositBond(address(this), amount, validatorData);
            return abi.encode(amount);
        } else if (command == ModuleCommand.STAKE_CLAIM) {
            address staking = IModuleRegistry(moduleRegistry).getStakingModule();
            require(staking != address(0), "Staking module not set");
            uint256 claimed;
            if (params.length == 0) {
                claimed = IStakingModule(staking).claimRewards(address(this));
            } else {
                (uint256 cumulativeFeeShares, bytes32[] memory rewardsProof) = abi.decode(params, (uint256, bytes32[]));
                claimed = IStakingModule(staking).claimRewards(address(this), cumulativeFeeShares, rewardsProof);
            }
            return abi.encode(claimed);
        } else {
            revert InvalidCommand();
        }
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

        if (moduleRegistry != address(0)) {
            try IModuleRegistry(moduleRegistry).getStakingModule() returns (address staking) {
                if (staking != address(0)) {
                    try IStakingModule(staking).getPositionValue(address(this), address(0)) returns (uint256 stakingValue) {
                        totalUsd += stakingValue;
                    } catch {}
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
    
    error ShareTransfersDisabled();

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert ShareTransfersDisabled();
        super._update(from, to, value);
    }

    function _getTokenValueUsd(address token, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        
        uint256 priceUsd = IOracle(oracle).priceUsdE18(token);
        uint8 decimals = IERC20Metadata(token).decimals();
        
        return (amount * priceUsd) / (10 ** decimals);
    }

    function _getTokenExternalPositionValueUsd(address token) internal view returns (uint256 valueUsd) {
        if (lendModule != address(0)) {
            try IPositionModule(lendModule).getPositionValue(address(this), token) returns (uint256 lendValue) {
                valueUsd += lendValue;
            } catch {}
        }

        if (moduleRegistry != address(0)) {
            try IModuleRegistry(moduleRegistry).getStakingModule() returns (address staking) {
                if (staking != address(0)) {
                    try IPositionModule(staking).getPositionValue(address(this), token) returns (uint256 stakingValue) {
                        valueUsd += stakingValue;
                    } catch {}
                }
            } catch {}
        }
    }

    function _hasAnyExternalPosition() internal view returns (bool) {
        if (lendModule != address(0)) {
            try IPositionModule(lendModule).getPositionValue(address(this), address(0)) returns (uint256 lendValue) {
                if (lendValue > 0) return true;
            } catch {}
        }

        if (moduleRegistry != address(0)) {
            try IModuleRegistry(moduleRegistry).getStakingModule() returns (address staking) {
                if (staking != address(0)) {
                    try IPositionModule(staking).getPositionValue(address(this), address(0)) returns (uint256 stakingValue) {
                        if (stakingValue > 0) return true;
                    } catch {}
                }
            } catch {}
        }

        return false;
    }
    
    function emergencyRescueETH(address to, uint256 amount) external onlySafeOrProtocolOwner {
        require(to != address(0), "Invalid recipient");
        uint256 available = address(this).balance;
        uint256 rescueAmount = amount == 0 ? available : amount;
        require(rescueAmount <= available, "Insufficient ETH");
        (bool ok, ) = to.call{value: rescueAmount}("");
        require(ok, "ETH transfer failed");
    }

    receive() external payable {}
}
