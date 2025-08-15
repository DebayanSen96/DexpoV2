// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "../interfaces/IStrategyRouter.sol";
import "../interfaces/IStrategyAdapter.sol";

/**
 * @title StrategyRouter (v3)
 * @notice Holds target allocations and will orchestrate deposits/withdrawals across adapters.
 *         MVP skeleton: stores allocations and exposes totalAssets() placeholder.
 */
contract StrategyRouter is IStrategyRouter, Ownable {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    address public immutable override asset;

    struct Allocation { address adapter; uint16 bps; }

    EnumerableSet.Bytes32Set private _ids;
    mapping(bytes32 => Allocation) public alloc;

    constructor(address asset_) { asset = asset_; }

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
    ) external override onlyOwner {
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

    function allocate(uint256 /*amount*/) external pure override returns (uint256 deployed) {
        revert("NotImplemented");
    }

    function deallocate(uint256 /*amount*/) external pure override returns (uint256 received) {
        revert("NotImplemented");
    }

    function rebalance(uint16[] calldata /*targetBps*/) external override onlyOwner {
        revert("NotImplemented");
    }

    function harvest() external pure override returns (uint256 baseReturned) {
        revert("NotImplemented");
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
}
