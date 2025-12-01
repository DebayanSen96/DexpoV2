# v3 Vault Design vs Velvet Infra – Current Problem Statement

This document captures context and problems around the current v3 vault design (`Vault4626` / `BaseVault.sol`) compared against Velvet’s latest infra.

It is **not** a final design; it is a snapshot of issues we want to fix/refine later.

---

## 1. Velvet Infra (Latest v4 View)

### 1.1 High-level architecture

Velvet’s current architecture (v4) is centered around:

- **Velvet Core**
  - Factory / router that creates new portfolios.
  - Key functions:
    - `createPortfolioNonCustodial(initData)`
    - `createPortfolioCustodial(initData, owners[], threshold)`
  - `initData` includes:
    - Asset manager treasury
    - Whitelisted tokens
    - Management / performance / entry / exit fees
    - Initial portfolio token supply, min holding
    - Public vs private flags
    - Transferability / whitelist flags
    - Name / symbol of the portfolio token.

- **Portfolio contract (per fund)** – the actual *vault/portfolio* primitive
  - Exposes **multi-token** interfaces:
    - `getTokens()` – underlying token list.
    - `totalSupply()` – supply of the portfolio’s ERC20 **portfolio token**.
    - `multiTokenDeposit(...)`, `multiTokenDepositFor(...)` – deposit a basket of tokens.
    - `multiTokenWithdrawal(...)`, `multiTokenWithdrawalFor(...)` – withdraw by burning portfolio tokens and receiving underlying.
    - Emergency withdrawal variants.
  - Holds *multiple tokens directly*; there is no single `asset()` field like ERC4626.
  - NAV / PPS is conceptually:
    ```
    NAV = Σ balances(token_i) * priceUsd(token_i)
    PPS = NAV / totalSupply(portfolioToken)
    ```
    Price logic is primarily off-chain: integrators read `getTokens()` + balances, call price oracles/aggregators off-chain, and compute PPS.

- **Custodial vs Non-custodial portfolios**
  - **Non-custodial**: portfolio is managed directly by an EOA/manager.
  - **Custodial**: a **Gnosis Safe** (Safe) is created and associated with the portfolio.
    - Safe is *just* the multisig wallet / smart account.
    - Portfolio contract + core config handle deposits, withdrawals, fees, etc.

### 1.2 Where deposits/withdrawals + share token live

Critically:

- **Deposits/withdrawals and share accounting DO NOT happen on the Safe itself.**
  - The Safe holds positions and may be the treasury/owner, but it does not define claim tokens or pricing.

- The **Portfolio contract** is the central place where:
  - LPs deposit and withdraw (`multiTokenDeposit`, `multiTokenWithdrawal`).
  - The **portfolio token** (claim token) is minted/burned.
  - Fees are applied.
  - Portfolio composition can be inspected (`getTokens`).

- The Safe is used as a **multisig controller / custody account** for the underlying positions, not as the vault accounting contract.

### 1.3 How venues / strategies are integrated

v4 separates concerns via additional shared contracts:

- **DepositBatch / WithdrawalBatch**
  - Allow complex flows where:
    - User starts with some asset (e.g. ETH or a single token).
    - Off-chain solver/DeFAI OS builds `_callData[]` for swaps/aggregations.
    - `DepositBatch.deposit(...)` or `multiTokenSwapETHAndTransfer(...)` executes swaps and ends with the right mix of tokens in the Portfolio, then calls `multiTokenDeposit`.
  - Similarly, `WithdrawalBatch.withdraw(...)` is used to:
    - Burn portfolio tokens,
    - Execute a series of swaps / flashloan-based operations,
    - Output a desired token to the user.

- **PositionManager + AssetManagementConfig**
  - Handle LP positions (Uniswap V3 / Thena) and other external positions.
  - `AssetManagementConfig` is per-portfolio configuration contract:
    - enables/disables specific managers (e.g. Uniswap V3 manager),
    - configures fees (management, performance, entry, exit),
    - manages whitelist / transferability.

- **Execution model**
  - Heavy logic (route search, flashloan planning) is **off-chain**:
    - off-chain solver builds swap/flashloan calldata for DepositBatch/WithdrawalBatch.
  - On-chain contracts (Portfolio, PositionManager, etc.) verify and execute those calls.

**Key point:**

> Velvet’s Safe is *just* a multisig smart account. Portfolios/vaults are separate contracts that implement share accounting and multi-token deposit/withdrawal. Strategies are wired via external managers and configs.


---

## 2. Our Current v3 Design (BaseVault / Vault4626)

