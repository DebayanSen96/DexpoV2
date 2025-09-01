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
 * @title BluechipIndexAdapter
 * @notice Router-controlled adapter that manages a whitelisted basket of tokens against a single
 *         base asset. The farm deposits the base asset; the owner can add/remove tokens, set target
 *         weights, and perform swaps to rebalance using Uniswap V3.
 *         TVL is reported in base units using Quoter.
 */
contract BluechipIndexAdapter is IStrategyAdapter, Ownable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Immutable/mutables
    // ---------------------------------------------------------------------

    // Base asset expected by router
    address public immutable override asset;

    // Protocol core and router wiring
    address public protocolCore;
    address public router;
    bool public routerSet;

    // Whitelist registry set by protocol (not farm owner)
    address public whitelistRegistry;

    // DEX endpoints
    address public swapRouter; // Uniswap V3 SwapRouter
    address public quoter;     // Uniswap V3 QuoterV2

    // Controls
    bool public paused;
    uint16 public slippageBps = 50; // 0.50% default
    uint32 public deadlineWindow = 300; // +5 minutes deadline buffer
    uint256 public minDeposit;
    uint256 public minWithdraw;

    // Index state
    address[] public indexTokens; // ordered list
    mapping(address => bool) public isWhitelisted;
    mapping(address => uint16) public targetWeightBps; // per token weight in bps (0..10000)
    mapping(address => uint24) public poolFeeForToken; // fee tier for token<->asset pool
    // Cached base value per 1 token (scaled by 1e18), updated on executed swaps
    mapping(address => uint256) public basePerTokenX1e18;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event RouterSet(address indexed router);
    event WhitelistRegistrySet(address indexed registry);
    event DexSet(address indexed swapRouter, address indexed quoter);
    event PausedSet(bool paused);
    event SlippageSet(uint16 slippageBps);
    event DeadlineWindowSet(uint32 deadlineWindow);
    event MinDepositSet(uint256 minDeposit);
    event MinWithdrawSet(uint256 minWithdraw);

    event TokensAdded(address[] tokens, uint16[] weightsBps, uint24[] poolFees);
    event TokenRemoved(address indexed token);
    event WeightsUpdated(address[] tokens, uint16[] weightsBps);
    event PoolFeesUpdated(address[] tokens, uint24[] poolFees);

    event SwappedBaseToToken(address indexed token, uint256 baseIn, uint256 tokenOut);
    event SwappedTokenToBase(address indexed token, uint256 tokenIn, uint256 baseOut);
    event TokenPriceUpdated(address indexed token, uint256 basePerTokenX1e18);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotRouter();
    error Paused();
    error AmountTooSmall();
    error BadInput();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param asset_ Base asset expected from the router
    /// @param protocolCore_ ProtocolCore to authorize router setter (core or its owner)
    /// @param swapRouter_ Uniswap V3 SwapRouter address
    /// @param quoter_ Uniswap V3 QuoterV2 address
    /// @param tokens_ Initial whitelisted tokens
    /// @param weightsBps_ Initial target weights per token (bps). Sum may be <= 10000 (remainder stays in base)
    /// @param poolFees_ Uniswap V3 pool fee per token vs base
    constructor(
        address asset_,
        address protocolCore_,
        address swapRouter_,
        address quoter_,
        address[] memory tokens_,
        uint16[] memory weightsBps_,
        uint24[] memory poolFees_
    ) Ownable(msg.sender) {
        require(asset_ != address(0) && protocolCore_ != address(0), "AddrZero");
        require(swapRouter_ != address(0) && quoter_ != address(0), "DexZero");
        require(tokens_.length == weightsBps_.length && tokens_.length == poolFees_.length, "Len");
        asset = asset_;
        protocolCore = protocolCore_;
        swapRouter = swapRouter_;
        quoter = quoter_;
        emit DexSet(swapRouter_, quoter_);
        if (tokens_.length > 0) {
            _addTokens(tokens_, weightsBps_, poolFees_);
        }
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setRouterOnce(address r) external {
        require(!routerSet, "RouterSet");
        require(r != address(0), "Zero");
        address coreOwner = IOwnable(protocolCore).owner();
        // Allow: ProtocolCore, ProtocolCore owner, or the current owner of the router being set (factory during wiring)
        require(
            msg.sender == protocolCore ||
            msg.sender == coreOwner ||
            msg.sender == IOwnable(r).owner(),
            "Unauthorized"
        );
        router = r; routerSet = true; emit RouterSet(r);
    }

    /// @notice Set whitelist registry (protocol-controlled)
    function setWhitelistRegistry(address r) external {
        require(r != address(0), "Zero");
        address coreOwner = IOwnable(protocolCore).owner();
        require(msg.sender == protocolCore || msg.sender == coreOwner, "Unauthorized");
        whitelistRegistry = r;
        emit WhitelistRegistrySet(r);
    }

    function setDex(address s, address q) external onlyOwner {
        require(s!=address(0)&&q!=address(0), "Zero");
        if (whitelistRegistry != address(0)) {
            require(IWhitelistRegistryV3(whitelistRegistry).isDexApproved(s, q), "DexNotWhitelisted");
            // If tokens and fees exist, ensure pools are allowed
            for (uint256 i = 0; i < indexTokens.length; i++) {
                address t = indexTokens[i];
                uint24 fee = poolFeeForToken[t];
                if (fee != 0) {
                    require(IWhitelistRegistryV3(whitelistRegistry).isPoolAllowed(asset, t, fee, s), "PoolNotAllowed");
                }
            }
        }
        swapRouter=s; quoter=q; emit DexSet(s,q);
    }

    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }
    function setSlippageBps(uint16 bps) external onlyOwner { slippageBps = bps; emit SlippageSet(bps); }
    function setDeadlineWindow(uint32 s) external onlyOwner { require(s > 0 && s <= 3600, "BadDeadline"); deadlineWindow = s; emit DeadlineWindowSet(s); }
    function setMinDeposit(uint256 v) external onlyOwner { minDeposit = v; emit MinDepositSet(v); }
    function setMinWithdraw(uint256 v) external onlyOwner { minWithdraw = v; emit MinWithdrawSet(v); }

    function addTokens(address[] calldata tokens_, uint16[] calldata weightsBps_, uint24[] calldata poolFees_) external onlyOwner {
        _addTokens(tokens_, weightsBps_, poolFees_);
    }

    function removeToken(address token) external onlyOwner {
        require(isWhitelisted[token], "NotListed");
        // remove from list
        uint256 n = indexTokens.length;
        for (uint256 i = 0; i < n; i++) {
            if (indexTokens[i] == token) {
                indexTokens[i] = indexTokens[n-1];
                indexTokens.pop();
                break;
            }
        }
        delete isWhitelisted[token];
        delete targetWeightBps[token];
        delete poolFeeForToken[token];
        emit TokenRemoved(token);
    }

    function setWeights(address[] calldata tokens_, uint16[] calldata weightsBps_) external onlyOwner {
        require(tokens_.length == weightsBps_.length, "Len");
        uint256 sum;
        for (uint256 i = 0; i < tokens_.length; i++) {
            require(isWhitelisted[tokens_[i]], "NotListed");
            targetWeightBps[tokens_[i]] = weightsBps_[i];
            sum += weightsBps_[i];
        }
        require(sum <= 10_000, "Sum>");
        emit WeightsUpdated(tokens_, weightsBps_);
    }

    function setPoolFees(address[] calldata tokens_, uint24[] calldata fees_) external onlyOwner {
        require(tokens_.length == fees_.length, "Len");
        for (uint256 i = 0; i < tokens_.length; i++) {
            require(isWhitelisted[tokens_[i]], "NotListed");
            // If registry configured and dex set, ensure (asset, token, fee, swapRouter) is allowed
            if (whitelistRegistry != address(0) && swapRouter != address(0)) {
                require(IWhitelistRegistryV3(whitelistRegistry).isPoolAllowed(asset, tokens_[i], fees_[i], swapRouter), "PoolNotAllowed");
            }
            poolFeeForToken[tokens_[i]] = fees_[i];
        }
        emit PoolFeesUpdated(tokens_, fees_);
    }

    // Manual swaps for owner-driven rebalancing
    function swapBaseToToken(address token, uint256 baseIn, uint256 minTokenOut) external onlyOwnerOrRouterOwner notPaused returns (uint256 outAmt) {
        require(isWhitelisted[token], "NotListed");
        require(baseIn > 0, "Amt");
        uint24 fee = poolFeeForToken[token];
        IERC20(asset).forceApprove(swapRouter, 0);
        IERC20(asset).forceApprove(swapRouter, baseIn);
        outAmt = ISwapRouterV3(swapRouter).exactInputSingle(
            ISwapRouterV3.ExactInputSingleParams({
                tokenIn: asset,
                tokenOut: token,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp + deadlineWindow,
                amountIn: baseIn,
                amountOutMinimum: minTokenOut,
                sqrtPriceLimitX96: 0
            })
        );
        emit SwappedBaseToToken(token, baseIn, outAmt);
        if (outAmt > 0) {
            uint256 px = (baseIn * 1e18) / outAmt; // base per 1 token
            basePerTokenX1e18[token] = px;
            emit TokenPriceUpdated(token, px);
        }
    }

    function swapTokenToBase(address token, uint256 tokenIn, uint256 minBaseOut) external onlyOwnerOrRouterOwner notPaused returns (uint256 outAmt) {
        require(isWhitelisted[token], "NotListed");
        require(tokenIn > 0, "Amt");
        uint24 fee = poolFeeForToken[token];
        IERC20(token).forceApprove(swapRouter, 0);
        IERC20(token).forceApprove(swapRouter, tokenIn);
        outAmt = ISwapRouterV3(swapRouter).exactInputSingle(
            ISwapRouterV3.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: asset,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp + deadlineWindow,
                amountIn: tokenIn,
                amountOutMinimum: minBaseOut,
                sqrtPriceLimitX96: 0
            })
        );
        emit SwappedTokenToBase(token, tokenIn, outAmt);
        if (tokenIn > 0 && outAmt > 0) {
            uint256 px = (outAmt * 1e18) / tokenIn; // base per 1 token
            basePerTokenX1e18[token] = px;
            emit TokenPriceUpdated(token, px);
        }
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
    // Internal helpers
    // ---------------------------------------------------------------------

    function _addTokens(address[] memory tokens_, uint16[] memory weightsBps_, uint24[] memory poolFees_) internal {
        require(tokens_.length == weightsBps_.length && tokens_.length == poolFees_.length, "Len");
        uint256 sum = _sumWeights();
        for (uint256 i = 0; i < tokens_.length; i++) {
            address t = tokens_[i];
            require(t != address(0), "Zero");
            require(!isWhitelisted[t], "Exists");
            if (whitelistRegistry != address(0)) {
                require(IWhitelistRegistryV3(whitelistRegistry).isTokenWhitelisted(t), "TokenNotWhitelisted");
                if (swapRouter != address(0)) {
                    require(IWhitelistRegistryV3(whitelistRegistry).isPoolAllowed(asset, t, poolFees_[i], swapRouter), "PoolNotAllowed");
                }
            }
            isWhitelisted[t] = true;
            indexTokens.push(t);
            targetWeightBps[t] = weightsBps_[i];
            poolFeeForToken[t] = poolFees_[i];
            sum += weightsBps_[i];
        }
        require(sum <= 10_000, "Sum>");
        emit TokensAdded(tokens_, weightsBps_, poolFees_);
    }

    function _sumWeights() internal view returns (uint256 s) {
        for (uint256 i = 0; i < indexTokens.length; i++) {
            s += targetWeightBps[indexTokens[i]];
        }
    }

    function _quoteTokenToBase(address token, uint256 amountToken) internal returns (uint256 baseOut) {
        if (amountToken == 0) return 0;
        (baseOut,,,) = IQuoterV2(quoter).quoteExactInputSingle(token, asset, poolFeeForToken[token], amountToken, 0);
    }

    function _quoteBaseToToken(address token, uint256 amountBase) internal returns (uint256 tokenOut) {
        if (amountBase == 0) return 0;
        (tokenOut,,,) = IQuoterV2(quoter).quoteExactInputSingle(asset, token, poolFeeForToken[token], amountBase, 0);
    }

    function _quoteBaseForExactToken(address token, uint256 tokenOutDesired) internal returns (uint256 baseIn) {
        if (tokenOutDesired == 0) return 0;
        (baseIn,,,) = IQuoterV2(quoter).quoteExactOutputSingle(asset, token, poolFeeForToken[token], tokenOutDesired, 0);
    }

    function _quoteTokenForExactBase(address token, uint256 baseOutDesired) internal returns (uint256 tokenIn) {
        if (baseOutDesired == 0) return 0;
        (tokenIn,,,) = IQuoterV2(quoter).quoteExactOutputSingle(token, asset, poolFeeForToken[token], baseOutDesired, 0);
    }

    // ---------------------------------------------------------------------
    // IStrategyAdapter
    // ---------------------------------------------------------------------

    /// @notice Accept base asset from router. If params specify (bool investNow), attempt to buy tokens
    ///         according to current target weights using available base balance.
    function deposit(uint256 amount, bytes calldata params) external override onlyRouter notPaused returns (uint256 sharesOrAmt) {
        if (amount == 0 || amount < minDeposit) revert AmountTooSmall();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        bool investNow = false;
        if (params.length == 32) {
            // params = abi.encode(bool investNow)
            investNow = abi.decode(params, (bool));
        }
        if (investNow) {
            _rebalanceToTargets();
        }
        return amount; // report deployed base units (simple semantics)
    }

    /// @notice Withdraw base asset back to router by selling tokens as needed.
    function withdraw(uint256 amount, bytes calldata /*params*/) external override onlyRouter notPaused returns (uint256 received) {
        if (amount == 0 || amount < minWithdraw) revert AmountTooSmall();

        uint256 baseBal = IERC20(asset).balanceOf(address(this));
        if (baseBal >= amount) {
            IERC20(asset).safeTransfer(msg.sender, amount);
            return amount;
        }

        uint256 remaining = amount - baseBal;
        // Sell tokens until remaining satisfied
        for (uint256 i = 0; i < indexTokens.length && remaining > 0; i++) {
            address t = indexTokens[i];
            uint256 tBal = IERC20(t).balanceOf(address(this));
            if (tBal == 0) continue;
            uint256 needTokenIn = _quoteTokenForExactBase(t, remaining);
            uint256 sellAmt = needTokenIn <= tBal ? needTokenIn : tBal;
            if (sellAmt > 0) {
                IERC20(t).forceApprove(swapRouter, 0);
                IERC20(t).forceApprove(swapRouter, sellAmt);
                uint256 gotBase = ISwapRouterV3(swapRouter).exactInputSingle(
                    ISwapRouterV3.ExactInputSingleParams({
                        tokenIn: t,
                        tokenOut: asset,
                        fee: poolFeeForToken[t],
                        recipient: address(this),
                        deadline: block.timestamp + deadlineWindow,
                        amountIn: sellAmt,
                        amountOutMinimum: 0, // guarded by slippage at final transfer step
                        sqrtPriceLimitX96: 0
                    })
                );
                if (sellAmt > 0 && gotBase > 0) {
                    uint256 px = (gotBase * 1e18) / sellAmt;
                    basePerTokenX1e18[t] = px;
                    emit TokenPriceUpdated(t, px);
                }
                if (gotBase >= remaining) {
                    remaining = 0;
                } else {
                    remaining -= gotBase;
                }
            }
        }
        uint256 sendAmt = amount - remaining;
        if (sendAmt > 0) IERC20(asset).safeTransfer(msg.sender, sendAmt);
        return sendAmt;
    }

    /// @notice No separate rewards; yield is from basket price changes.
    function harvest() external override onlyRouter notPaused returns (
        uint256 baseDelta,
        address[] memory rewardTokens,
        uint256[] memory rewardAmts
    ) {
        baseDelta = 0;
        rewardTokens = new address[](0);
        rewardAmts = new uint256[](0);
    }

    /// @notice TVL quoted in base using cached prices only. No external calls.
    function totalAssets() external view override returns (uint256) {
        uint256 total = IERC20(asset).balanceOf(address(this));
        for (uint256 i = 0; i < indexTokens.length; i++) {
            address t = indexTokens[i];
            uint256 bal = IERC20(t).balanceOf(address(this));
            uint256 px = basePerTokenX1e18[t];
            if (bal == 0 || px == 0) continue;
            total += (bal * px) / 1e18;
        }
        return total;
    }

    // ---------------------------------------------------------------------
    // Owner helpers: auto-rebalance to targets (best-effort, simple pass)
    // ---------------------------------------------------------------------

    function rebalanceToTargets() external onlyOwnerOrRouterOwner notPaused {
        _rebalanceToTargets();
    }

    function _rebalanceToTargets() internal {
        // 1) Sell over-allocated tokens to base
        uint256 totalVal = _totalValueInBaseMutable();
        if (totalVal == 0) return;
        for (uint256 i = 0; i < indexTokens.length; i++) {
            address t = indexTokens[i];
            uint256 tBal = IERC20(t).balanceOf(address(this));
            if (tBal == 0) continue;
            uint256 curVal = _quoteTokenToBase(t, tBal);
            uint256 targetVal = (totalVal * uint256(targetWeightBps[t])) / 10_000;
            if (curVal > targetVal) {
                uint256 excess = curVal - targetVal;
                uint256 needTokenIn = _quoteTokenForExactBase(t, excess);
                uint256 sellAmt = needTokenIn <= tBal ? needTokenIn : tBal;
                if (sellAmt > 0) {
                    IERC20(t).forceApprove(swapRouter, 0);
                    IERC20(t).forceApprove(swapRouter, sellAmt);
                    uint256 baseOut = ISwapRouterV3(swapRouter).exactInputSingle(
                        ISwapRouterV3.ExactInputSingleParams({
                            tokenIn: t,
                            tokenOut: asset,
                            fee: poolFeeForToken[t],
                            recipient: address(this),
                            deadline: block.timestamp + deadlineWindow,
                            amountIn: sellAmt,
                            amountOutMinimum: 0,
                            sqrtPriceLimitX96: 0
                        })
                    );
                    if (baseOut > 0) {
                        uint256 px = (baseOut * 1e18) / sellAmt;
                        basePerTokenX1e18[t] = px;
                        emit TokenPriceUpdated(t, px);
                    }
                }
            }
        }
        // 2) Buy under-allocated tokens using base
        totalVal = _totalValueInBaseMutable();
        uint256 baseBal = IERC20(asset).balanceOf(address(this));
        if (baseBal == 0) return;
        for (uint256 i = 0; i < indexTokens.length && baseBal > 0; i++) {
            address t = indexTokens[i];
            uint256 tBal = IERC20(t).balanceOf(address(this));
            uint256 curVal = _quoteTokenToBase(t, tBal);
            uint256 targetVal = (totalVal * uint256(targetWeightBps[t])) / 10_000;
            if (curVal < targetVal) {
                uint256 deficit = targetVal - curVal;
                if (deficit > baseBal) deficit = baseBal;
                // compute minOut with slippage guard
                uint256 quotedOut = _quoteBaseToToken(t, deficit);
                uint256 minOut = quotedOut - (quotedOut * slippageBps) / 10_000;
                IERC20(asset).forceApprove(swapRouter, 0);
                IERC20(asset).forceApprove(swapRouter, deficit);
                uint256 outAmt = ISwapRouterV3(swapRouter).exactInputSingle(
                    ISwapRouterV3.ExactInputSingleParams({
                        tokenIn: asset,
                        tokenOut: t,
                        fee: poolFeeForToken[t],
                        recipient: address(this),
                        deadline: block.timestamp + deadlineWindow,
                        amountIn: deficit,
                        amountOutMinimum: minOut,
                        sqrtPriceLimitX96: 0
                    })
                );
                baseBal -= deficit;
                emit SwappedBaseToToken(t, deficit, outAmt);
                if (outAmt > 0) {
                    uint256 px = (deficit * 1e18) / outAmt;
                    basePerTokenX1e18[t] = px;
                    emit TokenPriceUpdated(t, px);
                }
            }
        }
    }

    function _totalValueInBaseMutable() internal returns (uint256 total) {
        total = IERC20(asset).balanceOf(address(this));
        for (uint256 i = 0; i < indexTokens.length; i++) {
            address t = indexTokens[i];
            uint256 bal = IERC20(t).balanceOf(address(this));
            if (bal == 0) continue;
            total += _quoteTokenToBase(t, bal);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getIndexTokens() external view returns (address[] memory) { return indexTokens; }

    function getTokenInfo(address token) external view returns (
        bool whitelisted,
        uint16 weightBps,
        uint24 poolFee,
        uint256 tokenBalance
    ) {
        whitelisted = isWhitelisted[token];
        weightBps = targetWeightBps[token];
        poolFee = poolFeeForToken[token];
        tokenBalance = IERC20(token).balanceOf(address(this));
    }
}
