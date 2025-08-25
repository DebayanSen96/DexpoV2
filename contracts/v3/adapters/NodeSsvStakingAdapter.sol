// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategyAdapter.sol";
import "../interfaces/IOwnable.sol";

// Minimal interface for the BridgingAdapter utility contract
interface IBridgingAdapter {
    function depositToChain(
        address token,
        uint256 amount,
        uint256 destinationChainId,
        address recipient,
        uint256 outputAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        address exclusiveRelayer,
        uint32 exclusivityDeadline
    ) external payable;
}

/**
 * @title NodeSsvStakingAdapter (Generic)
 * @notice Minimal, router-controlled adapter scaffold for staking via SSV Network.
 *         For now it safely holds the base asset and exposes configuration hooks.
 *         Future work: integrate with SSV (deposit, operator assignments, rewards).
 */
contract NodeSsvStakingAdapter is IStrategyAdapter, Ownable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Immutable/mutables
    // ---------------------------------------------------------------------

    // Base asset expected by the router (e.g., WETH)
    address public immutable override asset;

    // Protocol core and router wiring
    address public protocolCore;
    // Only StrategyRouter may operate
    address public router;
    bool public routerSet;

    // SSV endpoints/config
    address public ssvNetwork;     // SSV Network contract
    address public ssvToken;       // SSV token address for operator fees
    bytes32 public withdrawalCredentials;
    uint64[] public operatorIds;

    // Optional bridging configuration (for cross-chain deposits/withdrawals)
    address public bridgingAdapter; // BridgingAdapter contract used for cross-chain transfers

    // Controls
    bool public paused;
    uint256 public minDeposit;
    uint256 public minWithdraw;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event RouterSet(address indexed router);
    event SsvConfigSet(address indexed ssvNetwork, address indexed ssvToken, bytes32 withdrawalCredentials);
    event OperatorsSet(uint64[] operatorIds);
    event BridgingAdapterSet(address indexed adapter);
    event PausedSet(bool paused);
    event MinDepositSet(uint256 minDeposit);
    event MinWithdrawSet(uint256 minWithdraw);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotRouter();
    error Paused();
    error AmountTooSmall();
    error BridgeNotConfigured();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(
        address asset_,
        address protocolCore_,
        address ssvNetwork_,
        bytes32 withdrawalCredentials_,
        uint64[] memory operatorIds_,
        address ssvToken_
    ) Ownable(msg.sender) {
        require(asset_ != address(0) && protocolCore_ != address(0), "Zero");
        require(ssvNetwork_ != address(0) && ssvToken_ != address(0), "Zero");
        asset = asset_;
        protocolCore = protocolCore_;
        ssvNetwork = ssvNetwork_;
        ssvToken = ssvToken_;
        withdrawalCredentials = withdrawalCredentials_;
        operatorIds = operatorIds_;
        emit SsvConfigSet(ssvNetwork_, ssvToken_, withdrawalCredentials_);
        emit OperatorsSet(operatorIds_);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setRouterOnce(address r) external {
        require(!routerSet, "RouterSet");
        require(r != address(0), "Zero");
        address coreOwner = IOwnable(protocolCore).owner();
        require(
            msg.sender == protocolCore ||
            msg.sender == coreOwner ||
            msg.sender == IOwnable(r).owner(),
            "Unauthorized"
        );
        router = r; routerSet = true; emit RouterSet(r);
    }
    function setSsvConfig(address network, address token, bytes32 wc) external onlyOwner {
        require(network != address(0) && token != address(0), "Zero");
        ssvNetwork = network; ssvToken = token; withdrawalCredentials = wc; emit SsvConfigSet(network, token, wc);
    }
    function setOperators(uint64[] calldata ids) external onlyOwner {
        delete operatorIds;
        for (uint256 i = 0; i < ids.length; i++) operatorIds.push(ids[i]);
        emit OperatorsSet(ids);
    }
    function setBridgingAdapter(address a) external onlyOwner {
        bridgingAdapter = a; emit BridgingAdapterSet(a);
    }
    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }
    function setMinDeposit(uint256 v) external onlyOwner { minDeposit = v; emit MinDepositSet(v); }
    function setMinWithdraw(uint256 v) external onlyOwner { minWithdraw = v; emit MinWithdrawSet(v); }

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyRouter() { if (msg.sender != router) revert NotRouter(); _; }
    modifier notPaused() { if (paused) revert Paused(); _; }

    // ---------------------------------------------------------------------
    // IStrategyAdapter
    // ---------------------------------------------------------------------

    function deposit(uint256 amount, bytes calldata params) external override onlyRouter notPaused returns (uint256 sharesOrAmt) {
        if (amount == 0 || amount < minDeposit) revert AmountTooSmall();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        // Optionally perform bridging via BridgingAdapter if instructed by params.
        // Expected encoding for params (if bridging is desired):
        // (bool doBridge, uint256 destinationChainId, address recipient, uint256 outputAmount,
        //  uint32 quoteTimestamp, uint32 fillDeadline, address exclusiveRelayer, uint32 exclusivityDeadline)
        if (params.length > 0) {
            (
                bool doBridge,
                uint256 destinationChainId,
                address recipient,
                uint256 outputAmount,
                uint32 quoteTimestamp,
                uint32 fillDeadline,
                address exclusiveRelayer,
                uint32 exclusivityDeadline
            ) = abi.decode(params, (bool, uint256, address, uint256, uint32, uint32, address, uint32));

            if (doBridge) {
                if (bridgingAdapter == address(0)) revert BridgeNotConfigured();
                // Approve BridgingAdapter to pull funds from this adapter
                IERC20(asset).forceApprove(bridgingAdapter, 0);
                IERC20(asset).approve(bridgingAdapter, amount);
                IBridgingAdapter(bridgingAdapter).depositToChain(
                    asset,
                    amount,
                    destinationChainId,
                    recipient,
                    outputAmount,
                    quoteTimestamp,
                    fillDeadline,
                    exclusiveRelayer,
                    exclusivityDeadline
                );
                // Clear approval for safety
                IERC20(asset).forceApprove(bridgingAdapter, 0);
            }
        }

        // Future: stake via SSV network using configured operators.
        return amount;
    }

    function withdraw(uint256 amount, bytes calldata /*params*/) external override onlyRouter notPaused returns (uint256 received) {
        if (amount == 0 || amount < minWithdraw) revert AmountTooSmall();
        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal == 0) return 0;
        received = amount > bal ? bal : amount;
        IERC20(asset).safeTransfer(msg.sender, received);
    }

    function harvest() external override onlyRouter notPaused returns (
        uint256 baseDelta,
        address[] memory rewardTokens,
        uint256[] memory rewardAmts
    ) {
        baseDelta = 0; rewardTokens = new address[](0); rewardAmts = new uint256[](0);
    }

    function totalAssets() external view override returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }
}
