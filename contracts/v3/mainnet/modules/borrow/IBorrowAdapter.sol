// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBorrowAdapter {
    function protocolName() external view returns (string memory);

    function borrow(address token, uint256 amount, address onBehalfOf) external returns (uint256 debtIssued);
    function repay(address token, uint256 amount, address onBehalfOf) external returns (uint256 debtRepaid);

    function getDebtValue(address vault, address token) external view returns (uint256 tokenAmount);
    function getTotalDebt(address token) external view returns (uint256);
    function getVaultDebt(address vault, address token) external view returns (uint256);
    function isTokenSupported(address token) external view returns (bool);
    function getMaxLtvBps(address token) external view returns (uint16);
    function getBorrowCap(address token) external view returns (uint256);
}

