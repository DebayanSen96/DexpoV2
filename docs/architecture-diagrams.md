# Architecture Diagrams (Text)

## Farm Stack (v3)

```
ProtocolCore
   ├─ owns FarmFactory
   ├─ approves verifiers, asserts farm config, records consensus, registers farms
   └─ receives protocol rake reports

FarmFactory.createFarmStack()
   ├─ BaseFarm (vault)
   │    ├─ ShareToken (per farm)
   │    ├─ StrategyRouter
   │    ├─ PayoutPolicy
   │    ├─ LockupPolicy
   │    └─ StakeholderRegistry
   └─ Wires modules + transfers ownership to farm owner
```

## Harvest & Payout Flow

```
[Operator]
   └─ BaseFarm.harvest()
        ├─ router.harvest() -> base assets to BaseFarm
        ├─ payoutPolicy.onHarvest(net)
        │     ├─ streamed
        │     └─ compounded (retained => PPS ↑)
        ├─ stakeholderRegistry.getSplits() -> owner/verifier bps
        ├─ Apply ShareToken.protocolRakeBps() on owner portion
        ├─ Transfer streamed to PayoutPolicy
        │     ├─ accrueFor(ownerRecipient, ownerNet)
        │     ├─ accrueFor(protocolFeeReceiver, protocolCut)
        │     └─ accrueFor(verifiers[i], each)
        └─ LP streamed portion retained in farm (PPS ↑)
```

## Deposit / Withdraw

```
Deposit
  user -> BaseFarm.deposit(assets, recv)
       ├─ transfer base asset in
       ├─ lockupPolicy.onDeposit(recv, assets)
       └─ shareToken.mint(recv, shares)

Withdraw/Redeem
  user -> BaseFarm.withdraw/redeem
       ├─ shareToken.burn(owner, shares)
       ├─ lockupPolicy.enforceWithdrawal(owner, assets)
       ├─ router.deallocate(shortfall) if needed
       └─ transfer (assets - penalty)
```
