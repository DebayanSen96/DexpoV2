// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVault {
    // Views
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);

    function convertToShares(uint256 assets) external view returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);

    // ERC-4626-like flows
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function mint(uint256 shares, address receiver) external returns (uint256 assets);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    // Pricing helpers
    function pricePerShareE18() external view returns (uint256);
    function totalAssetsUsdE18() external view returns (uint256);
    function pricePerShareUsdE18() external view returns (uint256);

    // Owner-gated action surface
    function approveAsset(address spender, uint256 amount) external;
    function executeAction(address target, bytes calldata data) external returns (bytes memory result);
}
