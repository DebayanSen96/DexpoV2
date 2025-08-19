// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IFarmFactory.sol";
import "../interfaces/IProtocolCore.sol";
import "../strategies/StrategyRouter.sol";
import "../modules/LockupPolicy.sol";
import "../modules/PayoutPolicy.sol";
import "../modules/StakeholderRegistry.sol";
import "../farm/BaseFarm.sol";
import "../interfaces/IShareToken.sol";
import "../interfaces/IPayoutPolicy.sol";

/**
 * @title FarmFactory (v3)
 * @notice Deploys and wires a complete Dexponent v3 farm stack. Restricted to ProtocolCore.
 */
contract FarmFactory is IFarmFactory, Ownable {
    address public immutable protocolCore;

    // Implementation addresses for minimal proxy clones
    address public baseFarmImpl;
    address public routerImpl;
    address public lockupImpl;
    address public payoutImpl;
    address public registryImpl;

    event ImplementationsSet(address baseFarm, address router, address payout, address lockup, address registry);

    // Lightweight registry for discovery: which farms were deployed for which owner
    mapping(address => address[]) public farmsByOwner; // owner => list of baseFarm addresses
    mapping(address => address) public ownerByFarm;    // baseFarm => owner

    error NotCore();

    modifier onlyCore() {
        if (msg.sender != protocolCore) revert NotCore();
        _;
    }

    /// @notice Initialize the factory bound to a specific `ProtocolCore`.
    /// @param core Address of the ProtocolCore that is authorized to call this factory.
    constructor(address core) Ownable(msg.sender) {
        require(core != address(0), "CoreZero");
        protocolCore = core;
    }

    /// @notice Set implementation addresses used for clones.
    function setImplementations(
        address baseFarm_,
        address router_,
        address payout_,
        address lockup_,
        address registry_
    ) external onlyOwner {
        require(baseFarm_ != address(0) && router_ != address(0) && payout_ != address(0) && lockup_ != address(0) && registry_ != address(0), "ZeroImpl");
        baseFarmImpl = baseFarm_;
        routerImpl = router_;
        payoutImpl = payout_;
        lockupImpl = lockup_;
        registryImpl = registry_;
        emit ImplementationsSet(baseFarm_, router_, payout_, lockup_, registry_);
    }

    /**
     * @notice Deploy and wire a complete v3 farm stack (BaseFarm, Router, Policies, Registry, ShareToken).
     * @dev Callable only by ProtocolCore. Validates configuration against core rules.
     * @param asset           ERC20 asset used as principal for the farm.
     * @param farmName        Name for the ShareToken.
     * @param farmSymbol      Symbol for the ShareToken.
     * @param core            ProtocolCore address (used for callbacks and permissions).
     * @param farmId          Canonical farm id assigned by the core.
     * @param owner           Farm owner address (will receive ownership of deployed modules).
     * @param ownerRecipient  Optional recipient address for the owner's fee share.
     * @param lpBps           LP split in basis points.
     * @param ownerBps        Owner split in basis points.
     * @param verifierBps     Verifier split in basis points.
     * @param lockCfg         Lockup module configuration.
     * @param payoutCfg       Payout module configuration.
     * @param stCfg           ShareToken configuration (transferability, fees).
     * @param adapterKeys     Strategy adapter keys.
     * @param adapterAddrs    Strategy adapter addresses.
     * @param adapterBps      Strategy adapter allocation bps.
     * @return addrs Struct of deployed module addresses.
     */
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
        // 1) Deploy components as minimal proxies and initialize (factory temporarily owns them)
        require(baseFarmImpl != address(0) && routerImpl != address(0) && payoutImpl != address(0) && lockupImpl != address(0) && registryImpl != address(0), "ImplsUnset");

        StrategyRouter router = StrategyRouter(Clones.clone(routerImpl));
        router.initialize(asset, core, address(this));

        LockupPolicy lockup = LockupPolicy(Clones.clone(lockupImpl));
        lockup.initialize(
            ILockupPolicy.LockConfig({
                enabled: lockCfg.enabled,
                allowEarlyExit: lockCfg.allowEarlyExit,
                earlyExitBps: lockCfg.earlyExitBps,
                lockupSeconds: uint64(lockCfg.lockupSeconds),
                postLockMode: lockCfg.postLockMode
            }),
            address(this)
        );

        PayoutPolicy payout = PayoutPolicy(Clones.clone(payoutImpl));
        payout.initialize(
            asset,
            IPayoutPolicy.Config({
                mode: IPayoutPolicy.Mode(payoutCfg.mode),
                streamBps: payoutCfg.streamBps,
                compoundBps: payoutCfg.compoundBps,
                epoch: uint64(payoutCfg.epoch),
                minHarvestInterval: uint64(payoutCfg.minHarvestInterval),
                compoundLpOnLock: payoutCfg.compoundLpOnLock
            }),
            address(this)
        );

        StakeholderRegistry registry = StakeholderRegistry(Clones.clone(registryImpl));
        registry.initialize(core, farmId, address(this));

        BaseFarm farm = BaseFarm(Clones.clone(baseFarmImpl));
        farm.initialize(asset, farmName, farmSymbol, core, farmId, address(this));

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

        // 6) Register with ProtocolCore and hand ownership of all modules to owner
        IProtocolCoreV3(core).registerFarm(owner, address(farm), farmId);
        farmsByOwner[owner].push(address(farm));
        ownerByFarm[address(farm)] = owner;
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
