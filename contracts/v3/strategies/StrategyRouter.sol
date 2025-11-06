// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "../interfaces/IStrategyRouter.sol";
import "../interfaces/IStrategyAdapter.sol";
import "../interfaces/IWhitelistRegistry.sol";

interface IOwnable {
    function owner() external view returns (address);
}

/**
 * @title StrategyRouter (v3)
 * @notice Holds target allocations and orchestrates deposits/withdrawals across adapters.
 *         Access: wiring by owner/protocol owner; ops only by the configured farm.
 */
contract StrategyRouter is IStrategyRouter, Ownable, ReentrancyGuard, Pausable {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using SafeERC20 for IERC20;

    address public override asset;
    address public protocolCore;

    // Protocol-controlled whitelist registry (tokens/adapters/DEX)
    address public whitelistRegistry;

    // Farm authorized to operate allocate/deallocate/harvest
    address public farm;

    // Address that owned the router at initialization time (the factory)
    address public initializer;

    // Once true, adapter addresses are sealed; only BPS can be changed via rebalance()
    bool public allocationsSealed;

    struct Allocation { address adapter; uint16 bps; }

    EnumerableSet.Bytes32Set private _ids;
    mapping(bytes32 => Allocation) public alloc;

    /// @notice Parameterless constructor to satisfy Ownable base. Not used by clones.
    constructor() Ownable(msg.sender) {}

    bool private _initialized;

    /// @notice Initialize the router with base asset and protocol core references.
    /// @param asset_ Base asset managed across adapters (address(0) for native ETH).
    /// @param protocolCore_ Protocol core used to authorize protocol owner.
    /// @param initialOwner Owner to set for admin controls.
    function initialize(address asset_, address protocolCore_, address initialOwner) external {
        require(!_initialized, "Init");
        require(protocolCore_ != address(0) && initialOwner != address(0), "Zero");
        asset = asset_;
        protocolCore = protocolCore_;
        initializer = initialOwner;
        _transferOwnership(initialOwner);
        _initialized = true;
    }

    modifier onlyOwnerOrProtocolOwner() {
        if (msg.sender != owner() && msg.sender != IOwnable(protocolCore).owner()) revert("Unauthorized");
        _;
    }
    modifier onlyOwnerProtocolOrFarm() {
        address pOwner = IOwnable(protocolCore).owner();
        if (msg.sender != owner() && msg.sender != pOwner && msg.sender != farm) revert("Unauthorized");
        _;
    }
    event FarmSet(address indexed farm);
    event WhitelistRegistrySet(address indexed registry);

    /**
     * @notice Current adapter allocations and weights.
     * @return ids Adapter keys.
     * @return adapters Adapter addresses.
     * @return bps Target weights in basis points.
     */
    function allocations() external view override returns (
        bytes32[] memory ids,
        address[] memory adapters,
        uint16[] memory bps
    ) {
        uint256 n = _ids.length();
        ids = new bytes32[](n);
        adapters = new address[](n);
        bps = new uint16[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = _ids.at(i);
            ids[i] = id;
            adapters[i] = alloc[id].adapter;
            bps[i] = alloc[id].bps;
        }
    }

    /**
     * @notice Replace the entire allocation set with new adapters and weights.
     * @param ids Adapter keys.
     * @param adapters Adapter addresses.
     * @param bps Target weights per adapter, sum must equal 10_000.
     */
    function setAllocations(
        bytes32[] calldata ids,
        address[] calldata adapters,
        uint16[] calldata bps
    ) external override whenNotPaused {
        // Only the initializer (factory at creation) or ProtocolCore owner may set adapter addresses
        // and this can only happen once; after that, addresses are sealed.
        require(!allocationsSealed, "AllocSealed");
        address pOwner = IOwnable(protocolCore).owner();
        require(msg.sender == initializer || msg.sender == pOwner, "Unauthorized");
        require(ids.length == adapters.length && ids.length == bps.length, "LenMismatch");
        uint256 sum;
        // reset existing set
        uint256 existing = _ids.length();
        for (uint256 i = 0; i < existing; i++) {
            bytes32 id = _ids.at(0);
            _ids.remove(id);
            delete alloc[id];
        }
        for (uint256 j = 0; j < ids.length; j++) {
            require(adapters[j] != address(0), "BadAdapter");
            // Enforce adapter whitelist if registry configured (disabled)
            // if (whitelistRegistry != address(0)) {
            //     require(IWhitelistRegistryV3(whitelistRegistry).isAdapterWhitelisted(adapters[j]), "AdapterNotWhitelisted");
            // }
            _ids.add(ids[j]);
            alloc[ids[j]] = Allocation({ adapter: adapters[j], bps: bps[j] });
            sum += bps[j];
        }
        require(sum == 10_000, "SumBps");
        // Seal addresses to prevent further changes; only bps can change via rebalance()
        allocationsSealed = true;
    }

    /// @notice Set or update the whitelist registry. Restricted to owner or protocol owner.
    function setWhitelistRegistry(address r) external onlyOwnerOrProtocolOwner {
        require(r != address(0), "ZeroRegistry");
        whitelistRegistry = r;
        emit WhitelistRegistrySet(r);
    }

    /// @notice One-time farm setter used during initial wiring by the factory/owner.
    /// @param farm_ Farm address authorized for ops.
    function setFarm(address farm_) external onlyOwner {
        require(farm_ != address(0), "FarmZero");
        require(farm == address(0), "FarmSet");
        farm = farm_;
        emit FarmSet(farm_);
    }

    modifier onlyFarm() {
        require(msg.sender == farm, "NotFarm");
        _;
    }

    /**
     * @notice Allocate base asset across adapters according to target weights.
     * @param amount Amount of base asset to deploy.
     * @return deployed Total units deployed across adapters.
     */
    function allocate(uint256 amount) external payable override onlyFarm nonReentrant whenNotPaused returns (uint256 deployed) {
        require(amount > 0, "ZeroAmount");
        uint256 n = _ids.length();
        require(n > 0, "NoAlloc");

        if (asset == address(0)) {
            require(msg.value == amount, "BadEthValue");
            for (uint256 i = 0; i < n; i++) {
                bytes32 id = _ids.at(i);
                Allocation memory a = alloc[id];
                if (a.adapter == address(0) || a.bps == 0) continue;
                uint256 part = (amount * a.bps) / 10_000;
                if (part == 0) continue;
                deployed += IStrategyAdapter(a.adapter).deposit{value: part}(part, bytes(""));
            }
        } else {
            IERC20 token = IERC20(asset);
            token.safeTransferFrom(msg.sender, address(this), amount);
            for (uint256 i = 0; i < n; i++) {
                bytes32 id = _ids.at(i);
                Allocation memory a = alloc[id];
                if (a.adapter == address(0) || a.bps == 0) continue;
                uint256 part = (amount * a.bps) / 10_000;
                if (part == 0) continue;
                token.forceApprove(a.adapter, 0);
                token.forceApprove(a.adapter, part);
                deployed += IStrategyAdapter(a.adapter).deposit(part, bytes(""));
            }
        }
    }

    /**
     * @notice Withdraw base asset from adapters according to target weights.
     * @param amount Amount of base asset to withdraw.
     * @return received Base asset received and forwarded to the farm.
     */
    function deallocate(uint256 amount) external override onlyFarm nonReentrant whenNotPaused returns (uint256 received) {
        require(amount > 0, "ZeroAmount");
        uint256 n = _ids.length();
        require(n > 0, "NoAlloc");

        if (asset == address(0)) {
            uint256 beforeBal = address(this).balance;
            for (uint256 i = 0; i < n; i++) {
                bytes32 id = _ids.at(i);
                Allocation memory a = alloc[id];
                if (a.adapter == address(0) || a.bps == 0) continue;
                uint256 part = (amount * a.bps) / 10_000;
                if (part == 0) continue;
                IStrategyAdapter(a.adapter).withdraw(part, bytes(""));
            }
            received = address(this).balance - beforeBal;
            if (received > 0) {
                (bool ok, ) = payable(farm).call{value: received}("");
                require(ok, "EthSendFail");
            }
        } else {
            for (uint256 i = 0; i < n; i++) {
                bytes32 id = _ids.at(i);
                Allocation memory a = alloc[id];
                if (a.adapter == address(0) || a.bps == 0) continue;
                uint256 part = (amount * a.bps) / 10_000;
                if (part == 0) continue;
                received += IStrategyAdapter(a.adapter).withdraw(part, bytes(""));
            }
            if (received > 0) {
                IERC20(asset).safeTransfer(farm, received);
            }
        }
    }

    /**
     * @notice Update target weights without moving funds (MVP behavior).
     * @param targetBps New target weights; must sum to 10_000.
     */
    function rebalance(uint16[] calldata targetBps) external override onlyOwnerProtocolOrFarm whenNotPaused {
        uint256 n = _ids.length();
        require(targetBps.length == n, "LenMismatch");
        uint256 sum = 0;
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = _ids.at(i);
            alloc[id].bps = targetBps[i];
            sum += targetBps[i];
        }
        require(sum == 10_000, "SumBps");
        // Note: MVP does not actively move funds; only target weights are updated.
    }

    /**
     * @notice Harvest from all adapters and forward realized base asset to the farm.
     * @return baseReturned Total base asset forwarded to farm.
     */
    function harvest() external override onlyFarm nonReentrant whenNotPaused returns (uint256 baseReturned) {
        uint256 n = _ids.length();
        if (asset == address(0)) {
            uint256 beforeBal = address(this).balance;
            for (uint256 i = 0; i < n; i++) {
                bytes32 id = _ids.at(i);
                address adapter = alloc[id].adapter;
                if (adapter == address(0)) continue;
                IStrategyAdapter(adapter).harvest();
            }
            baseReturned = address(this).balance - beforeBal;
            if (baseReturned > 0) {
                (bool ok, ) = payable(farm).call{value: baseReturned}("");
                require(ok, "EthSendFail");
            }
        } else {
            for (uint256 i = 0; i < n; i++) {
                bytes32 id = _ids.at(i);
                address adapter = alloc[id].adapter;
                if (adapter == address(0)) continue;
                uint256 delta;
                address[] memory rTok;
                uint256[] memory rAmt;
                (delta, rTok, rAmt) = IStrategyAdapter(adapter).harvest();
                if (delta > 0) baseReturned += delta;
            }
            if (baseReturned > 0) {
                IERC20(asset).safeTransfer(farm, baseReturned);
            }
        }
    }

    receive() external payable {}

    /// @notice Total base asset across all adapters (as reported by adapters).
    function totalAssets() external view override returns (uint256) {
        uint256 n = _ids.length();
        uint256 sum = 0;
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = _ids.at(i);
            address adapter = alloc[id].adapter;
            if (adapter != address(0)) {
                sum += IStrategyAdapter(adapter).totalAssets();
            }
        }
        return sum;
    }

    /// @notice Pause admin actions.
    function pause() external onlyOwner { _pause(); }
    /// @notice Unpause admin actions.
    function unpause() external onlyOwner { _unpause(); }
}
