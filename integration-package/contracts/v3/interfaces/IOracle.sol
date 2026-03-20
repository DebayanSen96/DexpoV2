// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOracle {
    function priceUsdE18(address token) external view returns (uint256);
    function getPrice(address token) external view returns (uint256 price, uint8 decimals);
}

interface IOracleExtended is IOracle {
    function hasPriceFeed(address token) external view returns (bool);
    function getOracleSource(address token) external view returns (string memory);
}
