// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPayoutPolicy {
    enum Mode { Stream, Lockup }

    struct Config {
        Mode mode;
        uint16 streamBps;      // portion streamed (for LP in Stream mode)
        uint16 compoundBps;    // portion compounded (for LP in Stream mode)
        uint64 epoch;          // streaming epoch duration
        uint64 minHarvestInterval;
        bool compoundLpOnLock; // if Lockup mode, whether LP portion compounds
    }

    function setConfig(Config calldata cfg) external;
    function getConfig() external view returns (Config memory);

    // Called by vault on harvest; returns streamed and compounded portions of netBase (in base asset units)
    function onHarvest(uint256 netBase) external returns (uint256 streamed, uint256 compounded);

    // Claim streaming rewards for msg.sender or specified beneficiary
    function claimable(address account) external view returns (uint256);
    function claim(address to) external returns (uint256 amount);

    // Accrue streamed rewards for a beneficiary over current epoch (only vault)
    function accrueFor(address beneficiary, uint256 amount) external;

    function lastHarvestAt() external view returns (uint256);
}
