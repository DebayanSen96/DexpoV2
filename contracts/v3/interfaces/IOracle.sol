// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOracle {
    function priceUsdE18(address token) external view returns (uint256);
    function getPrice(address token) external view returns (uint256 price, uint8 decimals);
}
