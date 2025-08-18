// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPayoutPolicy.sol";

/**
 * @title PayoutPolicy (v3)
 * @notice Streaming/lockup policy with custody of base asset for streamed rewards.
 *         - Stores config and lastHarvestAt.
 *         - onHarvest computes streamed/compounded portions only.
 *         - accrueFor() records per-beneficiary linear streams over epoch duration.
 *         - claim() allows beneficiaries to withdraw vested and unlocked amounts.
 */
contract PayoutPolicy is IPayoutPolicy, Ownable {
    using SafeERC20 for IERC20;

    struct Stream {
        uint128 total;    // total amount scheduled in current stream window
        uint128 claimed;  // amount already claimed from current window
        uint64 start;     // stream start
        uint64 end;       // stream end (start + epoch)
    }

    Config private _cfg;
    uint256 public override lastHarvestAt;

    // Custodied base asset and authorized farm that can accrue streams
    address public immutable asset;
    address public farm;

    mapping(address => Stream) private _stream;
    mapping(address => uint256) private _unlocked; // instantly claimable bucket

    event ConfigSet(Config cfg);
    event FarmSet(address indexed farm);
    event Accrued(address indexed beneficiary, uint256 amount, uint64 start, uint64 end);
    event Claimed(address indexed beneficiary, address indexed to, uint256 amount);

    modifier onlyFarm() {
        require(msg.sender == farm, "NotFarm");
        _;
    }

    constructor(address asset_, Config memory cfg_) Ownable(msg.sender) {
        require(asset_ != address(0), "AssetZero");
        asset = asset_;
        _cfg = cfg_;
    }

    function setFarm(address farm_) external onlyOwner {
        require(farm_ != address(0), "FarmZero");
        farm = farm_;
        emit FarmSet(farm_);
    }

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
            if (_cfg.compoundLpOnLock) {
                streamed = 0;
                compounded = netBase;
            } else {
                streamed = netBase;
                compounded = 0;
            }
        }
    }

    // Accrue a new streamed amount for a beneficiary over the configured epoch.
    // Assumes the asset tokens have already been transferred to this contract.
    function accrueFor(address beneficiary, uint256 amount) external onlyFarm {
        if (amount == 0) return;
        Stream storage s = _stream[beneficiary];
        uint64 nowTs = uint64(block.timestamp);

        // settle vested portion so far into unlocked
        uint256 vested = _vestedAmount(s, nowTs);
        if (vested > 0) {
            s.claimed += uint128(vested);
            _unlocked[beneficiary] += vested;
        }

        // remaining unvested from previous window becomes part of new stream
        uint256 remaining = uint256(s.total) - uint256(s.claimed);
        uint256 newTotal = remaining + amount;
        s.total = uint128(newTotal);
        s.claimed = 0;
        s.start = nowTs;
        s.end = nowTs + _cfg.epoch;

        emit Accrued(beneficiary, amount, s.start, s.end);
    }

    function claimable(address account) public view override returns (uint256) {
        Stream memory s = _stream[account];
        uint256 vested = _vestedAmount(s, uint64(block.timestamp));
        return _unlocked[account] + vested;
    }

    function claim(address to) external override returns (uint256 amount) {
        address account = msg.sender;
        Stream storage s = _stream[account];
        uint64 nowTs = uint64(block.timestamp);
        uint256 vested = _vestedAmount(s, nowTs);
        if (vested > 0) {
            s.claimed += uint128(vested);
        }
        amount = _unlocked[account] + vested;
        if (amount == 0) return 0;
        _unlocked[account] = 0;
        IERC20(asset).safeTransfer(to, amount);
        emit Claimed(account, to, amount);
    }

    function _vestedAmount(Stream memory s, uint64 nowTs) internal pure returns (uint256) {
        if (s.total == 0 || nowTs <= s.start) return 0;
        if (nowTs >= s.end) return uint256(s.total) - uint256(s.claimed);
        uint256 duration = uint256(s.end) - uint256(s.start);
        uint256 elapsed = uint256(nowTs) - uint256(s.start);
        uint256 vestedTotal = (uint256(s.total) * elapsed) / duration;
        if (vestedTotal <= s.claimed) return 0;
        return vestedTotal - s.claimed;
    }
}
