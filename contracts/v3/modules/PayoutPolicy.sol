// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IPayoutPolicy.sol";

/**
 * @title PayoutPolicy (v3)
 * @notice Minimal streaming/lockup policy placeholder.
 *         - Stores config and lastHarvestAt.
 *         - onHarvest computes streamed/compounded portions only.
 *         - Claim accounting will be wired by the vault in a later step.
 */
contract PayoutPolicy is IPayoutPolicy, Ownable {
    Config private _cfg;
    uint256 public override lastHarvestAt;

    event ConfigSet(Config cfg);

    constructor(Config memory cfg_) { _cfg = cfg_; }

    function setConfig(Config calldata cfg) external override onlyOwner {
        _cfg = cfg;
        emit ConfigSet(cfg);
    }

    function getConfig() external view override returns (Config memory) {
        return _cfg;
    }

    function onHarvest(uint256 netBase) external override returns (uint256 streamed, uint256 compounded) {
        lastHarvestAt = block.timestamp;
        if (netBase == 0) return (0, 0);

        if (_cfg.mode == Mode.Stream) {
            streamed = (netBase * _cfg.streamBps) / 10_000;
            compounded = netBase - streamed; // compoundBps assumed complementary for MVP
        } else {
            // Lockup mode: LP portion behavior determined by vault; default to compound if enabled
            if (_cfg.compoundLpOnLock) {
                streamed = 0;
                compounded = netBase;
            } else {
                // no compounding: treat as streamed to escrow (vault will hold)
                streamed = netBase;
                compounded = 0;
            }
        }
    }

    function claimable(address) external pure override returns (uint256) {
        // Vault will track claim buckets in MVP; policy remains stateless for claims
        return 0;
    }

    function claim(address) external pure override returns (uint256 amount) {
        // No-op for MVP; vault to implement distribution path later
        return 0;
    }
}
