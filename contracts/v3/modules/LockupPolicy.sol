// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/ILockupPolicy.sol";

/**
 * @title LockupPolicy (v3)
 * @notice Records per-account lock windows and enforces early-exit penalties.
 */
contract LockupPolicy is ILockupPolicy, Ownable {
    LockConfig private _cfg;

    struct Lock { uint64 start; uint64 end; }
    mapping(address => Lock) private _locks;

    event LockConfigSet(LockConfig cfg);

    /// @notice Parameterless constructor to satisfy Ownable base. Not used by clones.
    constructor() Ownable(msg.sender) {}

    bool private _initialized;

    /// @notice Initialize with the provided lock configuration and set owner.
    /// @param cfg_ Initial lock configuration.
    /// @param initialOwner Owner to assign for admin functions.
    function initialize(LockConfig memory cfg_, address initialOwner) external {
        require(!_initialized, "Init");
        require(initialOwner != address(0), "Zero");
        _cfg = cfg_;
        _transferOwnership(initialOwner);
        _initialized = true;
    }

    /// @notice Update the lock configuration.
    /// @param cfg New lock configuration.
    function setLockConfig(LockConfig calldata cfg) external override onlyOwner {
        _cfg = cfg;
        emit LockConfigSet(cfg);
    }

    /// @notice Get the current lock configuration.
    function getLockConfig() external view override returns (LockConfig memory) {
        return _cfg;
    }

    /// @notice Start/refresh the lock window on deposit if lockup is enabled.
    /// @param account Beneficiary whose lock window is affected.
    /// @param /*assets*/ Unused in this implementation.
    function onDeposit(address account, uint256 /*assets*/) external override {
        if (!_cfg.enabled) return;
        uint64 start = uint64(block.timestamp);
        _locks[account] = Lock({ start: start, end: start + _cfg.lockupSeconds });
    }

    /// @notice Enforce early-exit penalty if within lock window and allowed.
    /// @param account Beneficiary requesting withdrawal.
    /// @param assets Withdrawal amount in base units.
    /// @return penalty Penalty amount in base units (0 if not locked or after expiry).
    function enforceWithdrawal(address account, uint256 assets) external override returns (uint256 penalty) {
        if (!_cfg.enabled) return 0;
        Lock memory L = _locks[account];
        if (L.end == 0 || block.timestamp >= L.end) return 0;
        if (!_cfg.allowEarlyExit) revert("Locked");
        penalty = (assets * _cfg.earlyExitBps) / 10_000;
    }

    /// @notice Return lock window for an account.
    /// @param account Beneficiary address.
    /// @return start Lock start timestamp.
    /// @return end Lock end timestamp.
    /// @return locked True if currently before end.
    function lockInfo(address account) external view override returns (uint64 start, uint64 end, bool locked) {
        Lock memory L = _locks[account];
        start = L.start; end = L.end; locked = (L.end != 0 && block.timestamp < L.end);
    }
}
