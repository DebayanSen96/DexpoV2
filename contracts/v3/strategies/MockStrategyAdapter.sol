// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategyAdapter.sol";

/**
 * @title MockStrategyAdapter
 * @notice Minimal mock adapter for testing the StrategyRouter + Vault integration.
 *         - Holds base asset sent via deposits.
 *         - Tracks principal to differentiate realized yield (extra balance) from principal.
 *         - On harvest, any balance above tracked principal is sent back to caller (router) and reported.
 */
contract MockStrategyAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    address public immutable override asset;
    uint256 public principal; // tracks deposited principal net of withdrawals

    constructor(address asset_) {
        require(asset_ != address(0), "asset=0");
        asset = asset_;
    }

    function deposit(uint256 amount, bytes calldata) external override returns (uint256 sharesOrAmt) {
        require(amount > 0, "zero");
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        principal += amount;
        return amount; // 1:1 shares for mock
    }

    function withdraw(uint256 amount, bytes calldata) external override returns (uint256 received) {
        require(amount > 0, "zero");
        uint256 bal = IERC20(asset).balanceOf(address(this));
        received = amount > bal ? bal : amount;
        if (received > 0) {
            // Reduce principal up to the amount withdrawn
            if (principal >= received) {
                principal -= received;
            } else {
                principal = 0; // some yield withdrawn too
            }
            IERC20(asset).safeTransfer(msg.sender, received);
        }
    }

    function harvest() external override returns (
        uint256 baseDelta,
        address[] memory rewardTokens,
        uint256[] memory rewardAmts
    ) {
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal > principal) {
            baseDelta = bal - principal; // realized yield
            IERC20(asset).safeTransfer(msg.sender, baseDelta);
        }
        // no extra reward tokens in mock
        rewardTokens = new address[](0);
        rewardAmts = new uint256[](0);
    }

    function totalAssets() external view override returns (uint256) {
        // For NAV: full balance including any unharvested yield
        return IERC20(asset).balanceOf(address(this));
    }
}
