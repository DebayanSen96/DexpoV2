// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStrategyRouter {
    function asset() external view returns (address);

    function allocations() external view returns (
        bytes32[] memory ids,
        address[] memory adapters,
        uint16[] memory bps
    );

    function setAllocations(
        bytes32[] calldata ids,
        address[] calldata adapters,
        uint16[] calldata bps
    ) external;

    function allocate(uint256 amount) external returns (uint256 deployed);
    function deallocate(uint256 amount) external returns (uint256 received);
    function rebalance(uint16[] calldata targetBps) external;

    function harvest() external returns (uint256 baseReturned);
    function totalAssets() external view returns (uint256);
}