### 2.1 Components

- **`Vault4626` (BaseVault.sol in v3)**
  - Implements `IVault` and extends `ERC20`, `Ownable`, `ReentrancyGuard`.
  - Key fields:
    - `asset` – **single base token** of the vault.
    - `_shareDecimals`, `_assetDecimals`.
    - `core` – ProtocolCore.
    - `usdPricer` – optional USD pricer.
    - `assetsValuer` – optional external valuer (e.g. `VaultTreasury`).
    - Controls: `minSubscriptionAssets`, `lockupSeconds`, `shareTransferable`, `transferFeeBps`.
    - Optional built-in multisig state: `multisigEnabled`, `multisigSigners`, `multisigThreshold`.
  - Core methods:
    - `deposit(assets, receiver)` / `mint(shares, receiver)`.
    - `withdraw(assets, receiver, owner)` / `redeem(shares, receiver, owner)`.
    - `totalAssets()` = idle base in vault + `assetsValuer.assetsOfVault(asset, vault)`.
    - `pricePerShareE18()` / USD helpers.
    - `approveAsset(spender, amount)` / `executeAction(target, data)` for **Core operators**.
    - `userApproveAsset` / `userExecuteAction` for **vault owner**.

- **`VaultTreasury` (v3/treasury)**
  - Per-vault module that:
    - Holds external tokens and simulated lend/borrow state.
    - Implements `IAssetsValuer.assetsOfVault(asset, vault)` to report base-denominated external NAV.
    - Exposes strategy actions:
      - `buyToken`, `sellToken`, `swap`, `swapBaseToToken`, `swapTokenToBase`.
      - `lendBase`, `repayLend`, `borrowBase`, `repayBorrow`.
      - `returnBaseToVault` to send base back when withdrawals need liquidity.

- **`ProtocolCoreV3` (not reproduced here)**
  - Manages:
    - pause (`pauseAll`, `pauseVault`),
    - operator/allowlist (`setVaultOperator`, `setActionAllowlist`, `setActionTarget`),
    - farm/fee registry, TVL caps, etc.

### 2.2 BaseVault as both “vault” and “safe-like” account

In our v3 design, `Vault4626` is intended to play **two roles at once**:

1. **Yield vault (LP-facing)**
   - Users deposit **base asset only**.
   - Vault issues ERC20 shares (LP tokens) representing claim on NAV.
   - Treasury and off-chain bots move capital into other tokens/venues, but `totalAssets()` always returns NAV in base units.
   - NAV0 behavior is sensible here: if NAV == 0, you don’t want to mint arbitrary shares.

2. **Smart-account / Safe-like wallet (owner-facing)**
   - Vault’s `owner` (or multisig) uses `userApproveAsset` / `userExecuteAction` as a **smart-account control surface**.
   - The idea: this one contract can act like a personal vault / smart wallet, performing arbitrary DeFi actions via `executeAction` rather than a separate Safe + portfolio.

However, unlike a Safe:

- `Vault4626` **must have a single base asset** (`asset()`), because it is an ERC4626-style vault.
- Deposits/withdrawals and PPS are all defined in terms of that base asset.
- ERC20 `transfer`s of shares represent economic movement; the share token is not “just metadata”.

So our `Vault4626` is **not** a raw mult-asset Safe; it is a **base-asset vault that we also try to use like a Safe** via the owner/execute hooks.


---

## 3. Base Asset Constraint vs Safe Semantics

### 3.1 Velvet Safe vs our Vault

- **Velvet Safe:**
  - Normal Gnosis Safe / Safe account.
  - Can hold **any tokens in any proportions**.
  - Has no `asset()` or base asset concept baked in.
  - No share token; the Safe is just custody and multisig control.

- **Our `Vault4626`:**
  - ERC4626 vault with a **fixed `asset`**.
  - Deposits and withdrawals are defined exclusively in terms of that `asset`.
  - `totalAssets()` and PPS require valuing everything back into that base asset.

If we try to use `Vault4626` as a **drop-in Safe replacement**:

- Users might expect to:
  - freely send/receive any token to/from the vault address.
  - freely move assets out regardless of current NAV accounting.
- But ERC4626 semantics are stricter:
  - Deposits must be `asset` units.
  - Withdrawals burn shares and pay out `asset` units.
  - `NAV0` / price logic constrains when and how shares can be minted/burned.

This mismatch is the core conceptual problem.

### 3.2 The baseAsset limitation

Some concrete issues:

