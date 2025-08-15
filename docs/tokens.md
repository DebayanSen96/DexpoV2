# Tokens (DXP and vDXP)

This document covers tokenomics and mechanics of `DXP` and `vDXP`.

- __DXP__: `contracts/DXPToken.sol`
  - __Supply__: 21,000,000 DXP total.
    - Emissions: 60% (12.6M), time-based via `emitTokens()` with 4-year halving (`emissionPerBlock`, `blockTime`, `lastEmissionTime`, `lastHalvingTime`).
    - Vesting: 40% (8.4M) distributed via `createVestingWallet()` using `VestingComponent` (cliff + linear).
  - __Emissions__:
    - `emitTokens()` checks halving, mints `intervals * emissionPerBlock` to owner (ProtocolCore on mainnet), updates trackers.
    - Protocol integrates via `ProtocolCore.triggerEmission()` and `syncProtocolReserves()` to account reserves and emission reserve.
  - __Recycling__:
    - `recycleTokens(amount)`: burns caller’s tokens and re-mints to `address(this)` (unissued pool). Used when returned bonuses are recycled after cooldown.
  - __Views__:
    - `getIntervalsSinceLastEmission()`, `getCurrentEmissionRate()`.

- __vDXP__: `contracts/vDXPToken.sol`
  - __Role__: Claim and governance token for `RootFarm`.
  - __Transfer Fee & Unlock__:
    - On `transfer()`/`transferFrom()`, computes fee via `ProtocolCore.getTransferFeeRate()`.
    - Burns fee from sender and calls `RootFarm.unlockDXP(fee)` (only if `associatedFarm` set) to move DXP from `lockedDXP` to `farmRevenueDXP`.
    - Net tokens are transferred to recipient; `lastAcquireTimestamp[recipient] = block.timestamp` for cooling.
  - __Cooling Period__:
    - `coolingPeriod` governs when a holder is considered cooled; helpers `isCooledDown(user)` and `canVote(user)`.
  - __Mint/Burn__:
    - Only `minter` (set by Protocol) can `mint(to, amount)` and `burn(from, amount)`.

- __Farm Claim Token__: `contracts/ClaimToken.sol`
  - Base claim token for non-root farms (mint/burn controlled). Minted 1:1 on deposit, burned on withdrawal.
