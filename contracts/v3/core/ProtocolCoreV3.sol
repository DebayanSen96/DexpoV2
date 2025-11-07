// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/ICoreAccessControl.sol";
import "../interfaces/IProtocolCore.sol";

contract ProtocolCoreV3 is IProtocolCoreV3, ICoreAccessControl, Ownable {
    struct FarmMeta { address owner; address vault; }

    // Global roles
    mapping(address => bool) public isExecutor; // can operate any vault
    mapping(address => bool) public isGuardian; // can pause/unpause and set per-vault policies

    // Global and per-vault pause
    bool public globalPaused;
    mapping(address => bool) public vaultPaused;

    // Per-vault operator allowlist
    mapping(address => mapping(address => bool)) public vaultOperator;

    // Per-vault target allowlist
    mapping(address => bool) public actionAllowlistEnabled;
    mapping(address => mapping(address => bool)) public actionTargetAllowed;

    // Per-vault TVL caps (0 = unlimited)
    mapping(address => uint256) public tvlCap;

    // Farm registry and analytics
    mapping(uint256 => FarmMeta) public farmById;
    mapping(uint256 => uint256) public protocolFeesByFarm;

    // Verifier registry (lightweight)
    mapping(uint256 => mapping(address => bool)) private approvedVerifier;
    mapping(uint256 => address[]) private approvedVerifiersList;

    // Rules with sane defaults; owner can update
    FarmRules private rules = FarmRules({
        minLpBps: 6000,
        maxOwnerBps: 3000,
        maxVerifierBps: 1000,
        maxTransferFeeBps: 2000,
        maxProtocolRakeBps: 2000,
        maxEarlyExitBps: 1000,
        maxLockupSeconds: 365 days,
        maxNoExitLockupSeconds: 180 days,
        minEpochSeconds: 1 days,
        maxEpochSeconds: 30 days
    });

    // Events
    event ExecutorSet(address indexed account, bool allowed);
    event GuardianSet(address indexed account, bool allowed);
    event VaultOperatorSet(address indexed vault, address indexed operator, bool allowed);
    event GlobalPaused(bool paused);
    event VaultPaused(address indexed vault, bool paused);
    event ActionAllowlistEnabled(address indexed vault, bool enabled);
    event ActionTargetSet(address indexed vault, address indexed target, bool allowed);
    event FarmRegistered(uint256 indexed farmId, address indexed owner, address indexed vault);
    event ProtocolFeeReported(uint256 indexed farmId, uint256 amount);
    event FarmRulesUpdated();

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ICoreAccessControl
    function canOperate(address vault, address caller) external view override returns (bool) {
        return caller == owner() || isExecutor[caller] || vaultOperator[vault][caller];
    }
    function isGlobalPaused() external view override returns (bool) { return globalPaused; }
    function isVaultPaused(address vault) external view override returns (bool) { return vaultPaused[vault]; }
    function isActionAllowed(address vault, address target) external view override returns (bool) {
        if (!actionAllowlistEnabled[vault]) return true;
        return actionTargetAllowed[vault][target];
    }
    function tvlCapOf(address vault) external view override returns (uint256) { return tvlCap[vault]; }

    // Role management
    function setExecutor(address account, bool allowed) external onlyOwner {
        isExecutor[account] = allowed;
        emit ExecutorSet(account, allowed);
    }
    function setGuardian(address account, bool allowed) external onlyOwner {
        isGuardian[account] = allowed;
        emit GuardianSet(account, allowed);
    }

    // Per-vault operator and action allowlist
    function setVaultOperator(address vault, address operator, bool allowed) external {
        require(msg.sender == owner() || isGuardian[msg.sender], "NotAuth");
        vaultOperator[vault][operator] = allowed;
        emit VaultOperatorSet(vault, operator, allowed);
    }
    function setActionAllowlist(address vault, bool enabled) external {
        require(msg.sender == owner() || isGuardian[msg.sender], "NotAuth");
        actionAllowlistEnabled[vault] = enabled;
        emit ActionAllowlistEnabled(vault, enabled);
    }
    function setActionTarget(address vault, address target, bool allowed) external {
        require(msg.sender == owner() || isGuardian[msg.sender], "NotAuth");
        actionTargetAllowed[vault][target] = allowed;
        emit ActionTargetSet(vault, target, allowed);
    }

    function setTvlCap(address vault, uint256 cap) external {
        require(msg.sender == owner() || isGuardian[msg.sender], "NotAuth");
        tvlCap[vault] = cap;
    }

    // Pause controls
    function pauseAll(bool paused) external {
        require(isGuardian[msg.sender] || msg.sender == owner(), "NotAuth");
        globalPaused = paused;
        emit GlobalPaused(paused);
    }
    function pauseVault(address vault, bool paused) external {
        require(isGuardian[msg.sender] || msg.sender == owner(), "NotAuth");
        vaultPaused[vault] = paused;
        emit VaultPaused(vault, paused);
    }

    // IProtocolCoreV3 compatibility
    function getApprovedVerifiers(uint256 farmId) external view override returns (address[] memory) {
        return approvedVerifiersList[farmId];
    }
    function isApprovedVerifier(uint256 farmId, address who) external view override returns (bool) {
        return approvedVerifier[farmId][who];
    }

    function getFarmRules() external view override returns (FarmRules memory) { return rules; }
    function setFarmRules(FarmRules calldata r) external onlyOwner {
        rules = r;
        emit FarmRulesUpdated();
    }
    function setApprovedVerifier(uint256 farmId, address verifier, bool allowed) external onlyOwner {
        if (approvedVerifier[farmId][verifier] == allowed) return;
        approvedVerifier[farmId][verifier] = allowed;
        if (allowed) {
            approvedVerifiersList[farmId].push(verifier);
        } else {
            // lazy delete on view
        }
    }

    function assertFarmConfigValid(
        uint16 lpBps,
        uint16 ownerBps,
        uint16 verifierBps,
        bool lockEnabled,
        bool allowEarlyExit,
        uint16 earlyExitBps,
        uint64 lockupSeconds,
        uint8 /*postLockMode*/,
        uint8 /*payoutMode*/,
        uint16 /*streamBps*/,
        uint16 /*compoundBps*/,
        uint64 epoch,
        uint64 minHarvestInterval,
        bool /*compoundLpOnLock*/,
        bool /*shareTransferable*/,
        uint16 shareTransferFeeBps,
        uint16 protocolRakeBps
    ) external view override {
        FarmRules memory r = rules;
        require(lpBps >= r.minLpBps, "LP too low");
        require(ownerBps <= r.maxOwnerBps, "Owner too high");
        require(verifierBps <= r.maxVerifierBps, "Verifier too high");
        require(shareTransferFeeBps <= r.maxTransferFeeBps, "Fee too high");
        require(protocolRakeBps <= r.maxProtocolRakeBps, "Rake too high");
        if (lockEnabled) {
            if (!allowEarlyExit) require(lockupSeconds <= r.maxNoExitLockupSeconds, "Lock too long");
            else require(lockupSeconds <= r.maxLockupSeconds, "Lock too long");
        }
        require(epoch >= r.minEpochSeconds && epoch <= r.maxEpochSeconds, "Epoch out of range");
        require(minHarvestInterval <= r.maxEpochSeconds, "Harvest too long");
    }

    function registerFarm(address owner_, address farm, uint256 farmId) external override {
        farmById[farmId] = FarmMeta({owner: owner_, vault: farm});
        emit FarmRegistered(farmId, owner_, farm);
    }

    function reportProtocolFee(uint256 farmId, uint256 amount) external override {
        protocolFeesByFarm[farmId] += amount;
        emit ProtocolFeeReported(farmId, amount);
    }
}
