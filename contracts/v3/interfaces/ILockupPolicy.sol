// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILockupPolicy {
    struct LockConfig {
        bool enabled;
        bool allowEarlyExit;
        uint16 earlyExitBps;   // penalty on assets withdrawn early
        uint64 lockupSeconds;
        uint8 postLockMode;    // 0 = free, 1 = keep compounding until withdraw
    }

    function setLockConfig(LockConfig calldata cfg) external;
    function getLockConfig() external view returns (LockConfig memory);

    function onDeposit(address account, uint256 assets) external;
    // Returns penalty (in assets) to charge; vault will route per farm rules
    function enforceWithdrawal(address account, uint256 assets) external returns (uint256 penalty);

    function lockInfo(address account) external view returns (uint64 start, uint64 end, bool locked);
}
