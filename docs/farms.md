# Farms (Base, Root, Restake) and Factory

This document details farm behavior across `contracts/Farm.sol`, `contracts/RootFarm.sol`, `contracts/RestakeFarm.sol`, and the factory in `contracts/FarmFactory.sol`.

- __Base Farm__: `contracts/Farm.sol`
  - __State__:
    - `asset`, `farmOwner`, `farmId`
    - Principal: `totalLiquidity`, `deployedLiquidity`, `availableLiquidity()`
    - Yield: `accYieldPerShare`, `yieldDebt[lp]`, `farmRevenueDXP`
    - Positions: `positions[lp] = { principal, weightedMaturity, bonus, lastUpdate }`
    - Incentive splits: `lpIncentiveSplit`, `verifierIncentiveSplit`, `yieldYodaIncentiveSplit`
    - External: `claimToken`, `strategy`, `protocolMaster`, `liquidityManager`, `pool`
  - __Deposit__: `provideLiquidity(amount, maturity)`
    - Transfers principal to farm, updates `positions`, sets `yieldDebt[lp]`, mints claim token 1:1.
    - Calls `protocolMaster.distributeDepositBonus(farmId, lp, amount, maturity)`.
  - __Withdraw__: `withdrawLiquidity(amount, returnBonus)`
    - Updates position and `yieldDebt`.
    - Burns claim tokens.
    - Early withdrawal handling delegates bonus reversal to `ProtocolCore.reverseDepositBonus(...)` when applicable.
  - __Revenue__: `pullFarmRevenue()` (protocol-only)
    - Harvests strategy via `FarmStrategy.harvestRewards()`.
    - Adds `principalReserve`, swaps to DXP via `ILiquidityManager` if needed.
    - LP share increases `accYieldPerShare`; remainder returned to Protocol as revenue.
  - __Pool__: `setPool(address)` for price discovery (`IFarmLiquidityPool.getDXPToken()`).

- __RootFarm__: `contracts/RootFarm.sol`
  - Asset is DXP; tracks `lockedDXP`.
  - __Deposit__: `provideLiquidity(amount, maturity)`
    - Transfers DXP, increases `totalLiquidity` and `lockedDXP`, mints `vDXP` 1:1.
    - Updates position and `yieldDebt`.
  - __Withdraw__: `withdrawLiquidity(amount, returnBonus)`
    - Early exit fee 0.5% added to `farmRevenueDXP`.
    - Burns vDXP, unlocks DXP, transfers net DXP to LP.
  - __Unlock from vDXP fee__: `unlockDXP(amount)` callable only by claim token.
  - __Revenue credit__: `addRevenueDXP(amount)` protocol-only.

- __RestakeFarm__: `contracts/RestakeFarm.sol`
  - Bonus restaking flow:
    - `setDXPToken(address)` sets DXP interface.
    - `restakeBonus(lp, bonusDXP)` increases allowance and calls `RootFarm.restakeDeposit(lp, bonusDXP)`.
    - `reverseRestakedBonus(lp, bonusDXP)` pulls bonus from LP and calls `RootFarm.reverseRestake(lp, bonusDXP)`.
  - Note: `RootFarm.restakeDeposit()` and `reverseRestake()` must be implemented to support these paths.

- __Factory__: `contracts/FarmFactory.sol`
  - `createFarm(salt, asset, maturityPeriod, verifierIncentiveSplit, yieldYodaIncentiveSplit, lpIncentiveSplit, strategy, claimToken, farmOwner)`
  - `createRestakeFarm(...)` (with `rootFarmAddress`).
  - Uses CREATE2 with `finalSalt = keccak256(abi.encodePacked(msg.sender, salt))`.
