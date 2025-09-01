// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IStrategyAdapter
 * @notice Interface for pluggable strategy adapters controlled by the router.
 */
interface IStrategyAdapter {
    /// @notice Base asset expected by this adapter (e.g., WETH).
    function asset() external view returns (address);

    /**
     * @notice Deposit base asset from router into the strategy.
     * @param amount Amount of base asset to deposit.
     * @param params Optional adapter-specific calldata.
     * @return sharesOrAmt Adapter-defined units minted or amount effectively deployed.
     */
    function deposit(uint256 amount, bytes calldata params) external payable returns (uint256 sharesOrAmt);

    /**
     * @notice Withdraw base asset back to the router.
     * @param amount Target amount to withdraw in base units.
     * @param params Optional adapter-specific calldata.
     * @return received Base asset received by the router.
     */
    function withdraw(uint256 amount, bytes calldata params) external returns (uint256 received);

    /**
     * @notice Realize any pending rewards. Implementations should return base delta and any reward tokens already claimed to the adapter.
     * @return baseDelta Net base asset change (positive if realized to adapter).
     * @return rewardTokens List of reward token addresses (if any).
     * @return rewardAmts Amounts per reward token.
     */
    function harvest() external returns (
        uint256 baseDelta,
        address[] memory rewardTokens,
        uint256[] memory rewardAmts
    );

    /// @notice Report total assets managed by the adapter in base units.
    function totalAssets() external view returns (uint256);
}
