// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../mainnet/modules/lending/ILendingAdapter.sol";
import "../../mocks/MockERC20.sol";

contract MockLendingAdapter is ILendingAdapter, Ownable {
    using SafeERC20 for IERC20;

    address public lendingHub;

    mapping(address => address) public tokenToShareToken;
    mapping(address => bool) public supportedTokens;
    mapping(address => uint256) public totalUnderlyingByToken;
    mapping(address => uint256) public tokenRateE18;

    event LendingHubUpdated(address indexed newHub);
    event TokenAdded(address indexed token, address indexed shareToken);
    event TokenRateUpdated(address indexed token, uint256 newRateE18);

    error OnlyHub();
    error TokenNotSupported();
    error InvalidRate();

    constructor() Ownable(msg.sender) {}

    modifier onlyHub() {
        if (msg.sender != lendingHub) revert OnlyHub();
        _;
    }

    function setLendingHub(address _hub) external onlyOwner {
        lendingHub = _hub;
        emit LendingHubUpdated(_hub);
    }

    function addSupportedToken(address token, string calldata shareName, string calldata shareSymbol) external onlyOwner {
        require(token != address(0), "Invalid token");
        address shareToken = tokenToShareToken[token];
        if (shareToken == address(0)) {
            uint8 decimals = _safeDecimals(token);
            MockERC20 deployedShare = new MockERC20(shareName, shareSymbol, decimals);
            shareToken = address(deployedShare);
            tokenToShareToken[token] = shareToken;
        }
        supportedTokens[token] = true;
        if (tokenRateE18[token] == 0) {
            tokenRateE18[token] = 1e18;
        }
        emit TokenAdded(token, shareToken);
    }

    function setTokenRate(address token, uint256 rateE18) external onlyOwner {
        if (!supportedTokens[token]) revert TokenNotSupported();
        if (rateE18 == 0) revert InvalidRate();
        tokenRateE18[token] = rateE18;
        emit TokenRateUpdated(token, rateE18);
    }

    function protocolName() external pure override returns (string memory) {
        return "Mock Lending";
    }

    function supply(address token, uint256 amount, address onBehalfOf) external override onlyHub returns (uint256 sharesReceived) {
        if (!supportedTokens[token]) revert TokenNotSupported();
        uint256 rate = tokenRateE18[token];
        if (rate == 0) rate = 1e18;

        sharesReceived = (amount * 1e18) / rate;
        MockERC20(tokenToShareToken[token]).mint(onBehalfOf, sharesReceived);
        totalUnderlyingByToken[token] += amount;
    }

    function withdraw(address token, uint256 shares, address to) external override onlyHub returns (uint256 amountWithdrawn) {
        if (!supportedTokens[token]) revert TokenNotSupported();
        uint256 rate = tokenRateE18[token];
        if (rate == 0) rate = 1e18;

        amountWithdrawn = (shares * rate) / 1e18;
        if (amountWithdrawn > totalUnderlyingByToken[token]) {
            amountWithdrawn = totalUnderlyingByToken[token];
        }
        totalUnderlyingByToken[token] -= amountWithdrawn;
        IERC20(token).safeTransfer(to, amountWithdrawn);
    }

    function getSharesValue(address token, uint256 shares) external view override returns (uint256 tokenAmount) {
        uint256 rate = tokenRateE18[token];
        if (rate == 0) rate = 1e18;
        return (shares * rate) / 1e18;
    }

    function getTotalShares(address token) external view override returns (uint256) {
        return totalUnderlyingByToken[token];
    }

    function getShareToken(address token) external view override returns (address) {
        return tokenToShareToken[token];
    }

    function isTokenSupported(address token) external view override returns (bool) {
        return supportedTokens[token];
    }

    function _safeDecimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 dec) {
            return dec;
        } catch {
            return 18;
        }
    }
}
