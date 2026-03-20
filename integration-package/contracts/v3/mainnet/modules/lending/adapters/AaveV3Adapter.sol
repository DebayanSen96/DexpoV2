// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../ILendingAdapter.sol";

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

contract AaveV3Adapter is ILendingAdapter, Ownable {
    using SafeERC20 for IERC20;

    address public immutable poolAddressesProvider;
    address public lendingHub;
    
    mapping(address => address) public tokenToAToken;
    mapping(address => bool) public supportedTokens;

    event TokenAdded(address indexed token, address indexed aToken);
    event TokenRemoved(address indexed token);
    event LendingHubUpdated(address indexed newHub);

    error OnlyHub();
    error TokenNotSupported();

    constructor(address _poolAddressesProvider) Ownable(msg.sender) {
        poolAddressesProvider = _poolAddressesProvider;
    }

    modifier onlyHub() {
        if (msg.sender != lendingHub) revert OnlyHub();
        _;
    }

    function setLendingHub(address _hub) external onlyOwner {
        lendingHub = _hub;
        emit LendingHubUpdated(_hub);
    }

    function addSupportedToken(address token) external onlyOwner {
        address pool = IPoolAddressesProvider(poolAddressesProvider).getPool();
        (,,,,,,,, address aTokenAddress,,,,,,) = IAavePool(pool).getReserveData(token);
        require(aTokenAddress != address(0), "Token not in Aave");
        
        tokenToAToken[token] = aTokenAddress;
        supportedTokens[token] = true;
        emit TokenAdded(token, aTokenAddress);
    }

    function removeSupportedToken(address token) external onlyOwner {
        supportedTokens[token] = false;
        emit TokenRemoved(token);
    }

    function protocolName() external pure override returns (string memory) {
        return "Aave V3";
    }

    function supply(
        address token,
        uint256 amount,
        address onBehalfOf
    ) external override onlyHub returns (uint256 sharesReceived) {
        if (!supportedTokens[token]) revert TokenNotSupported();
        
        address pool = IPoolAddressesProvider(poolAddressesProvider).getPool();
        address aToken = tokenToAToken[token];

        uint256 aTokenBalanceBefore = IAToken(aToken).balanceOf(onBehalfOf);

        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance >= amount, "Insufficient token balance");
        
        IERC20(token).forceApprove(pool, amount);
        IAavePool(pool).supply(token, amount, onBehalfOf, 0);

        uint256 aTokenBalanceAfter = IAToken(aToken).balanceOf(onBehalfOf);
        sharesReceived = aTokenBalanceAfter - aTokenBalanceBefore;
    }

    function withdraw(
        address token,
        uint256 shares,
        address to
    ) external override onlyHub returns (uint256 amountWithdrawn) {
        if (!supportedTokens[token]) revert TokenNotSupported();
        
        address pool = IPoolAddressesProvider(poolAddressesProvider).getPool();
        
        uint256 aTokenBalance = IAToken(tokenToAToken[token]).balanceOf(address(this));
        require(aTokenBalance >= shares, "Insufficient aToken balance");
        
        amountWithdrawn = IAavePool(pool).withdraw(token, shares, to);
    }

    function getSharesValue(address, uint256 shares) external pure override returns (uint256) {
        return shares;
    }

    function getTotalShares(address token) external view override returns (uint256) {
        address aToken = tokenToAToken[token];
        if (aToken == address(0)) return 0;
        return IAToken(aToken).balanceOf(lendingHub);
    }

    function getShareToken(address token) external view override returns (address) {
        return tokenToAToken[token];
    }

    function isTokenSupported(address token) external view override returns (bool) {
        return supportedTokens[token];
    }
}
