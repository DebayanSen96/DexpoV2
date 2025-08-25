// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategyAdapter.sol";
import "../interfaces/IOwnable.sol";

/**
 * @title LayerZeroStargateBridgeAdapter (Generic)
 * @notice Minimal, router-controlled adapter that currently holds the base asset locally
 *         and is wired for future LayerZero/Stargate integration. Safe for localhost and
 *         dry-run deployments. Does not perform bridging on-chain yet.
 */
contract LayerZeroStargateBridgeAdapter is IStrategyAdapter, Ownable {
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

    // Bridge endpoints/config
    address public stargateRouter; // Stargate Router
    address public lzEndpoint;     // LayerZero Endpoint
    uint16  public poolId;         // Stargate pool id
    uint16  public dstChainId;     // LayerZero dst chain id

    // Controls
    bool public paused;
    uint256 public minDeposit;
    uint256 public minWithdraw;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event RouterSet(address indexed router);
    event BridgeSet(address indexed stargateRouter, address indexed lzEndpoint, uint16 poolId, uint16 dstChainId);
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

    constructor(
        address asset_,
        address protocolCore_,
        address stargateRouter_,
        address lzEndpoint_,
        uint16 poolId_,
        uint16 dstChainId_
    ) Ownable(msg.sender) {
        require(asset_ != address(0) && protocolCore_ != address(0), "Zero");
        require(stargateRouter_ != address(0) && lzEndpoint_ != address(0), "Zero");
        asset = asset_;
        protocolCore = protocolCore_;
        stargateRouter = stargateRouter_;
        lzEndpoint = lzEndpoint_;
        poolId = poolId_;
        dstChainId = dstChainId_;
        emit BridgeSet(stargateRouter_, lzEndpoint_, poolId_, dstChainId_);
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
    function setBridge(address s, address lz, uint16 p, uint16 dst) external onlyOwner {
        require(s != address(0) && lz != address(0), "Zero");
        stargateRouter = s; lzEndpoint = lz; poolId = p; dstChainId = dst; emit BridgeSet(s, lz, p, dst);
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

    function deposit(uint256 amount, bytes calldata /*params*/) external override onlyRouter notPaused returns (uint256 sharesOrAmt) {
        if (amount == 0 || amount < minDeposit) revert AmountTooSmall();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        // Currently park funds locally. Future: initiate Stargate bridge.
        return amount; // report base units held as deployed amount
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
