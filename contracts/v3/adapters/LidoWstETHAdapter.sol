// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategyAdapter.sol";

/**
 * @title LidoWstETHAdapter (v3)
 * @notice Minimal, robust adapter that holds wstETH as the base asset and accrues yield via appreciation.
 *         - Designed to plug into `StrategyRouter` where the router's `asset()` must be wstETH.
 *         - No swaps or Lido submit/redemption in MVP (avoids external price/queue dependencies).
 *         - Customizable controls: router authorization, pausability, min deposit/withdraw.
 *
 *         Rationale: For LSTs like wstETH, simply holding the token accrues staking yield via its
 *         exchange rate. This adapter therefore focuses on safe custody and clean accounting.
 */
contract LidoWstETHAdapter is IStrategyAdapter, Ownable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Immutable configuration
    // ---------------------------------------------------------------------

    // Base asset expected and held by this adapter (must be wstETH)
    address public immutable override asset;

    // ---------------------------------------------------------------------
    // Mutable configuration (customizable)
    // ---------------------------------------------------------------------

    // Only this address (StrategyRouter) may call deposit/withdraw/harvest
    address public router;

    // Operational controls
    bool public paused;
    uint256 public minDeposit;   // optional gate for small dust
    uint256 public minWithdraw;  // optional gate for small dust

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event RouterSet(address indexed router);
    event PausedSet(bool paused);
    event MinDepositSet(uint256 minDeposit);
    event MinWithdrawSet(uint256 minWithdraw);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotRouter();
    error Paused();
    error AmountTooSmall();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address asset_, address router_) Ownable(msg.sender) {
        require(asset_ != address(0), "AssetZero");
        asset = asset_;
        _setRouter(router_);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setRouter(address router_) external onlyOwner { _setRouter(router_); }
    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }
    function setMinDeposit(uint256 v) external onlyOwner { minDeposit = v; emit MinDepositSet(v); }
    function setMinWithdraw(uint256 v) external onlyOwner { minWithdraw = v; emit MinWithdrawSet(v); }

    function _setRouter(address router_) internal {
        require(router_ != address(0), "RouterZero");
        router = router_;
        emit RouterSet(router_);
    }

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier notPaused() {
        if (paused) revert Paused();
        _;
    }

    // ---------------------------------------------------------------------
    // IStrategyAdapter implementation
    // ---------------------------------------------------------------------

    // Router sends wstETH to the adapter. We hold it and return the amount received.
    function deposit(uint256 amount, bytes calldata /*params*/) external override onlyRouter notPaused returns (uint256 sharesOrAmt) {
        if (amount == 0 || amount < minDeposit) revert AmountTooSmall();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        return amount;
    }

    // Send wstETH back to the router. If requested amount exceeds balance, send balance.
    function withdraw(uint256 amount, bytes calldata /*params*/) external override onlyRouter notPaused returns (uint256 received) {
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (amount == 0 || amount < minWithdraw) revert AmountTooSmall();
        received = amount > bal ? bal : amount;
        if (received > 0) {
            IERC20(asset).safeTransfer(msg.sender, received);
        }
    }

    // No explicit rewards for wstETH (yield via exchange rate). Nothing to claim.
    // Returns zero base delta and empty rewards arrays.
    function harvest() external override onlyRouter notPaused returns (
        uint256 baseDelta,
        address[] memory rewardTokens,
        uint256[] memory rewardAmts
    ) {
        baseDelta = 0;
        rewardTokens = new address[](0);
        rewardAmts = new uint256[](0);
    }

    // TVL = wstETH balance held.
    function totalAssets() external view override returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    // ---------------------------------------------------------------------
    // Emergency
    // ---------------------------------------------------------------------

    function sweep(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "ToZero");
        IERC20(token).safeTransfer(to, amount);
    }
}
