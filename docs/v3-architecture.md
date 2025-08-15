# Dexponent v3 Architecture

This document defines a modular, per‑farm configurable architecture addressing customizability, compounding, flexible rewards, NAV‑based claim tokens, and robust external protocol integrations.

## Goals

- __Per‑farm customization__: splits, payout mode, lockups, transfer fees, strategies.
- __Share/NAV accounting__: ERC‑4626‑like shares, no fixed 1:1 claim tokens.
- __Streaming + lockup/compounding__: owner/verifier streamed; LP can stream or compound post lockup.
- __Strategy abstraction__: adapters for Lido/Aave with a router supporting allocations and rebalancing.
- __Scalable payouts__: epoch‑based streaming with pull claims; no global loops.
- __Owner operations__: allocate, rebalance, harvest, pause, emergency exit, parameter updates.
- __Safety & observability__: reentrancy guards, pausability, caps; detailed view functions.

## High‑level components

- __Vault (per farm)__: ERC‑4626‑like vault that mints/burns shares and owns assets.
- __ShareToken__: ERC20 shares with optional transferability and fee (≤15%) routed to owner with protocol rake.
- __StrategyRouter__: routes funds across multiple protocol adapters with target bps and rebalancing.
- __StrategyAdapters__: Lido/Aave first; unified interface for deposit/withdraw/harvest/TVL.
- __PayoutPolicy__: streaming and lockup/compounding logic; pull‑based claims.
- __LockupPolicy__: per‑depositor lock/penalty rules applied on withdraw/redeem.
- __StakeholderRegistry__: per‑farm splits and recipients; verifiers sourced via `Consensus.sol`.
- __Oracle/LM__: price oracle for NAV normalization; `ILiquidityManager` for swaps.
- __FactoryV2__: deploys configured farms from payloads; enforces whitelists and caps.
- __ProtocolCoreV2__: global protocol fee receiver, module/adapters whitelist, safety limits, optional hooks.

## Contract layout (proposed)

- `contracts/v3/core/ProtocolCoreV2.sol`
- `contracts/v3/factory/FarmFactoryV2.sol`
- `contracts/v3/vault/BaseVault.sol`
- `contracts/v3/tokens/ShareToken.sol`
- `contracts/v3/modules/PayoutPolicy.sol`
- `contracts/v3/modules/LockupPolicy.sol`
- `contracts/v3/modules/StakeholderRegistry.sol`
- `contracts/v3/strategies/StrategyRouter.sol`
- `contracts/v3/strategies/adapters/LidoStakingAdapter.sol`
- `contracts/v3/strategies/adapters/AaveLendingAdapter.sol`
- `contracts/v3/interfaces/*.sol` (see Interfaces)

Keep v2 contracts intact; v3 is additive and isolated.

## Interfaces (abridged)

- __IBaseVault__
  - `asset() view returns (address)`
  - `totalAssets() view returns (uint256)`
  - `convertToShares(uint256) view returns (uint256)` / `convertToAssets(uint256)`
  - `deposit(uint256 assets, address receiver) returns (uint256 shares)`
  - `withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)`
  - `mint(uint256 shares, address receiver)` / `redeem(uint256 shares, address receiver, address owner)`
  - Admin: `setPolicies(...)`, `pause()`, `unpause()`

- __IShareToken__
  - `setTransferable(bool)`
  - `setTransferFeeBps(uint16)`; `setFeeReceiver(address)`

- __IPayoutPolicy__
  - Config: `setMode(mode, params)` where `mode ∈ {Stream, Lockup}`
  - Hook: `onHarvest(uint256 netBase)` returns `(streamed, compounded)`
  - Claim: `claimable(address) view` / `claim(address to)`

- __ILockupPolicy__
  - `setLockup(lockupSeconds, allowEarlyExit, earlyExitBps, postLockMode)`
  - `onDeposit(account, assets)`
  - `enforceWithdrawal(account, assets)` returns `penalty`

- __IStakeholderRegistry__
  - `setSplits(lpBps, ownerBps, verifierBps)`
  - `getSplits() view` / `getOwnerRecipient() view`
  - `activeVerifiers() view returns (address[])`

- __IStrategyRouter__
  - `allocations() view returns (bytes32[] ids, address[] adapters, uint16[] bps)`
  - `setAllocations(...)` (sum == 10000)
  - `allocate(uint256 amount)` / `deallocate(uint256 amount)`
  - `rebalance(uint16[] targetBps)`
  - `harvest() returns (uint256 baseReturned)`
  - `totalAssets() view returns (uint256)`

- __IStrategyAdapter__
  - `asset() view returns (address)`
  - `deposit(uint256 amount, bytes params)`
  - `withdraw(uint256 amount, bytes params) returns (uint256 received)`
  - `harvest() returns (uint256 baseDelta, address[] rewardTokens, uint256[] rewardAmts)`
  - `totalAssets() view returns (uint256)`

- __IPriceOracle__ (optional, or reuse LM quoting)
  - `quote(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)`

## Configuration payloads (examples)

- __Staking template (Lido)__
```json
{
  "template": "staking",
  "asset": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  "name": "ETH Staking Vault",
  "symbol": "stETHx",
  "payoutPolicy": { "mode": "stream", "streamBps": 7000, "compoundBps": 3000, "epoch": 604800, "minHarvestInterval": 86400 },
  "lockupPolicy": { "enabled": false, "allowEarlyExit": true, "earlyExitBps": 50, "lockupSeconds": 0 },
  "splits": { "lpBps": 9000, "ownerBps": 800, "verifierBps": 200 },
  "adapters": [ { "id": "LIDO", "addr": "0xAdapterLido", "bps": 10000, "params": "0x" } ],
  "ownerControls": { "transferableShares": true, "shareTransferFeeBps": 0 }
}
```

