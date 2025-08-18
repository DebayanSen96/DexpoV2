// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IFarmFactory.sol";
import "../interfaces/IProtocolCore.sol";
import "../strategies/StrategyRouter.sol";
import "../modules/LockupPolicy.sol";
import "../modules/PayoutPolicy.sol";
import "../modules/StakeholderRegistry.sol";
import "../farm/BaseFarm.sol";
import "../interfaces/IShareToken.sol";

/**
 * @title FarmFactory (v3)
 * @notice Deploys and wires a complete Dexponent v3 farm stack. Restricted to ProtocolCore.
 */
contract FarmFactory is IFarmFactory, Ownable {
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

    function createFarmStack(
        address asset,
        string calldata farmName,
        string calldata farmSymbol,
        address core,
        uint256 farmId,
        address owner,
        address ownerRecipient,
        uint16 lpBps,
        uint16 ownerBps,
        uint16 verifierBps,
        LockConfig calldata lockCfg,
        PayoutConfig calldata payoutCfg,
        ShareTokenConfig calldata stCfg,
        bytes32[] calldata adapterKeys,
        address[] calldata adapterAddrs,
        uint16[] calldata adapterBps
    ) external onlyCore returns (FarmAddresses memory addrs) {
        // Enforce ProtocolCore farm rules prior to any deployment work
        IProtocolCoreV3(core).assertFarmConfigValid(
            lpBps,
            ownerBps,
            verifierBps,
            lockCfg.enabled,
            lockCfg.allowEarlyExit,
            lockCfg.earlyExitBps,
            uint64(lockCfg.lockupSeconds),
            lockCfg.postLockMode,
            payoutCfg.mode,
            payoutCfg.streamBps,
            payoutCfg.compoundBps,
            uint64(payoutCfg.epoch),
            uint64(payoutCfg.minHarvestInterval),
            payoutCfg.compoundLpOnLock,
            stCfg.transferable,
            stCfg.transferFeeBps,
            stCfg.protocolRakeBps
        );
        // 1) Deploy components (factory temporarily owns them)
        StrategyRouter router = new StrategyRouter(asset, core);
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
        BaseFarm farm = new BaseFarm(asset, farmName, farmSymbol, core);

        // 2) Wire modules
        farm.setStrategyRouter(address(router));
        farm.setPayoutPolicy(address(payout));
        // @ts-ignore
        payout.setFarm(address(farm));
        farm.setLockupPolicy(address(lockup));
        farm.setStakeholderRegistry(address(registry));
        // Authorize farm on router for ops
        router.setFarm(address(farm));

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

        // 5) Configure ShareToken atomically while factory is owner, then transfer ownership
        IShareToken st = farm.shareToken();
        // Apply config (owner-only)
        st.setTransferable(stCfg.transferable);
        st.setTransferFeeBps(stCfg.transferFeeBps);
        if (stCfg.feeReceiver != address(0)) {
            st.setFeeReceiver(stCfg.feeReceiver);
        }
        if (stCfg.protocolFeeReceiver != address(0) || stCfg.protocolRakeBps != 0) {
            st.setProtocolFee(stCfg.protocolFeeReceiver, stCfg.protocolRakeBps);
        }
        // Transfer ownership of ShareToken to the farm owner
        // Cast to Ownable to access transferOwnership (not exposed on IShareToken)
        Ownable(address(st)).transferOwnership(owner);

        // 6) Hand ownership of all modules to owner
        router.transferOwnership(owner);
        lockup.transferOwnership(owner);
        payout.transferOwnership(owner);
        registry.transferOwnership(owner);
        farm.transferOwnership(owner);

        addrs = FarmAddresses({
            baseFarm: address(farm),
            router: address(router),
            payoutPolicy: address(payout),
            lockupPolicy: address(lockup),
            stakeholderRegistry: address(registry)
        });
    }
}
