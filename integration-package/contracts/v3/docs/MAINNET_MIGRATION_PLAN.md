# Mainnet Migration Plan for Dexpo V3 Infrastructure

## 1. Executive Summary
The current V3 infrastructure relies heavily on mocked interfaces (`IMockSwapRouter`, `UsdPricerMock`) and simulated logic (internal accounting for lending/borrowing) suitable for testnet simulations. Migrating to mainnet requires replacing these mocks with production-grade integrations (Chainlink, Uniswap/1inch, Aave/Morpho, SSV Network), hardening security parameters (slippage, RBAC), and establishing robust operational procedures.

## 2. Infrastructure & Core Components

### 2.1. Protocol Core & Access Control
- **Current State:** `ProtocolCore` is owned by an EOA (Externally Owned Account) in tests.
- **Migration Action:**
  - Deploy `ProtocolCore` ownership to a **Safe (Gnosis) Multisig**.
  - Define strictly typed roles in `AccessControl` if granular permissions are needed beyond simple ownership.
  - **Action Item:** Verify `IProtocolCoreOwnable` integration across all modules to ensure they correctly respect the new Multisig owner.

### 2.2. Module Registry
- **Current State:** `ModuleRegistry` stores addresses of modules.
- **Migration Action:**
  - Make `ModuleRegistry` immutable or time-locked for critical module updates to prevent rug-pull vectors.
  - Ensure `ModuleRegistry` ownership is transferred to the Protocol Multisig.

## 3. External Integrations (Mock Replacement)

### 3.1. Oracles (Critical)
- **Current State:** `UsdPricerMock` uses manually set prices.
- **Migration Action:**
  - **Primary:** Integrate **Chainlink Data Feeds** for all supported assets.
  - **Secondary:** Implement Uniswap V3 TWAP as a fallback or validation check to prevent oracle manipulation.
  - **Implementation:** Create a `ChainlinkOracleAdapter` implementing a standard price interface.
  - **Impact:** Updates `IndexSwap.sol` (`_getTokenValueUsd`), `VaultTreasury.sol`, and Position Modules.

### 3.2. Swap Infrastructure
- **Current State:** `IMockSwapRouter` handles both pricing and infinite liquidity swaps.
- **Migration Action:**
  - **Routing:** Integrate with a Swap Aggregator (e.g., **1inch** or **Paraswap**) or **Uniswap V3 Router** directly for execution.
  - **Slippage:** Hardcode or dynamically calculate slippage protection. The current `swapFrom` lacks explicit `amountOutMinimum` in many calls sites (relying on the mock's return).
  - **Impact:** Updates `IndexSwap.sol`, `SwapModule.sol`, `BuySellModule.sol`.

### 3.3. Lending & Borrowing
- **Current State:** `LendModule` and `BorrowModule` simulate positions with internal `positions` mapping and fixed APRs.
- **Migration Action:**
  - **Integration:** Build specific adapters for **Aave V3** (Pool address provider) or **Morpho Blue**.
  - **Logic:** Map `lend()` to `supply()` and `borrow()` to `borrow()`.
  - **Rewards:** Handle potential reward tokens (e.g., AAVE emission) which are currently ignored.
  - **Impact:** Rewrite `LendModule.sol` and `BorrowModule.sol` to wrap external protocols.

### 3.4. Staking (SSV Network)
- **Current State:** `StakingModule` interacts with SSV interfaces.
- **Migration Action:**
  - **Addresses:** Update `SSVNetwork`, `DepositContract`, and `SSVToken` addresses to their Mainnet values.
  - **Parameters:** Verify `STAKING_THRESHOLD` (32 ETH) and operational fees.
  - **Cluster Management:** Ensure operator IDs and cluster snapshots are valid for Mainnet.

## 4. Contract-Specific Remediation

### 4.1. IndexSwap.sol
- **Oracle Dependency:** Remove `IMockSwapRouter.priceUsdE18`. Inject `IOracle` interface.
- **Swap Logic:** Update `_rebalanceDeficit` and `_rebalanceSurplus` to accept slippage parameters or calculate them on-chain using the Oracle price + acceptable variance.
- **Native ETH:** Ensure `withdrawNative` and `depositNative` handle gas limits correctly (avoid `transfer` vs `call` pitfalls, though `call` is currently used which is good).
- **Initialization:** Ensure `lockupSeconds` is reasonable for Mainnet (e.g., not 0 unless intended).

### 4.2. VaultTreasury.sol
- **Valuation:** `assetsOfVault` currently trusts `IMockSwapRouter` for quotes.
  - **Fix:** Use the new `IOracle` for reliable asset valuation in base currency.
- **Tracking:** Ensure `trackedTokens` list doesn't grow unbounded (DOS vector).

### 4.3. Modules
- **BuySell/Swap:** Add `amountOutMin` parameters to `buyToken`, `sellToken`, and `swap` functions to prevent sandwich attacks.
- **Lend/Borrow:** Completely replace storage-based simulation with external calls. Remove `defaultAprBps`.

## 5. Security & Operations Checklist

- [ ] **Slippage Protection:** All swap functions MUST have an `amountOutMin` parameter derived from a trusted oracle or passed by the caller.
- [ ] **Reentrancy:** Verify `nonReentrant` usage on all external calls (already present in `IndexSwap`, verify modules).
- [ ] **ERC20 Compatibility:** Ensure support for USDT (non-standard approve) and fee-on-transfer tokens (if supported, otherwise block them).
- [ ] **Emergency Pause:** `ProtocolCore` has pausing, but verify it cascades correctly to all modules.
- [ ] **Gas Optimization:** `TokenWeight[]` loops in `IndexSwap` could be expensive if portfolio is large. Limit max portfolio size (e.g., 10-20 tokens).

## 6. Deployment Strategy

1.  **Stage 1: Core & Registry**
    - Deploy `ProtocolCore` (Multisig controlled).
    - Deploy `ModuleRegistry`.

2.  **Stage 2: Infrastructure Adapters**
    - Deploy `ChainlinkOracleAdapter`.
    - Deploy `UniswapV3Adapter` / `OneInchAdapter`.
    - Deploy `AaveV3Adapter` (replacing mock Lend/Borrow modules).

3.  **Stage 3: Factories & Modules**
    - Deploy `StakingModule` (linked to real SSV).
    - Deploy `IndexSwapFactory`.

4.  **Stage 4: Verification**
    - Etherscan verification for all contracts.
    - Tenderly simulation of full lifecycle (Deposit -> Invest -> Rebalance -> Withdraw).

## 7. Immediate Next Steps
1.  Create `contracts/v3/oracles/ChainlinkOracle.sol`.
2.  Refactor `IndexSwap.sol` to use `IOracle` instead of `swapRouter` for pricing.
3.  Rewrite `LendModule.sol` to interface with Aave V3.