- __Lending template (Aave; 60/40)__
```json
{
  "template": "lending",
  "asset": "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "name": "USDC Lending Vault",
  "symbol": "usdclendX",
  "payoutPolicy": { "mode": "lockup", "compoundLp": true, "epoch": 604800, "minHarvestInterval": 3600 },
  "lockupPolicy": { "enabled": true, "allowEarlyExit": false, "earlyExitBps": 0, "lockupSeconds": 2592000 },
  "splits": { "lpBps": 9200, "ownerBps": 700, "verifierBps": 100 },
  "adapters": [
    { "id": "AAVE-P1", "addr": "0xAdapterAaveV3Pool1", "bps": 6000, "params": "0x" },
    { "id": "AAVE-P2", "addr": "0xAdapterAaveV3Pool2", "bps": 4000, "params": "0x" }
  ],
  "ownerControls": { "transferableShares": true, "shareTransferFeeBps": 100 }
}
```

Factory validates sums, caps, and module whitelists; emits the full config for indexing.

## Lifecycle flows

- __Create farm__
  - `FarmFactoryV2.create(payload)` → deploy `BaseVault`, `ShareToken`, `StrategyRouter`, modules; wire addresses; record farmId; emit `FarmCreated` with config.

- __Deposit / Mint__
  - User deposits base `asset` → mints shares using `pps = totalAssets / totalSupply`.
  - `LockupPolicy.onDeposit` records locks if enabled.

- __Harvest__
  - Keeper/owner calls `StrategyRouter.harvest()` after `minHarvestInterval`.
  - Rewards normalized to base via `ILiquidityManager`; net base returned to vault.
  - `PayoutPolicy.onHarvest(netBase)` splits into `streamed` vs `compounded`. Owner/verifier streamed; LP per mode.

- __Streaming claims__
  - Tranches for recipients accrue linearly over each epoch. Recipients call `claim(to)`.

- __Compounding__
  - LP compounded portion increases vault assets; next `rebalance()` allocates to adapters → PPS rises.

- __Withdraw / Redeem__
  - `LockupPolicy.enforceWithdrawal` applies penalties/blocks; early‑exit penalty distributed per farm rules and protocol rake.

- __Rebalance__
  - Owner updates target bps; router migrates with slippage limits; events emitted for analytics.

- __EmergencyExit__
  - Pulls funds to idle; deposits paused; withdrawals may remain open.

## Accounting & NAV

- `totalAssets()` = idle base + Σ adapter `totalAssets()` (normalized) + pending base from last harvest (held by vault) − streaming escrow (already set aside).
- PPS = `totalAssets / totalSupply`.
- Adapters must not overstate NAV; use oracle/LM quotes with sanity bounds.

## Reward distribution

- Splits per farm: `lpBps`, `ownerBps`, `verifierBps` (sum = 10000; caps enforced).
- Streaming implementation: one tranche per recipient per harvest epoch; pull‑based claims.
- Lockup: LP portion either compounded or held in `pendingLpRewards` (tracked via reward‑per‑share index) until lock expires.
- Protocol rake: applied to owner streamed rewards and share transfer fees; sent to `ProtocolCoreV2.protocolOwner()`.

## Stakeholders & verifiers

- LPs: implicit via share balances; proportional rewards via indices.
- Owner: single wallet or split recipients via `StakeholderRegistry`.
- Verifiers: pulled from `Consensus.sol` for `farmId` and optionally score‑weighted. Snapshot per epoch to prevent mid‑epoch churn.

## External protocol adapters

- Adapters encapsulate integration:
  - Lido: deposit/withdraw stETH; `totalAssets()` converts stETH→ETH via oracle.
  - Aave: manage aTokens and incentives; `harvest()` returns base asset after swapping incentives.
- Router normalizes adapter valuations and provides a single `totalAssets()`.

## Owner controls & safeguards

- Roles: `OWNER_ROLE`, optional `GUARDIAN_ROLE`, `KEEPER_ROLE`.
- Guards: `Pausable`, `ReentrancyGuard`, slippage checks, per‑tx and per‑day limits.
- Config updates: splits, lockup, transferability/fee, allocations, min harvest interval, adapter params.

## Security

- No external calls in state‑inconsistent windows; checks‑effects‑interactions.
- Pull over push for streaming claims.
- Snapshot verifiers per epoch; handle empty lists by routing to protocol or owner as configured.
- Emergency exit path tested; NAV cannot drift due to accounting invariants and oracle sanity.

## ProtocolCoreV2 role

- Stores protocol fee receiver and rake bps.
- Whitelists adapters/modules and their versions.
- Optional hooks for analytics: `onHarvest`, `onFeeTaken`.
- Does NOT perform per‑farm distribution.

## Migration

- Keep v2 farms operational.
- Deploy v3 factory/core and new farms alongside v2.
- Optionally add bridge/shims for migrating LPs by redeeming v2 claim tokens and depositing into v3 vaults.

## Open questions

- Verifier weighting: equal split vs score‑weighted? Configure per farm.
- Oracle source(s): reuse LM quotes vs dedicated oracle contracts.
- Transfer fee on shares: default off; enable only if necessary for farm economics.
