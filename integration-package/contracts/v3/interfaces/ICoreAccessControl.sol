// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICoreAccessControl {
    function canOperate(address vault, address caller) external view returns (bool);
    function isGlobalPaused() external view returns (bool);
    function isVaultPaused(address vault) external view returns (bool);
    function isActionAllowed(address vault, address target) external view returns (bool);
    function tvlCapOf(address vault) external view returns (uint256);
}
