// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IWhitelistRegistry.sol";

contract WhitelistRegistry is IWhitelistRegistryV3, Ownable {
    // token => allowed
    mapping(address => bool) public tokenAllowed;
    // adapter => allowed
    mapping(address => bool) public adapterAllowed;
    // keccak256(swapRouter, quoter) => allowed
    mapping(bytes32 => bool) public dexApproved;
    // keccak256(base, token, fee, swapRouter) => allowed
    mapping(bytes32 => bool) public poolAllowed;

    constructor(address owner_) Ownable(owner_) {}

    // Views
    function isTokenWhitelisted(address token) external view override returns (bool) {
        return tokenAllowed[token];
    }
    function isAdapterWhitelisted(address adapter) external view override returns (bool) {
        return adapterAllowed[adapter];
    }
    function isDexApproved(address swapRouter, address quoter) external view override returns (bool) {
        return dexApproved[keccak256(abi.encodePacked(swapRouter, quoter))];
    }
    function isPoolAllowed(address base, address token, uint24 fee, address swapRouter) external view override returns (bool) {
        return poolAllowed[keccak256(abi.encodePacked(base, token, fee, swapRouter))];
    }

    // Admin setters (only protocol owner)
    function setTokenWhitelist(address token, bool allowed) external override onlyOwner {
        tokenAllowed[token] = allowed;
    }
    function setAdapterWhitelist(address adapter, bool allowed) external override onlyOwner {
        adapterAllowed[adapter] = allowed;
    }
    function setDexApproved(address swapRouter, address quoter, bool allowed) external override onlyOwner {
        dexApproved[keccak256(abi.encodePacked(swapRouter, quoter))] = allowed;
    }
    function setPoolAllowed(address base, address token, uint24 fee, address swapRouter, bool allowed) external override onlyOwner {
        poolAllowed[keccak256(abi.encodePacked(base, token, fee, swapRouter))] = allowed;
    }
}
