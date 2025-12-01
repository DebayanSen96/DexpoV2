// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IProtocolCoreOwnable {
    function owner() external view returns (address);
    function isGlobalPaused() external view returns (bool);
    function isVaultPaused(address vault) external view returns (bool);
}
