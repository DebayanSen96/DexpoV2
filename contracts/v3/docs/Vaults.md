# Dexponent v3 Vaults (Unified: Wallets + Yield Farms)

This guide documents the unified vault pattern and the updated, Core‑driven deployment flow.

- Vault: `contracts/v3/vault/BaseVault.sol` (contract `Vault4626`)
- Protocol Core: `contracts/v3/core/ProtocolCoreV3.sol` (or `contracts/ProtocolCore.sol` in testnet stack)
- Factory: `contracts/v3/factories/VaultFactory.sol`
- Treasury (optional valuer): `contracts/v3/treasury/VaultTreasury.sol`
- USD pricer (optional): project‑specific or mock

## TVL and Price-Per-Share
- **TVL (base)**: `totalAssets()`
  - `idle = IERC20(asset).balanceOf(vault)`
  - `external = IAssetsValuer(assetsValuer).assetsOfVault(asset, vault)` (optional, 0 if unset)
  - `TVL = idle + external`
- **Price per share (base)**: `pps = totalAssets * 1e18 / totalSupply`
- **TVL (USD)**: `totalAssetsUsdE18 = totalAssets * priceUsdE18(asset) / 10**dec(asset)`
- **Price per share (USD)**: `ppsUsd = pps * priceUsdE18(asset) / 10**dec(asset)`
- **Events**: `TvlUpdated(totalAssets)` emitted on deposit/mint/withdraw/redeem.

## Approval & Action Execution Flow
- Off‑chain orchestrators use ProtocolCore roles to operate vaults.
- **approveAsset(spender, amount)**: only callable by Core Owner or authorized operators (via ProtocolCore).
- **executeAction(target, data)**: only callable by Core Owner or authorized operators.
  - ProtocolCore may enable a per‑vault action allowlist. If enabled, `target` must be allowed.
  - Reverts if ProtocolCore is globally paused or the vault is paused.

Flow:
1. Protocol ops set roles on `ProtocolCoreV3`.
2. Ops call `Vault4626.approveAsset` to give DEX/staking contracts allowance.
3. Ops call `Vault4626.executeAction(target, abi.encodeWithSignature(...))` to execute swaps/staking/spot.
4. After external position changes, `assetsValuer` (optional) is used to include deployed assets in TVL.

## Events and Indexing
- `TvlUpdated(uint256 totalAssets)` on state‑changing share flows.
- `ActionExecuted(address target, bytes data, bytes result)` for off‑chain reconciliation.
- `AssetApproval(address spender, uint256 amount)` when updating ERC20 allowances.
- Factory: `VaultCreated(address vault, address asset, uint256 farmId)` for discovery.

## Roles, Pause, Allowlists (ProtocolCoreV3)
- Roles: `isExecutor`, `isGuardian` (owner can manage).
- Global pause: `pauseAll(true/false)`; per‑vault pause: `pauseVault(vault, true/false)`.
- Operator allowlist: `setVaultOperator(vault, operator, allowed)`.
- Action allowlist: `setActionAllowlist(vault, enabled)` and `setActionTarget(vault, target, allowed)`.
- Compatibility: keeps `IProtocolCoreV3` for farm rules & fee reporting.

## Recent Additions (Vault4626)
- **Min subscription**: `minSubscriptionAssets` enforced on `deposit`/`mint`.
- **Simple lockup**: `lockupSeconds` enforced on `withdraw`/`redeem` using per‑user `lastDepositTs`.
- **Owner shortcuts for smart wallets**:
  - `userApproveAsset(spender, amount)`
  - `userExecuteAction(target, data)`
  - These are `onlyOwner`, respect Core pause/allowlist, and mirror operator flows.
- **Share token policy**:
  - `shareTransferable` (on/off transfer gate for the ERC20 share token)
  - `transferFeeBps` (0..2000 bps) — fee taken on transfers and sent to `owner()`
  - `decimals()` is configurable per vault via `shareDecimals` at deploy

### Getters
- `getLockupConfig() -> (enabled, seconds)`
- `getUserPosition(user) -> (lastDeposit, lockedUntil)`

## Migration Guidance
- New deployments should prefer `Factory.createVault(...)` over legacy `createFarmStack(...)`.
- Off‑chain routes now handle all strategy logic. Remove on‑chain adapters/routers from new flows.
- If you need NAV of non‑held positions, deploy an `assetsValuer` per vault and set via `setAssetsValuer(valuer)`.
- If you require USD displays, deploy `UsdPricerMock` (or your pricer) and set via `setUsdPricer(pricer)`.

## Examples

