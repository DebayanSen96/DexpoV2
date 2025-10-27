// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "../interfaces/IFarmFactory.sol";
import "../interfaces/IProtocolCore.sol";
import "../strategies/StrategyRouter.sol";
import "../interfaces/IWhitelistRegistry.sol";
import "../modules/LockupPolicy.sol";
import "../modules/PayoutPolicy.sol";
import "../modules/StakeholderRegistry.sol";
import "../farm/BaseFarm.sol";
import "../interfaces/IShareToken.sol";
import "../interfaces/IPayoutPolicy.sol";

/// @dev Minimal interface for adapters that support one-time router wiring
interface IAdapterRouterSettable { function setRouterOnce(address r) external; }

/**
 * @title FarmFactory (v3)
 * @notice Deploys and wires a complete Dexponent v3 farm stack. Restricted to ProtocolCore.
 */
contract FarmFactory is IFarmFactory, Ownable {
    address public immutable protocolCore;
    /// @notice Default swap/Oracle contract used for adapters' swapTarget/priceOracle and farm USD pricer.
    address public defaultSwapOracle;

    /// @notice Optional factory-wide default minimum subscription (base units). Default 0 disables.
    uint256 public override defaultMinSubscription;

    // Implementation addresses for minimal proxy clones
    address public baseFarmImpl;
    address public routerImpl;
    address public lockupImpl;
    address public payoutImpl;
    address public registryImpl;

    event ImplementationsSet(address baseFarm, address router, address payout, address lockup, address registry);
    event WhitelistRegistrySet(address indexed registry);

    // Lightweight registry for discovery: which farms were deployed for which owner
    mapping(address => address[]) public farmsByOwner; // owner => list of baseFarm addresses
    mapping(address => address) public ownerByFarm;    // baseFarm => owner

    error NotCore();

    address public coreModule; // optional module allowed to act as core (e.g., FarmCreationModule)

    modifier onlyCoreOrModule() {
        if (msg.sender != protocolCore && msg.sender != coreModule) revert NotCore();
        _;
    }

    // Optional protocol-wide whitelist registry used to configure routers/adapters at clone time
    address public whitelistRegistry;

    /// @notice Initialize the factory bound to a specific `ProtocolCore` and default swap/oracle.
    /// @param core Address of the ProtocolCore that is authorized to call this factory.
    /// @param swapOracle Address of the default swap/oracle (e.g., MockSwapRouter). Can be zero to disable.
    constructor(address core, address swapOracle) Ownable(msg.sender) {
        require(core != address(0), "CoreZero");
        protocolCore = core;
        defaultSwapOracle = swapOracle;
    }

    /// @notice Update the default swap/oracle used for future farms/adapters. Zero disables wiring.
    function setDefaultSwapOracle(address swapOracle) external onlyOwner {
        defaultSwapOracle = swapOracle;
    }

    /// @notice Set factory-wide default minimum subscription (base units). 0 disables.
    function setDefaultMinSubscription(uint256 minSubBaseUnits) external override onlyOwner {
        defaultMinSubscription = minSubBaseUnits;
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

    /// @notice Sets the whitelist registry that will be wired into routers/adapters during creation.
    /// @dev Owner (protocol operator) sets this once; setting to zero disables wiring.
    function setWhitelistRegistry(address r) external onlyOwner {
        require(r != address(0), "ZeroRegistry");
        whitelistRegistry = r;
        emit WhitelistRegistrySet(r);
    }

    /// @notice Set an auxiliary module that can call factory functions as core (e.g., FarmCreationModule).
    function setCoreModule(address module) external onlyOwner {
        coreModule = module;
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
    ) external onlyCoreOrModule returns (FarmAddresses memory addrs) {
        addrs = _createFarmStack(
            asset,
            farmName,
            farmSymbol,
            core,
            farmId,
            owner,
            ownerRecipient,
            lpBps,
            ownerBps,
            verifierBps,
            lockCfg,
            payoutCfg,
            stCfg,
            adapterKeys,
            adapterAddrs,
            adapterBps
        );
    }

    function _createFarmStack(
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
    ) internal returns (FarmAddresses memory addrs) {
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

        address payable routerAddr = payable(Clones.clone(routerImpl));
        StrategyRouter router = StrategyRouter(routerAddr);
        router.initialize(asset, core, address(this));
        // Wire whitelist registry into router if configured
        if (whitelistRegistry != address(0)) {
            router.setWhitelistRegistry(whitelistRegistry);
        }

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

        BaseFarm farm = BaseFarm(payable(Clones.clone(baseFarmImpl)));
        farm.initialize(asset, farmName, farmSymbol, core, farmId, address(this));

        // 2) Wire modules
        farm.setStrategyRouter(address(router));
        farm.setPayoutPolicy(address(payout));
        // @ts-ignore
        payout.setFarm(address(farm));
        farm.setLockupPolicy(address(lockup));
        farm.setStakeholderRegistry(address(registry));
        // If default oracle provided, wire it into farm for USD TVL/PPS
        if (defaultSwapOracle != address(0)) {
            // Best-effort: ignore failure on older farm impls without setUsdPricer
            (bool okFarm, ) = address(farm).call(abi.encodeWithSelector(
                bytes4(keccak256("setUsdPricer(address)")),
                defaultSwapOracle
            ));
            okFarm;
        }
        // Authorize farm on router for ops
        router.setFarm(address(farm));

        // 3) Configure registry splits and recipient
        registry.setSplits(lpBps, ownerBps, verifierBps);
        if (ownerRecipient != address(0)) {
            registry.setOwnerRecipient(ownerRecipient);
        }

        // 4) Wire adapters to the router and set allocations (if provided)
        if (adapterKeys.length > 0) {
            require(
                adapterKeys.length == adapterAddrs.length && adapterKeys.length == adapterBps.length,
                "LenMismatch"
            );
            // Allow factory (as current router owner/initializer) to wire the router into adapters
            for (uint256 i = 0; i < adapterAddrs.length; i++) {
                require(adapterAddrs[i] != address(0), "BadAdapter");
                IAdapterRouterSettable(adapterAddrs[i]).setRouterOnce(address(router));
                // If adapter supports whitelist wiring, attempt to set it (best-effort)
                if (whitelistRegistry != address(0)) {
                    // Low-level call to avoid hard dependency; ignore failure for adapters that don't implement it
                    (bool ok, ) = adapterAddrs[i].call(abi.encodeWithSelector(
                        bytes4(keccak256("setWhitelistRegistry(address)")),
                        whitelistRegistry
                    ));
                    ok; // silence unused var warning
                }
                // If default oracle provided, best-effort set swap target and price oracle on adapter
                if (defaultSwapOracle != address(0)) {
                    // setSwapTarget(address)
                    (bool ok1, ) = adapterAddrs[i].call(abi.encodeWithSelector(
                        bytes4(keccak256("setSwapTarget(address)")),
                        defaultSwapOracle
                    ));
                    ok1;
                    // setPriceOracle(address)
                    (bool ok2, ) = adapterAddrs[i].call(abi.encodeWithSelector(
                        bytes4(keccak256("setPriceOracle(address)")),
                        defaultSwapOracle
                    ));
                    ok2;
                }
            }
            // Now set allocations on the router
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

    /// @notice Overload that optionally applies a per-farm minimum subscription (base units). If 0, the factory default is used. If both 0, no minimum is set.
    function createFarmStackWithMin(
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
        uint16[] calldata adapterBps,
        uint256 minSubscriptionBaseUnits
    ) external onlyCoreOrModule returns (FarmAddresses memory addrs) {
        addrs = _createFarmStack(
            asset,
            farmName,
            farmSymbol,
            core,
            farmId,
            owner,
            ownerRecipient,
            lpBps,
            ownerBps,
            verifierBps,
            lockCfg,
            payoutCfg,
            stCfg,
            adapterKeys,
            adapterAddrs,
            adapterBps
        );
        uint256 minToApply = minSubscriptionBaseUnits == 0 ? defaultMinSubscription : minSubscriptionBaseUnits;
        if (minToApply > 0) {
            (bool okMin, ) = addrs.baseFarm.call(abi.encodeWithSelector(
                bytes4(keccak256("setMinSubscription(uint256)")),
                minToApply
            ));
            okMin;
        }
    }
}
