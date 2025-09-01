// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IStrategyAdapter.sol";
import "../interfaces/IOwnable.sol";
import "../interfaces/IWhitelistRegistry.sol";

interface ISwapRouterV3 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);
}

interface IQuoterV2 {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (
        uint256 amountOut,
        uint160 sqrtPriceX96After,
        uint32 initializedTicksCrossed,
        uint256 gasEstimate
    );

    function quoteExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut,
        uint160 sqrtPriceLimitX96
    ) external returns (
        uint256 amountIn,
        uint160 sqrtPriceX96After,
        uint32 initializedTicksCrossed,
        uint256 gasEstimate
    );
}

/**
 * @title UniV3WethToWstETHAdapter (Base)
 * @notice Adapter that accepts WETH (asset) from the router, swaps to wstETH on deposit, and
 *         reverses to WETH on withdraw using Uniswap V3 on Base. Holds wstETH between cycles.
 *         TVL is reported in WETH via Uniswap V3 quoter.
 */
contract UniV3WethToWstETHAdapter is IStrategyAdapter, Ownable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Immutable/mutables
    // ---------------------------------------------------------------------

    // Base asset expected by router (WETH on Base)
    address public immutable override asset;

    // Target token held (wstETH on Base)
    address public wstETH;

    // Protocol core and router wiring
    address public protocolCore;
    // Only StrategyRouter may operate
    address public router;
    bool public routerSet;

    // Protocol-controlled whitelist registry
    address public whitelistRegistry;

    // DEX endpoints
    address public swapRouter; // Uniswap V3 SwapRouter
    address public quoter;     // Uniswap V3 QuoterV2

    // Pool params
    uint24 public poolFee;     // e.g., 100 (0.01%), 500, 3000, 10000

    // Controls
    bool public paused;
    uint16 public slippageBps = 50; // 0.50% default
    uint256 public minDeposit;
    uint256 public minWithdraw;
    uint32 public deadlineWindow = 300; // +5 minutes deadline buffer

    // Cached price for view-only TVL: WETH per 1 wstETH scaled by 1e18
    uint256 public wethPerWstEthX1e18;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event RouterSet(address indexed router);
    event WhitelistRegistrySet(address indexed registry);
    event DexSet(address indexed swapRouter, address indexed quoter, uint24 poolFee);
    event TokensSet(address indexed asset, address indexed wstETH);
    event PausedSet(bool paused);
    event SlippageSet(uint16 slippageBps);
    event MinDepositSet(uint256 minDeposit);
    event MinWithdrawSet(uint256 minWithdraw);
    event PriceUpdated(uint256 wethPerWstEthX1e18);
    event DeadlineWindowSet(uint32 deadlineWindow);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotRouter();
    error Paused();
    error AmountTooSmall();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @notice Initialize adapter wiring for WETH<->wstETH via Uniswap V3 (Base chain).
    /// @param asset_ Base asset (WETH) expected from the router.
    /// @param wstETH_ Target token to hold between cycles.
    /// @param protocolCore_ ProtocolCore used to authorize router setter (core or its owner).
    /// @param swapRouter_ Uniswap V3 SwapRouter address.
    /// @param quoter_ Uniswap V3 QuoterV2 address.
    /// @param poolFee_ Uniswap V3 pool fee tier.
    constructor(
        address asset_,
        address wstETH_,
        address protocolCore_,
        address swapRouter_,
        address quoter_,
        uint24 poolFee_
    ) Ownable(msg.sender) {
        require(asset_ != address(0) && wstETH_ != address(0), "TokenZero");
        require(protocolCore_ != address(0) && swapRouter_ != address(0) && quoter_ != address(0), "AddrZero");
        asset = asset_;
        wstETH = wstETH_;
        protocolCore = protocolCore_;
        swapRouter = swapRouter_;
        quoter = quoter_;
        poolFee = poolFee_;
        // router intentionally unset at deploy; will be set once by protocol core
        emit DexSet(swapRouter_, quoter_, poolFee_);
        emit TokensSet(asset_, wstETH_);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice One-time router setter restricted to ProtocolCore, its owner, or the owner of the router being set (factory during wiring).
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
        router = r;
        routerSet = true;
        emit RouterSet(r);
    }
    /// @notice Set whitelist registry (protocol-controlled)
    function setWhitelistRegistry(address r) external {
        require(r != address(0), "Zero");
        address coreOwner = IOwnable(protocolCore).owner();
        require(msg.sender == protocolCore || msg.sender == coreOwner, "Unauthorized");
        whitelistRegistry = r;
        emit WhitelistRegistrySet(r);
    }
    /// @notice Update DEX endpoints and pool fee.
    function setDex(address s, address q, uint24 f) external onlyOwner {
        require(s!=address(0)&&q!=address(0), "Zero");
        if (whitelistRegistry != address(0)) {
            require(IWhitelistRegistryV3(whitelistRegistry).isDexApproved(s, q), "DexNotWhitelisted");
            // If wstETH set, validate pool
            if (wstETH != address(0)) {
                require(IWhitelistRegistryV3(whitelistRegistry).isPoolAllowed(asset, wstETH, f, s), "PoolNotAllowed");
            }
        }
        swapRouter=s; quoter=q; poolFee=f; emit DexSet(s,q,f);
    }
    /// @notice Update the target token address.
    function setTokens(address wstETH_) external onlyOwner {
        require(wstETH_!=address(0),"Zero");
        if (whitelistRegistry != address(0)) {
            require(IWhitelistRegistryV3(whitelistRegistry).isTokenWhitelisted(wstETH_), "TokenNotWhitelisted");
            if (swapRouter != address(0) && poolFee != 0) {
                require(IWhitelistRegistryV3(whitelistRegistry).isPoolAllowed(asset, wstETH_, poolFee, swapRouter), "PoolNotAllowed");
            }
        }
        wstETH=wstETH_; emit TokensSet(asset, wstETH_);
    }
    /// @notice Pause/unpause adapter operations.
    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }
    /// @notice Set max slippage in bps used for swaps.
    function setSlippageBps(uint16 bps) external onlyOwner { slippageBps = bps; emit SlippageSet(bps); }
    /// @notice Set minimum deposit amount.
    function setMinDeposit(uint256 v) external onlyOwner { minDeposit = v; emit MinDepositSet(v); }
    /// @notice Set minimum withdraw amount.
    function setMinWithdraw(uint256 v) external onlyOwner { minWithdraw = v; emit MinWithdrawSet(v); }
    /// @notice Set the deadline window (seconds) added to block.timestamp for swap deadlines.
    function setDeadlineWindow(uint32 s) external onlyOwner { require(s > 0 && s <= 3600, "BadDeadline"); deadlineWindow = s; emit DeadlineWindowSet(s); }

    /// @notice Manually refresh cached price using Quoter (wstETH -> WETH for 1e18 units).
    function updatePrice() external onlyOwnerOrRouterOwner notPaused {
        // Quote how much WETH out for 1 wstETH (1e18)
        (uint256 wethOut,,,) = IQuoterV2(quoter).quoteExactInputSingle(wstETH, asset, poolFee, 1e18, 0);
        wethPerWstEthX1e18 = wethOut;
        emit PriceUpdated(wethOut);
    }

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyRouter() { if (msg.sender != router) revert NotRouter(); _; }
    modifier notPaused() { if (paused) revert Paused(); _; }
    modifier onlyOwnerOrRouterOwner() {
        address routerOwner = router != address(0) ? IOwnable(router).owner() : address(0);
        require(msg.sender == owner() || msg.sender == routerOwner, "Unauthorized");
        _;
    }

    // ---------------------------------------------------------------------
    // Internal quote helpers
    // ---------------------------------------------------------------------

    function _quoteExactInput(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal returns (uint256 amountOut) {
        (amountOut,,,) = IQuoterV2(quoter).quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
    }

    function _quoteExactOutput(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut) internal returns (uint256 amountIn) {
        (amountIn,,,) = IQuoterV2(quoter).quoteExactOutputSingle(tokenIn, tokenOut, fee, amountOut, 0);
    }

    // ---------------------------------------------------------------------
    // IStrategyAdapter
    // ---------------------------------------------------------------------

    /**
     * @notice Deposit base asset, swap to wstETH, hold balance in adapter.
     * @param amount Amount of base asset to deposit.
     * @return sharesOrAmt Amount of wstETH acquired (adapter units).
     */
    function deposit(uint256 amount, bytes calldata /*params*/) external payable override onlyRouter notPaused returns (uint256 sharesOrAmt) {
        if (amount == 0 || amount < minDeposit) revert AmountTooSmall();

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        uint256 quotedOut = _quoteExactInput(asset, wstETH, poolFee, amount);
        uint256 minOut = quotedOut - (quotedOut * slippageBps) / 10_000;

        IERC20(asset).forceApprove(swapRouter, 0);
        IERC20(asset).forceApprove(swapRouter, amount);

        uint256 outAmt = ISwapRouterV3(swapRouter).exactInputSingle(
            ISwapRouterV3.ExactInputSingleParams({
                tokenIn: asset,
                tokenOut: wstETH,
                fee: poolFee,
                recipient: address(this),
                deadline: block.timestamp + deadlineWindow,
                amountIn: amount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        // Update cached price using executed trade (amount WETH per 1 wstETH)
        if (outAmt > 0) {
            wethPerWstEthX1e18 = (amount * 1e18) / outAmt;
            emit PriceUpdated(wethPerWstEthX1e18);
        }
        return outAmt; // report wstETH received as deployed units
    }

    /**
     * @notice Withdraw base asset by swapping wstETH back to WETH.
     * @param amount Target WETH amount to receive.
     * @return received WETH received by the router.
     */
    function withdraw(uint256 amount, bytes calldata /*params*/) external override onlyRouter notPaused returns (uint256 received) {
        if (amount == 0 || amount < minWithdraw) revert AmountTooSmall();

        uint256 wstBal = IERC20(wstETH).balanceOf(address(this));
        if (wstBal == 0) return 0;

        // Try exact output: target amount of WETH to router
        uint256 maxIn = _quoteExactOutput(wstETH, asset, poolFee, amount);
        maxIn = maxIn + (maxIn * slippageBps) / 10_000; // add slippage margin on input

        if (maxIn <= wstBal) {
            IERC20(wstETH).forceApprove(swapRouter, 0);
            IERC20(wstETH).forceApprove(swapRouter, maxIn);

            uint256 spent = ISwapRouterV3(swapRouter).exactOutputSingle(
                ISwapRouterV3.ExactOutputSingleParams({
                    tokenIn: wstETH,
                    tokenOut: asset,
                    fee: poolFee,
                    recipient: msg.sender,
                    deadline: block.timestamp + deadlineWindow,
                    amountOut: amount,
                    amountInMaximum: maxIn,
                    sqrtPriceLimitX96: 0
                })
            );
            // Unused approval remains; OK.
            if (amount > 0 && spent > 0) {
                // Update cached price from executed trade: WETH per 1 wstETH
                wethPerWstEthX1e18 = (amount * 1e18) / spent;
                emit PriceUpdated(wethPerWstEthX1e18);
            }
            return amount;
        }

        // If not enough wstETH to hit target, swap entire balance with exact input
        IERC20(wstETH).forceApprove(swapRouter, 0);
        IERC20(wstETH).forceApprove(swapRouter, wstBal);

        // Quote how much WETH out for full wstETH balance
        (uint256 wethOut,,,) = IQuoterV2(quoter).quoteExactInputSingle(wstETH, asset, poolFee, wstBal, 0);
        uint256 minOut = wethOut - (wethOut * slippageBps) / 10_000;

        received = ISwapRouterV3(swapRouter).exactInputSingle(
            ISwapRouterV3.ExactInputSingleParams({
                tokenIn: wstETH,
                tokenOut: asset,
                fee: poolFee,
                recipient: msg.sender,
                deadline: block.timestamp + deadlineWindow,
                amountIn: wstBal,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        if (received > 0) {
            wethPerWstEthX1e18 = (received * 1e18) / wstBal;
            emit PriceUpdated(wethPerWstEthX1e18);
        }
    }

    /// @notice No separate rewards; yield is embedded in wstETH price.
    function harvest() external override onlyRouter notPaused returns (
        uint256 baseDelta,
        address[] memory rewardTokens,
        uint256[] memory rewardAmts
    ) {
        baseDelta = 0;
        rewardTokens = new address[](0);
        rewardAmts = new uint256[](0);
    }

    /// @notice TVL quoted in WETH using cached price approximation.
    function totalAssets() external view override returns (uint256) {
        uint256 wstBal = IERC20(wstETH).balanceOf(address(this));
        if (wstBal == 0 || wethPerWstEthX1e18 == 0) return 0;
        // Return WETH-equivalent using cached price
        return (wstBal * wethPerWstEthX1e18) / 1e18;
    }

    /// @notice Emergency sweep for accidentally sent tokens.
    function sweep(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "ToZero");
        IERC20(token).safeTransfer(to, amount);
    }
}
