# Rewards, Payouts & Claims

## Harvest & Split

- Trigger: `BaseFarm.harvest()`
  - Realizes base asset from strategies: `router.harvest()`.
  - Computes streamed vs compounded portions via `payoutPolicy.onHarvest(netBase)`.
  - If `streamed == 0`, all remains in farm, increasing price per share.
  - Otherwise, streamed portion is split per `StakeholderRegistry` bps:
    - Owner share -> subject to protocol rake using `ShareToken.protocolFeeReceiver()` and `protocolRakeBps()`.
    - Verifier share -> streamed to active verifiers.
    - LP share -> retained inside farm as idle, benefiting LPs via PPS.
  - Stream accrual: farm transfers streamed base to `PayoutPolicy` and calls `accrueFor(beneficiary, amount)` per beneficiary.

- Rate limiting: `BaseFarm.harvestIfNeeded()` enforces `minHarvestInterval` from `PayoutPolicy.getConfig()`.

## Payout Streaming & Claiming

- `PayoutPolicy` state: per-beneficiary `Stream { total, claimed, start, end }` and an `unlocked` bucket.
- On each accrual, vested amount from prior stream is moved to `unlocked`, then a new window `[now, now+epoch]` is set.
- Claiming: `PayoutPolicy.claim(to)` transfers available `unlocked + vested` base asset to `to`.

### PayoutPolicy APIs (from `IPayoutPolicy`)

- `getConfig() -> Config { mode, streamBps, compoundBps, epoch, minHarvestInterval, compoundLpOnLock }`.
- `onHarvest(netBase) -> (streamed, compounded)` — called by farm on harvest.
- `accrueFor(beneficiary, amount)` — records a new stream for the beneficiary.
- `claimable(account) -> uint256` — view function for accrued amount.
- `claim(to) -> amount` — claim available funds.
- `lastHarvestAt() -> uint256` — timestamp used by `BaseFarm.harvestIfNeeded()`.

## Lockups & Penalties

- Deposits: `LockupPolicy.onDeposit(account, assets)` starts/refreshes `[start, end]` if enabled.
- Withdrawals: `LockupPolicy.enforceWithdrawal(account, assets)` returns penalty if early; `BaseFarm._withdraw` subtracts penalty and keeps it in the farm, improving PPS for remaining LPs.

## Consensus Influence

- Verifier approvals and consensus are managed in `ProtocolCore` and `Consensus.sol`. Farm reward streaming targets the active verifiers fetched via `StakeholderRegistry.activeVerifiers()`.
