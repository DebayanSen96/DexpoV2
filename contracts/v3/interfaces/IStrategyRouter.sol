// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IStrategyRouter
 * @notice Interface for the strategy router coordinating allocations across adapters.
 */
interface IStrategyRouter {
    /// @notice Base asset managed by the router.
    function asset() external view returns (address);

    /**
     * @notice Get current allocation map.
     * @return ids Adapter keys.
     * @return adapters Adapter addresses.
     * @return bps Target weights in basis points, summing to 10_000.
     */
    function allocations() external view returns (
        bytes32[] memory ids,
        address[] memory adapters,
        uint16[] memory bps
    );

    /**
     * @notice Set target allocations. Requires arrays of equal length and sum(bps)=10_000.
     * @param ids Adapter keys.
     * @param adapters Adapter addresses.
     * @param bps Target weights per adapter in basis points.
     */
    function setAllocations(
        bytes32[] calldata ids,
        address[] calldata adapters,
        uint16[] calldata bps
    ) external;

    /**
     * @notice Allocate `amount` of base asset across adapters per target weights.
     * @param amount Amount of base asset to deploy.
     * @return deployed Total units deployed across adapters.
     */
    function allocate(uint256 amount) external payable returns (uint256 deployed);

    /**
     * @notice Deallocate `amount` of base asset across adapters per target weights.
     * @param amount Amount of base asset to withdraw.
     * @return received Total base asset received back.
     */
    function deallocate(uint256 amount) external returns (uint256 received);

    /**
     * @notice Update target weights for existing adapters. sum(targetBps) must be 10_000.
     * @param targetBps New weights corresponding to current adapter set order.
     */
    function rebalance(uint16[] calldata targetBps) external;

    /**
     * @notice Harvest yields across adapters and forward base asset to the farm.
     * @return baseReturned Total base asset realized and forwarded.
     */
    function harvest() external returns (uint256 baseReturned);

    /// @notice Report total assets across adapters in base terms.
    function totalAssets() external view returns (uint256);
}
