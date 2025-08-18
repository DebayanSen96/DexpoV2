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

interface IOwnable {
    function owner() external view returns (address);
}

/**
 * @title StrategyRouter (v3)
 * @notice Holds target allocations and orchestrates deposits/withdrawals across adapters.
 *         Access: wiring by owner/protocol owner; ops only by the configured vault.
 */
contract StrategyRouter is IStrategyRouter, Ownable, ReentrancyGuard, Pausable {
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using SafeERC20 for IERC20;

    address public immutable override asset;
    address public immutable protocolCore;

    // Vault authorized to operate allocate/deallocate/harvest
    address public vault;

    struct Allocation { address adapter; uint16 bps; }

    EnumerableSet.Bytes32Set private _ids;
    mapping(bytes32 => Allocation) public alloc;

    constructor(address asset_, address protocolCore_) Ownable(msg.sender) {
        asset = asset_;
        protocolCore = protocolCore_;
    }

    modifier onlyOwnerOrProtocolOwner() {
        if (msg.sender != owner() && msg.sender != IOwnable(protocolCore).owner()) revert("Unauthorized");
        _;
    }

    event VaultSet(address indexed vault);

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

    function setAllocations(
        bytes32[] calldata ids,
        address[] calldata adapters,
        uint16[] calldata bps
    ) external override onlyOwnerOrProtocolOwner whenNotPaused {
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
            _ids.add(ids[j]);
            alloc[ids[j]] = Allocation({ adapter: adapters[j], bps: bps[j] });
            sum += bps[j];
        }
        require(sum == 10_000, "SumBps");
    }

    // One-time vault setter used during initial wiring by the factory/owner
    function setVault(address vault_) external onlyOwner {
        require(vault_ != address(0), "VaultZero");
        require(vault == address(0), "VaultSet");
        vault = vault_;
        emit VaultSet(vault_);
    }

    modifier onlyVault() {
        require(msg.sender == vault, "NotVault");
        _;
    }

    function allocate(uint256 amount) external override onlyVault nonReentrant whenNotPaused returns (uint256 deployed) {
        require(amount > 0, "ZeroAmount");
        uint256 n = _ids.length();
        require(n > 0, "NoAlloc");

        // Pull assets from caller (expected to be the vault/owner) into the router once
        IERC20 token = IERC20(asset);
        token.safeTransferFrom(msg.sender, address(this), amount);

        for (uint256 i = 0; i < n; i++) {
            bytes32 id = _ids.at(i);
            Allocation memory a = alloc[id];
            if (a.adapter == address(0) || a.bps == 0) continue;
            uint256 part = (amount * a.bps) / 10_000;
            if (part == 0) continue;

            // Approve adapter to pull and deposit
            token.forceApprove(a.adapter, 0);
            token.forceApprove(a.adapter, part);
            deployed += IStrategyAdapter(a.adapter).deposit(part, bytes(""));
        }
    }

    function deallocate(uint256 amount) external override onlyVault nonReentrant whenNotPaused returns (uint256 received) {
        require(amount > 0, "ZeroAmount");
        uint256 n = _ids.length();
        require(n > 0, "NoAlloc");

        for (uint256 i = 0; i < n; i++) {
            bytes32 id = _ids.at(i);
            Allocation memory a = alloc[id];
            if (a.adapter == address(0) || a.bps == 0) continue;
            uint256 part = (amount * a.bps) / 10_000;
            if (part == 0) continue;
            received += IStrategyAdapter(a.adapter).withdraw(part, bytes(""));
        }

        // Forward received assets to caller (expected to be the vault)
        if (received > 0) {
            IERC20(asset).safeTransfer(vault, received);
        }
    }

    function rebalance(uint16[] calldata targetBps) external override onlyOwnerOrProtocolOwner whenNotPaused {
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

    function harvest() external override onlyVault nonReentrant whenNotPaused returns (uint256 baseReturned) {
        uint256 n = _ids.length();
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

        // Forward realized base assets to vault
        if (baseReturned > 0) {
            IERC20(asset).safeTransfer(vault, baseReturned);
        }
    }

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

    // Admin pause controls
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
