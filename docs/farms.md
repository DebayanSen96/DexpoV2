# Farms: Creation & Customization

## Creation Flow

- Entry point: `ProtocolCore.createApprovedFarm(...)` deploys a v3 farm using `FarmFactory.createFarmStack(...)`.
- `FarmFactory` wires the stack and transfers ownership to the farm owner:
  - Deploys clones for `StrategyRouter`, `LockupPolicy`, `PayoutPolicy`, `StakeholderRegistry`, and `BaseFarm`.
  - Sets router/payout/lockup/registry on `BaseFarm` and authorizes `router.setFarm(baseFarm)` and `payout.setFarm(baseFarm)`.
  - Configures registry splits and optional owner recipient.
  - Configures `ShareToken` while factory is owner: `setTransferable`, `setTransferFeeBps`, `setFeeReceiver`, `setProtocolFee` then transfers token ownership to farm owner.
  - Registers farm with `ProtocolCore.registerFarm(owner, baseFarm, farmId)`.

## Configuration Objects

- LockupConfig (`ILockupPolicy.LockConfig`): `enabled`, `allowEarlyExit`, `earlyExitBps`, `lockupSeconds`, `postLockMode`.
- PayoutConfig (`IPayoutPolicy.Config`): `mode` (Stream/Lockup), `streamBps`, `compoundBps`, `epoch`, `minHarvestInterval`, `compoundLpOnLock`.
- ShareTokenConfig: `transferable`, `transferFeeBps`, `feeReceiver`, `protocolFeeReceiver`, `protocolRakeBps`.
- Strategy allocations: `router.setAllocations(adapterKeys, adapterAddrs, adapterBps)` bps must sum to 10_000.

## Factory Parameters (`IFarmFactory.createFarmStack`)

From `contracts/v3/interfaces/IFarmFactory.sol`:

- `asset`
- `farmName`
- `farmSymbol`
- `core`
- `farmId`
- `owner`
- `ownerRecipient`
- `lpBps`
- `ownerBps`
- `verifierBps`
- `lockCfg` (see `ILockupPolicy.LockConfig`)
- `payoutCfg` (see `IPayoutPolicy.Config`)
- `stCfg` (`ShareTokenConfig`)
- `adapterKeys`
- `adapterAddrs`
- `adapterBps`

## Customization & Operations

- Rebalance targets: `BaseFarm.rebalance()` -> `StrategyRouter.rebalance()` (MVP changes targets only).
- Allocate/Deallocate: `BaseFarm.allocateToStrategies(amount)`, `BaseFarm.deallocateFromStrategies(amount)`.
- Module updates: First set allowed by farm owner or protocol owner; subsequent changes must be by `ProtocolCore` owner. See `BaseFarm.setStrategyRouter()`, `setPayoutPolicy()`, `setLockupPolicy()`, `setStakeholderRegistry()`.
- Share token controls (by token owner): transferability, transfer fee, rake distribution caps (`MAX_TRANSFER_FEE_BPS`=15%, `MAX_PROTOCOL_RAKE_BPS`=20%).
