// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILendingAdapter {
    function protocolName() external view returns (string memory);
    function supply(address token, uint256 amount, address onBehalfOf) external returns (uint256 sharesReceived);
    function withdraw(address token, uint256 shares, address to) external returns (uint256 amountWithdrawn);
    function getSharesValue(address token, uint256 shares) external view returns (uint256 tokenAmount);
    function getTotalShares(address token) external view returns (uint256);
    function getShareToken(address token) external view returns (address);
    function isTokenSupported(address token) external view returns (bool);
}
