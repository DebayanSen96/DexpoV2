// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IOracle.sol";

contract MockOracle is IOracle {
    mapping(address => uint256) public prices;

    function setPrice(address token, uint256 price) external {
        prices[token] = price;
    }

    function priceUsdE18(address token) external view override returns (uint256) {
        return prices[token];
    }

    function getPrice(address token) external view override returns (uint256 price, uint8 decimals) {
        return (prices[token], 18);
    }
}
