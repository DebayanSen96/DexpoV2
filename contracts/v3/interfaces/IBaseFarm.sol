// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBaseFarm {
    // ERC-4626-like surface
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);
    /// Total assets in USD (1e18 USD units)
    function totalAssetsUsdE18() external view returns (uint256);

    function convertToShares(uint256 assets) external view returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    /// Price per share in base (1e18)
    function pricePerShareE18() external view returns (uint256);
    /// Price per share in USD (1e18 USD)
    function pricePerShareUsdE18() external view returns (uint256);

    function deposit(uint256 assets) external payable returns (uint256 shares);
    function mint(uint256 shares) external payable returns (uint256 assets);
    function withdrawShares(uint256 shares) external returns (uint256 assets);
    function fullExit() external returns (uint256 assets);

    // Position view
    function getUserPosition(address account)
        external
        view
        returns (
            uint256 shares,
            uint256 assets,
            uint256 claimableRewards,
            uint64 lockStart,
            uint64 lockEnd,
            bool locked
        );

    // Policy wiring
    function setPayoutPolicy(address payoutPolicy) external;
    function setLockupPolicy(address lockupPolicy) external;
    function setStakeholderRegistry(address registry) external;
    function setStrategyRouter(address router) external;
    /// Set USD pricer used for USD-denominated views
    function setUsdPricer(address pricer) external;

    // Ops
    function harvest() external returns (uint256 netAssets);
    function rebalance(uint16[] calldata targetBps) external;

    // Admin
    function pause() external;
    function unpause() external;
}
