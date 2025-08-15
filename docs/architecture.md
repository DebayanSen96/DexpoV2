# Architecture

This document describes the on-chain architecture and module responsibilities found in `contracts/`.

- __Core Registry__: `contracts/ProtocolCore.sol`
  - Farm registry and approvals.
  - Verifier and yield-yoda registries and stakes.
  - Deposit bonus issuance/reversal + cooldown recycling.
  - Revenue pulling and distribution across stakeholders.
  - Consensus storage and benchmark management.
  - Emission reserve/reserves accounting and protocol parameters.

- __Farms__
  - __Base__: `contracts/Farm.sol`
    - Accepts principal deposits and mints claim tokens 1:1.
    - Tracks per-LP position (principal, weighted maturity, bonus, last update).
    - Accumulates LP yield via `accYieldPerShare`.
    - Deploys liquidity through `FarmStrategy` and swaps yield -> DXP via `ILiquidityManager`.
    - Calls `ProtocolCore.distributeDepositBonus()` on deposit.
  - __RootFarm__: `contracts/RootFarm.sol`
    - Principal is DXP. Mints `vDXP` 1:1. All deposited DXP is `lockedDXP`.
    - vDXP transfer fees call `unlockDXP(fee)` to move DXP from locked pool into revenue.
  - __RestakeFarm__: `contracts/RestakeFarm.sol`
    - Restakes bonus DXP into RootFarm, which should mint vDXP to the LP.

- __Factory__: `contracts/FarmFactory.sol`
  - Deploys `Farm` / `RestakeFarm` with predictable address via CREATE2.

- __Tokens__
  - __DXP__: `contracts/DXPToken.sol`
    - 21M supply. 60% emissions with 4-year halvings. 40% vesting.
    - `emitTokens()` mints to owner. `recycleTokens()` returns supply to unissued pool.
  - __vDXP__: `contracts/vDXPToken.sol`
    - Claim/governance token for RootFarm. Transfer fee burned and unlocks DXP in RootFarm.
    - Cooling period tracking for governance.
  - __FarmClaimToken__: `contracts/ClaimToken.sol`
    - Base claim token for non-root farms.

- __Consensus__: `contracts/Consensus.sol`
  - Starts rounds, collects verifier submissions (score + benchmark), finalizes averages and calls `ProtocolCore.recordConsensus()`.

- __Utilities__: `contracts/ERC6909.sol` (multi-token standard implementation; not wired into main flows).