### Deposit / Mint / Withdraw / Redeem
- Deposit assets and mint shares to receiver:
```solidity
vault.deposit(assets, receiver);
```
- Mint exact shares to receiver, paying the required assets:
```solidity
vault.mint(shares, receiver);
```
- Withdraw exact assets to receiver, burning shares from owner:
```solidity
vault.withdraw(assets, receiver, owner);
```
- Redeem exact shares to assets, sending to receiver:
```solidity
vault.redeem(shares, receiver, owner);
```

### Execute Actions (swap, stake, spot)
- Swap via whitelisted 0x/DEX target:
```solidity
bytes memory data = abi.encodeWithSignature(
  "sellTokenForToken(address,address,uint256,uint256,bytes)",
  tokenIn, tokenOut, amountIn, minOut, dexData
);
vault.executeAction(whitelistedDex, data);
```
- Stake into a staking contract:
```solidity
bytes memory data = abi.encodeWithSignature("stake(uint256)", amount);
vault.approveAsset(stakingContract, amount);
vault.executeAction(stakingContract, data);
```
- Place a spot order on a venue:
```solidity
bytes memory data = abi.encodeWithSignature(
  "placeOrder(address,uint256,uint256,uint8)", token, size, limitPrice, side
);
vault.executeAction(venue, data);
```

### Core‑Driven Deployment (ProtocolOwner)
```solidity
// 1) Deploy ProtocolCore and wire VaultFactory once
core.setVaultFactory(vaultFactory);

// 2) (Optional) Deploy Treasury and set router/rates
// treasury = new VaultTreasury(core, owner, asset, router);

// 3) Create vault via Core (owner can be EOA or multisig)
address vault = core.createVaultViaCore(
  asset,
  "My Vault",
  "MVSH",
  ownerEoa,               // vault owner (EOA or multisig)
  farmId,                 // registry id
  usdPricer,              // optional
  address(treasury),      // optional assets valuer
  minSubscriptionAssets,  // e.g., 10e6 for USDC
  lockupSeconds,          // e.g., 30 days
  shareTransferable,      // true for LP shares, false for smart wallets
  transferFeeBps,         // 0..2000; applied on transfers, sent to vault owner
  shareDecimals           // e.g., 18 or token‑matching
);

// 4) Bind Treasury once (called by Treasury owner)
// treasury.setVaultOnce(vault);

// 5) Roles & allowlists (optional)
core.setExecutor(executor, true);
core.setActionAllowlist(vault, true);
core.setActionTarget(vault, address(treasury), true);
```

Notes:
- Treasury is optional; attach only if you use external positions you want reflected in `totalAssets()`.
- For smart wallets without external positions, you may skip Treasury initially.

## On‑chain Configurables (who can call)
- **Protocol owner (deployment via Core)**
  - `createVaultViaCore(asset, name, symbol, ownerEoa, farmId, usdPricer, assetsValuer, minSubscriptionAssets, lockupSeconds, shareTransferable, transferFeeBps, shareDecimals)`
    - Creates a new vault through `VaultFactory` and applies initial config.
- **Vault owner (EOA or multisig)**
  - `setUsdPricer(pricer)`
  - `setAssetsValuer(valuer)`
  - `setMinSubscriptionAssets(minAssets)`
  - `setLockupSeconds(seconds_)`
  - `setShareTransferable(bool)`
  - `setTransferFeeBps(uint16)`
  - `userApproveAsset(spender, amount)`
  - `userExecuteAction(target, data)`
- **Core owner / Operators (via ProtocolCoreV3 roles)**
  - `approveAsset(spender, amount)`
  - `executeAction(target, data)`
  - Core policy: `pauseAll`, `pauseVault`, `setVaultOperator`, `setActionAllowlist`, `setActionTarget`, `setTvlCap`

## Smart Wallets vs Yield Farms
- **Smart Wallets (owner‑operated)**
  - Set `owner` to the user EOA or to a multisig contract.
  - Use `userApproveAsset`/`userExecuteAction` for owner‑initiated actions.
  - Attach Treasury only if you need swaps/lending and NAV reflection; otherwise omit.

- **Yield Farms (operator‑run)**
  - Core operators use `approveAsset`/`executeAction` with allowlists and pause controls.
  - Attach Treasury at deploy to track external NAV and enable actions.

## On‑chain Reads (summary)
- Vault: `asset`, `totalAssets`, `pricePerShareE18`, `totalAssetsUsdE18`, `decimals/symbol/name`.
- Lockup/MinSub: `getLockupConfig`, `getUserPosition`, `minSubscriptionAssets`.
- Share token policy: `shareTransferable`, `transferFeeBps`.
- Treasury: `getCachedUsd`, `trackedTokens(i)`, `trackedTokenCount`, `lendPrincipal/borrowPrincipal`, `lendAprBps/borrowAprBps`, `lastAccrualTs`.
