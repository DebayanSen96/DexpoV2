// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract UsdPricerMock {
    // price in 1e18 USD units per 1 token unit (token decimals aware via off-chain convention)
    mapping(address => uint256) public priceUsdE18Of;
    address public owner;

    event OwnerSet(address indexed owner);
    event PriceSet(address indexed token, uint256 priceE18);

    constructor(address owner_) { owner = owner_; emit OwnerSet(owner_); }

    modifier onlyOwner() { require(msg.sender == owner, "NotOwner"); _; }

    function setOwner(address o) external onlyOwner { owner = o; emit OwnerSet(o); }

    function setPrice(address token, uint256 priceE18) external onlyOwner {
        priceUsdE18Of[token] = priceE18;
        emit PriceSet(token, priceE18);
    }

    function priceUsdE18(address token) external view returns (uint256) {
        return priceUsdE18Of[token];
    }
}
