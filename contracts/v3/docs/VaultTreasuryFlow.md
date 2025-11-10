# Vault v3: Interaction & Metrics Guide

## What this doc covers
- How to interact with a Vault: deposit, withdraw, and execute actions (buy/sell/swap/lend/borrow).
- Which metrics are available on-chain, and from which contract (Vault vs Treasury vs Router).
- What to compute off-chain and how.

## Addresses & Roles
- **Vault (ERC20 shares)**: the Vault address itself is the share token. Owner = EOA. `core` controls operator permissions.
- **Treasury (AssetsValuer)**: per‑vault module that holds non‑base/state and reports external NAV. Stores `router`.
- **Router**: `MockSwapRouter` used for price quotes and swaps.
- Discover addresses on-chain:
  - Vault → `assetsValuer()` → Treasury
  - Vault → `usdPricer()` (optional)
  - Treasury → `router()`

## On-chain metrics: where to read
- **Base asset**
  - `vault.asset()` → base token address
  - `IERC20Metadata(vault.asset()).decimals()/symbol()/name()`
- **Shares (claim token)**
  - Address = Vault address
  - `vault.totalSupply()`
  - `vault.decimals()/symbol()/name()`
- **TVL (base units)**
  - `vault.totalAssets()`
  - Breakdown (base):
    - Idle base in Vault: `IERC20(vault.asset()).balanceOf(vault)`
    - Invested base (approx): `vault.totalAssets() - idleBase`
- **TVL (USD) and breakdown (USD)**
  - `treasury.getCachedUsd()` → `(tvlUsdE18, idleUsdE18, investedUsdE18)`
  - Note: cached on each Treasury action; if router prices move without actions, refresh off-chain or trigger an action.
- **PPS (base)**
  - `vault.pricePerShareE18()`
- **Router prices (USD)**
  - `router.priceUsdE18(token)` (1e18 scaling)
- **Treasury state (for off-chain calcs)**
  - `treasury.trackedTokens(uint256)` and `treasury.trackedTokenCount()`
  - `IERC20(token).balanceOf(treasury)`
  - `treasury.lendPrincipal()`, `treasury.borrowPrincipal()`
  - `treasury.lendAprBps()`, `treasury.borrowAprBps()`, `treasury.lastAccrualTs()`

## Off-chain calculations
- **Actual allocations by token (amount, USD, weights):**
  1) Read `trackedTokens` from Treasury.
  2) For each token `t`:
     - `bal = IERC20(t).balanceOf(treasury)`
     - If `t == vault.asset()`, use `effectiveBase = max(bal - lendPrincipal, 0)` to avoid double-counting lent principal.
     - Convert to USD: `usd = bal * router.priceUsdE18(t) / 10^decimals(t)` (use `effectiveBase` for base).
  3) Sum all USD values to `investedUsd`.
  4) Idle USD = `IERC20(asset).balanceOf(vault)` converted to USD via router price.
  5) TVL USD = `idleUsd + investedUsd`.
  6) Weight per token = `usd / investedUsd` (or vs TVL USD if you prefer total weights).
- **PPS (off-chain double-check)**: `(vault.totalAssets() * 1e18) / vault.totalSupply()`
- **24h return**: compare `pps_now / pps_24h_ago - 1` (sample PPS over time).
- **APR/interest (lending/borrowing)**:
  - Use `lendPrincipal/borrowPrincipal`, `lendAprBps/borrowAprBps`, `lastAccrualTs`, and linear accrual: `principal * aprBps/10000 * dt / 365d`.

## Who can call what
- User: `vault.deposit`, `vault.mint`, `vault.withdraw`, `vault.redeem`.
- Operator (core‑approved or core itself): `vault.approveAsset`, `vault.executeAction` (to call Treasury functions), owner setters.

## Approvals you’ll need (operator)
- Spend base from Vault via Router: `vault.approveAsset(router, amount)`
- Let Treasury pull base for lending: `vault.approveAsset(treasury, amount)`

## Actions (step-by-step)
- **Deposit** (user)
  1) `IERC20(asset).approve(vault, amount)`
  2) `vault.deposit(amount, receiver)`

- **Withdraw / Redeem** (user)
  - `vault.withdraw(assets, receiver, owner)` OR `vault.redeem(shares, receiver, owner)`
  - If idle is short, Vault calls `treasury.returnBaseToVault(shortfall)` once.

- **Buy (base → token)** (operator)
  1) `vault.approveAsset(router, amountBase)`
  2) `vault.executeAction(treasury, abi.encodeWithSignature("buyToken(address,uint256)", tokenOut, amountBase))`
  - Output token lands in Treasury; Treasury tracks it and USD cache updates.

- **Sell (token → base)** (operator)
  1) Ensure token is held by Treasury and is tracked (call `trackToken(token)` if needed via executeAction)
  2) `vault.executeAction(treasury, abi.encodeWithSignature("sellToken(address,uint256)", tokenIn, amountToken))`

- **Swap (token → token)** (operator)
  1) TokenIn must be held by Treasury
  2) `vault.executeAction(treasury, abi.encodeWithSignature("swap(address,address,uint256)", tokenIn, tokenOut, amountIn))`

- **Lend** (deploy base capital) (operator)
  1) `vault.approveAsset(treasury, amountBase)`
  2) `vault.executeAction(treasury, abi.encodeWithSignature("lendBase(uint256)", amountBase))`
  - Increases `lendPrincipal`; accrues by APR over time; cached USD updates.

- **Repay Lend** (operator)
  - `vault.executeAction(treasury, abi.encodeWithSignature("repayLend(uint256)", amountBase))`

- **Borrow** (simulate debt) (operator)
  - `vault.executeAction(treasury, abi.encodeWithSignature("borrowBase(uint256)", amountBase))`

- **Repay Borrow** (operator)
  - `vault.executeAction(treasury, abi.encodeWithSignature("repayBorrow(uint256)", amountBase))`

- **Return base to Vault** (operator/manual liquidity return)
  - `vault.executeAction(treasury, abi.encodeWithSignature("returnBaseToVault(uint256)", amount))`

## Claim token, supply, addresses
- **Claim/Share token**: the Vault itself (ERC20).
  - Address: Vault address
  - `totalSupply`, `decimals`, `symbol`, `name` directly on the Vault (ERC20).

## Notes
- Router token list and prices must be maintained for accurate USD.
- Treasury USD cache updates on actions; to refresh without actions, recompute off-chain from router prices and balances or define an explicit poke in Treasury.
