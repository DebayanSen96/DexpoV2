// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IProtocolCore {
    function owner() external view returns (address);
}

interface IVaultSafe {
    function isOwner(address account) external view returns (bool);
}

interface IIndexSwap {
    function safe() external view returns (address);
}

interface IOracle {
    function priceUsdE18(address token) external view returns (uint256);
}

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getReserveData(address asset) external view returns (
        uint256 configuration,
        uint128 liquidityIndex,
        uint128 currentLiquidityRate,
        uint128 variableBorrowIndex,
        uint128 currentVariableBorrowRate,
        uint128 currentStableBorrowRate,
        uint40 lastUpdateTimestamp,
        uint16 id,
        address aTokenAddress,
        address stableDebtTokenAddress,
        address variableDebtTokenAddress,
        address interestRateStrategyAddress,
        uint128 accruedToTreasury,
        uint128 unbacked,
        uint128 isolationModeTotalDebt
    );
}

interface IAToken {
    function balanceOf(address account) external view returns (uint256);
    function scaledBalanceOf(address account) external view returns (uint256);
}

contract LendModuleV3 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    address public immutable protocolCore;
    address public poolAddressesProvider;
    address public oracle;
    
    struct LendPosition {
        uint256 suppliedAmount;
        uint256 aTokenShares;
        uint256 lastUpdateTime;
    }
    
    mapping(address => mapping(address => LendPosition)) public positions;
    mapping(address => uint256) public totalATokenShares;
    mapping(address => address) public tokenToAToken;
    mapping(address => bool) public supportedTokens;
    address[] public supportedTokenList;
    
    event Supplied(address indexed vault, address indexed token, uint256 amount, uint256 aTokenShares);
    event Withdrawn(address indexed vault, address indexed token, uint256 amount, uint256 aTokenShares);
    event TokenSupported(address indexed token, address indexed aToken);
    event TokenRemoved(address indexed token);
    event PoolProviderUpdated(address indexed newProvider);
    event OracleUpdated(address indexed newOracle);
    
    error NotAuthorized();
    error ZeroAmount();
    error TokenNotSupported();
    error InsufficientPosition();
    error WithdrawFailed();
    
    constructor(
        address _protocolCore,
        address _poolAddressesProvider,
        address _oracle
    ) Ownable(msg.sender) {
        require(_protocolCore != address(0), "Invalid core");
        require(_poolAddressesProvider != address(0), "Invalid pool provider");
        require(_oracle != address(0), "Invalid oracle");
        
        protocolCore = _protocolCore;
        poolAddressesProvider = _poolAddressesProvider;
        oracle = _oracle;
    }
    
    modifier onlyAuthorized(address vault) {
        bool isVaultItself = (msg.sender == vault);
        bool isSafeOwner = false;
        bool isProtocolOwner = false;
        
        if (!isVaultItself) {
            address safeAddress = IIndexSwap(vault).safe();
            isSafeOwner = IVaultSafe(safeAddress).isOwner(msg.sender);
        }
        
        address protocolOwner = IProtocolCore(protocolCore).owner();
        isProtocolOwner = (msg.sender == protocolOwner);
        
        if (!isVaultItself && !isSafeOwner && !isProtocolOwner) revert NotAuthorized();
        _;
    }
    
    function supply(
        address vault,
        address token,
        uint256 amount
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 aTokenShares) {
        if (amount == 0) revert ZeroAmount();
        if (!supportedTokens[token]) revert TokenNotSupported();
        
        address pool = IPoolAddressesProvider(poolAddressesProvider).getPool();
        address aToken = tokenToAToken[token];
        
        uint256 aTokenBalanceBefore = IAToken(aToken).balanceOf(address(this));
        
        IERC20(token).safeTransferFrom(vault, address(this), amount);
        IERC20(token).forceApprove(pool, amount);
        
        IAavePool(pool).supply(token, amount, address(this), 0);
        
        uint256 aTokenBalanceAfter = IAToken(aToken).balanceOf(address(this));
        require(aTokenBalanceAfter >= aTokenBalanceBefore, "Supply failed");
        uint256 aTokenReceived = aTokenBalanceAfter - aTokenBalanceBefore;
        require(aTokenReceived > 0, "No aTokens received");
        
        uint256 totalShares = totalATokenShares[token];
        if (totalShares == 0 || aTokenBalanceBefore == 0) {
            aTokenShares = aTokenReceived;
        } else {
            aTokenShares = (aTokenReceived * totalShares) / aTokenBalanceBefore;
        }
        
        positions[vault][token].suppliedAmount += amount;
        positions[vault][token].aTokenShares += aTokenShares;
        positions[vault][token].lastUpdateTime = block.timestamp;
        totalATokenShares[token] += aTokenShares;
        
        emit Supplied(vault, token, amount, aTokenShares);
    }
    
    function withdraw(
        address vault,
        address token,
        uint256 amount
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 withdrawn) {
        if (amount == 0) revert ZeroAmount();
        if (!supportedTokens[token]) revert TokenNotSupported();
        
        LendPosition storage pos = positions[vault][token];
        if (pos.aTokenShares == 0) revert InsufficientPosition();
        
        address pool = IPoolAddressesProvider(poolAddressesProvider).getPool();
        address aToken = tokenToAToken[token];
        
        uint256 totalATokenBalance = IAToken(aToken).balanceOf(address(this));
        uint256 totalShares = totalATokenShares[token];
        
        uint256 vaultATokenBalance = (pos.aTokenShares * totalATokenBalance) / totalShares;
        
        uint256 withdrawAmount = amount;
        if (amount == type(uint256).max || amount > vaultATokenBalance) {
            withdrawAmount = vaultATokenBalance;
        }
        
        uint256 sharesToBurn = (withdrawAmount * totalShares) / totalATokenBalance;
        if (sharesToBurn > pos.aTokenShares) {
            sharesToBurn = pos.aTokenShares;
        }
        
        withdrawn = IAavePool(pool).withdraw(token, withdrawAmount, vault);
        if (withdrawn == 0) revert WithdrawFailed();
        
        pos.aTokenShares -= sharesToBurn;
        if (pos.suppliedAmount > withdrawn) {
            pos.suppliedAmount -= withdrawn;
        } else {
            pos.suppliedAmount = 0;
        }
        pos.lastUpdateTime = block.timestamp;
        totalATokenShares[token] -= sharesToBurn;
        
        emit Withdrawn(vault, token, withdrawn, sharesToBurn);
    }
    
    function withdrawAll(
        address vault,
        address token
    ) external onlyAuthorized(vault) nonReentrant returns (uint256 withdrawn) {
        if (!supportedTokens[token]) revert TokenNotSupported();
        
        LendPosition storage pos = positions[vault][token];
        if (pos.aTokenShares == 0) revert InsufficientPosition();
        
        address pool = IPoolAddressesProvider(poolAddressesProvider).getPool();
        address aToken = tokenToAToken[token];
        
        uint256 totalATokenBalance = IAToken(aToken).balanceOf(address(this));
        uint256 totalShares = totalATokenShares[token];
        
        uint256 vaultATokenBalance = (pos.aTokenShares * totalATokenBalance) / totalShares;
        
        withdrawn = IAavePool(pool).withdraw(token, vaultATokenBalance, vault);
        if (withdrawn == 0) revert WithdrawFailed();
        
        totalATokenShares[token] -= pos.aTokenShares;
        pos.aTokenShares = 0;
        pos.suppliedAmount = 0;
        pos.lastUpdateTime = block.timestamp;
        
        emit Withdrawn(vault, token, withdrawn, pos.aTokenShares);
    }
    
    function getPositionValue(address vault, address token) external view returns (uint256 valueUsd) {
        if (token == address(0)) {
            for (uint256 i = 0; i < supportedTokenList.length; i++) {
                address t = supportedTokenList[i];
                valueUsd += _getPositionValueForToken(vault, t);
            }
        } else {
            valueUsd = _getPositionValueForToken(vault, token);
        }
    }
    
    function _getPositionValueForToken(address vault, address token) internal view returns (uint256) {
        LendPosition storage pos = positions[vault][token];
        if (pos.aTokenShares == 0) return 0;
        
        address aToken = tokenToAToken[token];
        if (aToken == address(0)) return 0;
        
        uint256 totalATokenBalance = IAToken(aToken).balanceOf(address(this));
        uint256 totalShares = totalATokenShares[token];
        if (totalShares == 0) return 0;
        
        uint256 vaultTokenBalance = (pos.aTokenShares * totalATokenBalance) / totalShares;
        
        uint256 priceUsd = IOracle(oracle).priceUsdE18(token);
        uint8 decimals = IERC20Metadata(token).decimals();
        
        return (vaultTokenBalance * priceUsd) / (10 ** decimals);
    }
    
    function getPosition(address vault, address token) external view returns (
        uint256 suppliedAmount,
        uint256 currentBalance,
        uint256 aTokenShares,
        uint256 earnedInterest
    ) {
        LendPosition storage pos = positions[vault][token];
        suppliedAmount = pos.suppliedAmount;
        aTokenShares = pos.aTokenShares;
        
        if (pos.aTokenShares > 0 && totalATokenShares[token] > 0) {
            address aToken = tokenToAToken[token];
            uint256 totalATokenBalance = IAToken(aToken).balanceOf(address(this));
            currentBalance = (pos.aTokenShares * totalATokenBalance) / totalATokenShares[token];
            
            if (currentBalance > suppliedAmount) {
                earnedInterest = currentBalance - suppliedAmount;
            }
        }
    }
    
    function getVaultPositions(address vault) external view returns (
        address[] memory tokens,
        uint256[] memory balances,
        uint256[] memory values
    ) {
        uint256 count = 0;
        for (uint256 i = 0; i < supportedTokenList.length; i++) {
            if (positions[vault][supportedTokenList[i]].aTokenShares > 0) {
                count++;
            }
        }
        
        tokens = new address[](count);
        balances = new uint256[](count);
        values = new uint256[](count);
        
        uint256 idx = 0;
        for (uint256 i = 0; i < supportedTokenList.length; i++) {
            address token = supportedTokenList[i];
            LendPosition storage pos = positions[vault][token];
            
            if (pos.aTokenShares > 0) {
                tokens[idx] = token;
                
                address aToken = tokenToAToken[token];
                uint256 totalATokenBalance = IAToken(aToken).balanceOf(address(this));
                uint256 totalShares = totalATokenShares[token];
                
                if (totalShares > 0) {
                    balances[idx] = (pos.aTokenShares * totalATokenBalance) / totalShares;
                    values[idx] = _getPositionValueForToken(vault, token);
                }
                
                idx++;
            }
        }
    }
    
    function addSupportedToken(address token) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(!supportedTokens[token], "Already supported");
        
        address pool = IPoolAddressesProvider(poolAddressesProvider).getPool();
        
        (,,,,,,,, address aToken,,,,,,) = IAavePool(pool).getReserveData(token);
        require(aToken != address(0), "Token not in Aave");
        
        supportedTokens[token] = true;
        tokenToAToken[token] = aToken;
        supportedTokenList.push(token);
        
        emit TokenSupported(token, aToken);
    }
    
    function removeSupportedToken(address token) external onlyOwner {
        require(supportedTokens[token], "Not supported");
        require(totalATokenShares[token] == 0, "Has active positions");
        
        supportedTokens[token] = false;
        delete tokenToAToken[token];
        
        for (uint256 i = 0; i < supportedTokenList.length; i++) {
            if (supportedTokenList[i] == token) {
                supportedTokenList[i] = supportedTokenList[supportedTokenList.length - 1];
                supportedTokenList.pop();
                break;
            }
        }
        
        emit TokenRemoved(token);
    }
    
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokenList;
    }
    
    function setPoolAddressesProvider(address _provider) external onlyOwner {
        require(_provider != address(0), "Invalid provider");
        poolAddressesProvider = _provider;
        emit PoolProviderUpdated(_provider);
    }
    
    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Invalid oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }
    
    function getAavePool() external view returns (address) {
        return IPoolAddressesProvider(poolAddressesProvider).getPool();
    }
    
    function getAToken(address token) external view returns (address) {
        return tokenToAToken[token];
    }
}
