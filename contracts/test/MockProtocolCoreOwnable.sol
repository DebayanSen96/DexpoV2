// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockProtocolCoreOwnable {
    address public owner;
    bool public globalPaused;
    mapping(address => bool) public vaultPaused;

    constructor(address _owner) {
        owner = _owner;
    }

    function isGlobalPaused() external view returns (bool) {
        return globalPaused;
    }

    function isVaultPaused(address vault) external view returns (bool) {
        return vaultPaused[vault];
    }
}
