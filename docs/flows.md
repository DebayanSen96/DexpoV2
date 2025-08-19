# End-to-end Flows

## Deposit (LP)

1. User calls `BaseFarm.deposit(assets, receiver)`.
2. Assets transferred to farm; `LockupPolicy.onDeposit(receiver, assets)` starts lock if enabled.
3. Shares minted: `ShareToken.mint(receiver, shares)` with `shares = convertToShares(assets)`.

## Withdraw/Redeem (LP)

1. User calls `BaseFarm.withdraw(assets, receiver, owner)` or `redeem(shares, receiver, owner)`.
2. `ShareToken.burn(owner, shares)`.
3. `LockupPolicy.enforceWithdrawal(owner, assets)` returns penalty if early.
4. If idle < needed, `router.deallocate(shortfall)` is called to pull funds.
5. Farm transfers `assets - penalty` to receiver.

## Harvest & Payout

1. Operator calls `BaseFarm.harvest()` (or `harvestIfNeeded`).
2. `router.harvest()` forwards realized base asset to farm.
3. `payoutPolicy.onHarvest(netBase)` returns `(streamed, compounded)`.
4. Farm splits `streamed` using `StakeholderRegistry.getSplits()`.
5. Protocol rake applied on owner portion using `ShareToken.protocolFeeReceiver()` and `protocolRakeBps()`.
6. Farm funds `PayoutPolicy` and calls `accrueFor(beneficiary, amount)` per beneficiary.
7. Beneficiaries call `PayoutPolicy.claim(to)` to receive vested+unlocked base asset.

## Router Allocate/Deallocate

- `BaseFarm.allocateToStrategies(amount)` -> Router pulls from farm and deposits across adapters per bps.
- `BaseFarm.deallocateFromStrategies(amount)` -> Router withdraws from adapters and forwards to farm.