- **Deposits for non-base tokens**
  - ERC4626 style: you can only `deposit(asset, receiver)`.
  - As a Safe, you might want to “deposit”/hold arbitrary tokens directly.
  - Current workaround: user can direct-transfer arbitrary tokens to the vault, but:
    - They are invisible to ERC4626 `totalAssets()` unless Treasury/valuer accounts for them.
    - They are not part of the normal deposit/withdraw flow.

- **Single base pricing**
  - All external positions (via Treasury) must be projected back to the base asset.
  - This is fine for a yield vault, but unnatural for a pure smart-account wallet that conceptually has “no base, just holdings”.

- **Share token semantics**
  - In a Safe, there is no notion of an ERC20 “share” representing the Safe.
  - In `Vault4626`, shares represent claims on NAV and are transferrable (subject to `shareTransferable`).
  - Using the same contract as a Safe and a yield vault blurs ownership (LPs) and control (vault owner/multisig).


---

## 4. NAV0 Revert vs Multisig / Smart Wallet Behaviour

### 4.1 `NAV0` revert in `convertToShares`

In `Vault4626`:

```solidity
function convertToShares(uint256 assets_) public view override returns (uint256 shares) {
    uint256 supply = totalSupply();
    if (supply == 0) return assets_;
    uint256 ta = totalAssets();
    require(ta > 0, "NAV0");
    return (assets_ * supply) / ta;
}
```

- When `supply > 0` but `totalAssets() == 0`, `convertToShares` reverts with `"NAV0"`.
- In **yield vault mode**, this is reasonable:
  - If NAV is effectively zero while shares still exist, something is deeply wrong (or everything is liquidated). Minting new shares in that state is nonsense.

### 4.2 Problem in multisig / smart-account mode

When we use `Vault4626` as a **smart-account / multisig wallet**:

- Fund owner might:
  - withdraw everything (or move assets to some external address or strategy),
  - then later want to deposit again.
- If `totalSupply()` is non-zero but `totalAssets()` goes to zero (e.g. external positions not reported, or all base moved out via owner actions):
  - `convertToShares` will revert with `NAV0`.
  - That effectively bricks further `deposit`/`mint` flows.

In a raw Safe:

- There is **no NAV or PPS concept**, so:
  - you can always send tokens in and out freely,
  - no `NAV0`-style guard exists.

This illustrates the deeper point:

> A contract that is simultaneously an ERC4626 vault and a Safe-like multisig wallet is logically inconsistent in edge cases. They have different invariants and UX expectations.


---

## 5. Summary of Current Problem

1. **Velvet separation of roles**
   - Safe: multisig smart-account, pure custody.
   - Portfolio (vault) contract: handles deposits/withdrawals, share token accounting, fee logic, portfolio config.
   - External managers/solvers: handle buy/sell/swap/lend/LP via calldata and off-chain planning.

2. **Our merged roles**
   - `Vault4626` is both:
     - an ERC4626 yield vault (LP deposits in a single base asset, PPS based on `totalAssets()` in base), and
     - a pseudo-Safe for the vault owner (via owner-only `userExecuteAction` / multisig support).
   - `VaultTreasury` is a per-vault mini portfolio/valuer module, feeding `totalAssets()`.

3. **Base asset & ERC4626 semantics conflict with Safe-like usage**
   - Single `asset()` field forces everything to be denominated in base asset.
   - Deposits/withdrawals for LPs are constrained to base asset only.
   - Arbitrary token holdings at the vault address are not naturally represented unless Treasury explicitly accounts for them.

4. **NAV0 revert is correct for yield vaults but wrong for pure safes**
   - For a yield/product vault: `NAV0` revert prevents nonsense minting when NAV is zero.
   - For a Safe-like wallet: users expect to always be able to “deposit” even if the wallet currently has zero value.
   - Using `Vault4626` in both roles means one of these expectations will be violated.

5. **Conclusion of problem statement**
   - Our current v3 design tries to make a **single contract behave both as:**
     - an ERC4626-compliant yield vault (LP-facing), **and**
     - a Safe-like smart-account/multisig wallet (owner-facing).
   - Velvet’s infra shows a cleaner separation:
     - Safe as pure multisig,
     - Portfolio contract as vault/token accounting,
     - external management contracts handling venues/strategies.
   - To avoid conceptual and UX issues (base asset limitation, NAV0 revert, LP vs owner semantics), we likely need to:
     - either separate these roles in our own design (Safe/smart-account vs Vault), or
     - clearly scope `Vault4626` to one role and design a different primitive for the other.

This doc is meant as context for future redesign work on v3 vaults and smart-account integration.
