# Rewards, Deposit Bonuses, Cooldown & Distribution

This document focuses on LP bonuses and revenue distribution logic orchestrated by `contracts/ProtocolCore.sol` and `contracts/Farm.sol`.

- __Deposit Bonus__: `ProtocolCore.distributeDepositBonus(farmId, lp, amount, maturity)`
  - Computes expected yield using current benchmark (from consensus) and maturity window, in principal terms, then prices into DXP via `ILiquidityManager` when needed.
  - Applies `depositBonusRatio` to size LP bonus in DXP.
  - Transfers bonus DXP to LP (or restakes via `RestakeFarm` integration) and records `BonusRecord { bonusPaid, pinned=true, depositTime }`.
  - Only callable by approved farms.

- __Bonus Reversal__: `ProtocolCore.reverseDepositBonus(farmId, lp, amount, isEarly)`
  - Claws back previously paid bonus for early withdrawal/full exit.
  - Returned DXP is queued for cooldown via `_queueCooldown(amount)`.
  - Only callable by approved farms.

- __Unpin__: `ProtocolCore.unpinPosition(lp, farmId)`
  - Marks LP’s bonus as not claw-back-able after suitable conditions/time (post-cooldown logic), setting `pinned=false`.

- __Cooldown & Recycling__
  - `COOLDOWN_PERIOD = 1 days`.
  - `_queueCooldown(amount)` stores `CooldownRecord { amount, releaseTime }`.
  - `recycleCooldownTokens()` burns and re-mints to unissued supply (`DXPToken.recycleTokens()` path/owner-accounting) and accounts into `emissionReserve`/`protocolReserves` accordingly.

- __Farm Revenue Harvest__: `Farm.pullFarmRevenue()`
  - Harvests principal rewards + `principalReserve`, converts to DXP (if needed), splits LP share into `accYieldPerShare`, and transfers remainder to `ProtocolCore`.

- __Protocol Revenue Pull__: `ProtocolCore.pullFarmRevenue(farmId)` (owner-only)
  - Receives revenue and calls `_distributeRevenue(farmId, netRevenue)`.

- __Distribution__: `ProtocolCore._distributeRevenue(farmId, netRevenue)`
  - Uses farm’s `verifierIncentiveSplit()` and `yieldYodaIncentiveSplit()`.
  - Calculates:
    - Verifier portion → equally among `approvedVerifiersList[farmId]`.
    - Yield yoda portion → equally among `approvedYieldYodaList[farmId]`.
    - Farm owner portion → after `protocolFeeRate`.
  - Empty recipient lists credit `protocolReserves`.
  - May credit RootFarm via `rootFarm.addRevenueDXP()` when configured.

- __Transfer Fee Revenue (Root)__
  - `vDXPToken.transfer/transferFrom` burns fee and calls `RootFarm.unlockDXP(fee)`.
  - Increases `farmRevenueDXP` to be later distributed via protocol pulls.
