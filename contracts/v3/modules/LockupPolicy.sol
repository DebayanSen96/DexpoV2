// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/ILockupPolicy.sol";

contract LockupPolicy is ILockupPolicy, Ownable {
    LockConfig private _cfg;

    struct Lock { uint64 start; uint64 end; }
    mapping(address => Lock) private _locks;

    event LockConfigSet(LockConfig cfg);

    constructor(LockConfig memory cfg_) Ownable(msg.sender) { _cfg = cfg_; }

    function setLockConfig(LockConfig calldata cfg) external override onlyOwner {
        _cfg = cfg;
        emit LockConfigSet(cfg);
    }

    function getLockConfig() external view override returns (LockConfig memory) {
        return _cfg;
    }

    function onDeposit(address account, uint256 /*assets*/) external override {
        if (!_cfg.enabled) return;
        uint64 start = uint64(block.timestamp);
        _locks[account] = Lock({ start: start, end: start + _cfg.lockupSeconds });
    }

    function enforceWithdrawal(address account, uint256 assets) external override returns (uint256 penalty) {
        if (!_cfg.enabled) return 0;
        Lock memory L = _locks[account];
        if (L.end == 0 || block.timestamp >= L.end) return 0;
        if (!_cfg.allowEarlyExit) revert("Locked");
        penalty = (assets * _cfg.earlyExitBps) / 10_000;
    }

    function lockInfo(address account) external view override returns (uint64 start, uint64 end, bool locked) {
        Lock memory L = _locks[account];
        start = L.start; end = L.end; locked = (L.end != 0 && block.timestamp < L.end);
    }
}
