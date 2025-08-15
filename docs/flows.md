# Lifecycle Flows

Key end-to-end flows with references to contracts and functions.

- __Non-Root Deposit with Bonus__
  1. LP calls `Farm.provideLiquidity(amount, maturity)`.
  2. Farm updates position, mints claim token 1:1.
  3. Farm calls `ProtocolCore.distributeDepositBonus(farmId, lp, amount, maturity)`.
  4. Protocol computes expected yield using benchmark, applies `depositBonusRatio`, pays DXP to LP, records pinned bonus.

- __RootFarm Deposit__
  1. LP calls `RootFarm.provideLiquidity(amount, maturity)`.
  2. Mints `vDXP` 1:1 and increases `lockedDXP`.

- __vDXP Transfer Fee Unlock__
  1. Holder calls `vDXP.transfer(recipient, amount)`.
  2. Fee computed from `ProtocolCore.getTransferFeeRate()`; fee burned and `RootFarm.unlockDXP(fee)` called.
  3. Increases `farmRevenueDXP` for later distribution.

- __Revenue Harvest & Distribution__
  1. Owner calls `ProtocolCore.pullFarmRevenue(farmId)`.
  2. Farm harvests & swaps to DXP, returns revenue.
  3. Protocol `_distributeRevenue()` splits among verifiers, yield yodas, farm owner (after protocol fee), credits reserves if lists empty.

- __Bonus Reversal & Recycling__
  1. Early withdraw triggers `ProtocolCore.reverseDepositBonus(...)` from farm, queues cooldown.
  2. After `COOLDOWN_PERIOD`, `recycleCooldownTokens()` returns tokens to unissued pool and adjusts reserves.

- __Consensus Update__
  1. `Consensus.startRound(farmId)`; verifiers submit `submit(farmId, score, benchmark)`.
  2. `Consensus.finalizeRound(farmId)` → `ProtocolCore.recordConsensus(...)` storing `ConsensusResult` and benchmark.
