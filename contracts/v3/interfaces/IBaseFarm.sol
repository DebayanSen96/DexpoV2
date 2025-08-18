// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBaseFarm {
    // ERC-4626-like surface
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);

    function convertToShares(uint256 assets) external view returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function mint(uint256 shares, address receiver) external returns (uint256 assets);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    // Policy wiring
    function setPayoutPolicy(address payoutPolicy) external;
    function setLockupPolicy(address lockupPolicy) external;
    function setStakeholderRegistry(address registry) external;
    function setStrategyRouter(address router) external;

    // Ops
    function harvest() external returns (uint256 netAssets);
    function rebalance(uint16[] calldata targetBps) external;

    // Admin
    function pause() external;
    function unpause() external;
}
