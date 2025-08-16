// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IVaultFactory.sol";
import "../strategies/StrategyRouter.sol";
import "../modules/LockupPolicy.sol";
import "../modules/PayoutPolicy.sol";
import "../modules/StakeholderRegistry.sol";
import "../vault/BaseVault.sol";
import "../interfaces/IShareToken.sol";

/**
 * @title VaultFactory (v3)
 * @notice Deploys and wires a complete Dexponent v3 vault stack. Restricted to ProtocolCore.
 */
contract VaultFactory is IVaultFactory, Ownable {
    address public immutable protocolCore;

    error NotCore();

    modifier onlyCore() {
        if (msg.sender != protocolCore) revert NotCore();
        _;
    }

    constructor(address core) Ownable(msg.sender) {
        require(core != address(0), "CoreZero");
        protocolCore = core;
    }

    function createVaultStack(
        address asset,
        string calldata vaultName,
        string calldata vaultSymbol,
        address core,
        uint256 farmId,
        address owner,
        address ownerRecipient,
        uint16 lpBps,
        uint16 ownerBps,
        uint16 verifierBps,
        LockConfig calldata lockCfg,
        PayoutConfig calldata payoutCfg,
        bytes32[] calldata adapterKeys,
        address[] calldata adapterAddrs,
        uint16[] calldata adapterBps
    ) external onlyCore returns (VaultAddresses memory addrs) {
        // 1) Deploy components (factory temporarily owns them)
        StrategyRouter router = new StrategyRouter(asset);
        LockupPolicy lockup = new LockupPolicy(
            ILockupPolicy.LockConfig({
                enabled: lockCfg.enabled,
                allowEarlyExit: lockCfg.allowEarlyExit,
                earlyExitBps: lockCfg.earlyExitBps,
                lockupSeconds: uint64(lockCfg.lockupSeconds),
                postLockMode: lockCfg.postLockMode
            })
        );
        PayoutPolicy payout = new PayoutPolicy(
            asset,
            IPayoutPolicy.Config({
                mode: IPayoutPolicy.Mode(payoutCfg.mode),
                streamBps: payoutCfg.streamBps,
                compoundBps: payoutCfg.compoundBps,
                epoch: uint64(payoutCfg.epoch),
                minHarvestInterval: uint64(payoutCfg.minHarvestInterval),
                compoundLpOnLock: payoutCfg.compoundLpOnLock
            })
        );
        StakeholderRegistry registry = new StakeholderRegistry(core, farmId);
        BaseVault vault = new BaseVault(asset, vaultName, vaultSymbol);

        // 2) Wire modules
        vault.setStrategyRouter(address(router));
        vault.setPayoutPolicy(address(payout));
        payout.setVault(address(vault));
        vault.setLockupPolicy(address(lockup));
        vault.setStakeholderRegistry(address(registry));

        // 3) Configure registry splits and recipient
        registry.setSplits(lpBps, ownerBps, verifierBps);
        if (ownerRecipient != address(0)) {
            registry.setOwnerRecipient(ownerRecipient);
        }

        // 4) Optional allocations
        if (adapterKeys.length > 0) {
            require(
                adapterKeys.length == adapterAddrs.length && adapterKeys.length == adapterBps.length,
                "LenMismatch"
            );
            router.setAllocations(adapterKeys, adapterAddrs, adapterBps);
        }

        // 5) Transfer ShareToken ownership to the designated owner
        IShareToken st = vault.shareToken();
        // Factory currently owns ShareToken because BaseVault ctor set owner=msg.sender
        // Cast to Ownable to access transferOwnership (not exposed on IShareToken)
        Ownable(address(st)).transferOwnership(owner);

        // 6) Hand ownership of all modules to owner
        router.transferOwnership(owner);
        lockup.transferOwnership(owner);
        payout.transferOwnership(owner);
        registry.transferOwnership(owner);
        vault.transferOwnership(owner);

        addrs = VaultAddresses({
            baseVault: address(vault),
            router: address(router),
            payoutPolicy: address(payout),
            lockupPolicy: address(lockup),
            stakeholderRegistry: address(registry)
        });
    }
}
