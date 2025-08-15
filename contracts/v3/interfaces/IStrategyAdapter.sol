// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStrategyAdapter {
    function asset() external view returns (address);

    function deposit(uint256 amount, bytes calldata params) external returns (uint256 sharesOrAmt);

    function withdraw(uint256 amount, bytes calldata params) external returns (uint256 received);

    // Returns base asset delta and optional reward token data (already claimed by adapter)
    function harvest() external returns (
        uint256 baseDelta,
        address[] memory rewardTokens,
        uint256[] memory rewardAmts
    );

    function totalAssets() external view returns (uint256);
}
