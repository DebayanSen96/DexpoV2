# Dexponent v3 Vault Architecture (ERC‑4626‑inspired)

This document describes the minimal vault pattern replacing farm+router+adapters for new deployments.

- Vault contract: `reference/v3/vault/BaseVault.sol` (contract `Vault4626`)
- Protocol control: `reference/v3/core/ProtocolCoreV3.sol`
- Factory support: `reference/v3/factories/FarmFactory.sol` → `createVault(...)`
- Pricing (optional): `reference/v3/oracles/UsdPricerMock.sol`

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

### Factory & Core Setup (Hardhat pseudo)
```solidity
// 1) Deploy ProtocolCoreV3 with protocol operator as owner
core = await (await ethers.getContractFactory("ProtocolCoreV3")).deploy(operator);

// 2) Deploy FarmFactory bound to core
factory = await (await ethers.getContractFactory("FarmFactory")).deploy(core, address(0));

// 3) Deploy a new vault
vault = await (await ethers.getContractFactory("Vault4626")).attach(
  await (await factory.createVault(asset, "My Vault", "MVSH", core, 1)).wait()
);

// 4) Roles & allowlists
await core.setExecutor(executor, true);
await core.setActionAllowlist(vault, true);
await core.setActionTarget(vault, whitelistedDex, true);
```

Notes:
- The vault owner is `ProtocolCoreV3`. Authorized operators are controlled by core.
- All strategy decisions live off‑chain; vault remains strategy‑agnostic.
