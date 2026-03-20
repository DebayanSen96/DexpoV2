// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IProtocolCoreV3 {
    // Views used by modules
    function getApprovedVerifiers(uint256 farmId) external view returns (address[] memory);
    function isApprovedVerifier(uint256 farmId, address who) external view returns (bool);

    // Protocol-wide farm rules caps
    struct FarmRules {
        uint16 minLpBps;              // e.g., >= 6000
        uint16 maxOwnerBps;           // e.g., <= 3000
        uint16 maxVerifierBps;        // e.g., <= 1000
        uint16 maxTransferFeeBps;     // e.g., <= 2000
        uint16 maxProtocolRakeBps;    // e.g., <= 2000
        uint16 maxEarlyExitBps;       // e.g., <= 1000
        uint64 maxLockupSeconds;      // absolute upper bound for lockups (with exit)
        uint64 maxNoExitLockupSeconds;// stricter bound when early exit is disabled
        uint64 minEpochSeconds;       // payout epoch lower bound
        uint64 maxEpochSeconds;       // payout epoch upper bound
    }

    function getFarmRules() external view returns (FarmRules memory);

    // Validates requested farm config against protocol rules; reverts on violation
    function assertFarmConfigValid(
        uint16 lpBps,
        uint16 ownerBps,
        uint16 verifierBps,
        bool lockEnabled,
        bool allowEarlyExit,
        uint16 earlyExitBps,
        uint64 lockupSeconds,
        uint8 postLockMode,
        uint8 payoutMode,
        uint16 streamBps,
        uint16 compoundBps,
        uint64 epoch,
        uint64 minHarvestInterval,
        bool compoundLpOnLock,
        bool shareTransferable,
        uint16 shareTransferFeeBps,
        uint16 protocolRakeBps
    ) external view;

    // Farm lifecycle & reporting hooks
    function registerFarm(address owner, address farm, uint256 farmId) external;
    function reportProtocolFee(uint256 farmId, uint256 amount) external;
}
