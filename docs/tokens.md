# Tokens: Share, Claim, and DXP

## ShareToken (per farm)

- File: `contracts/v3/tokens/ShareToken.sol`
- Mint/Burn: only by `BaseFarm` as `minter`.
- Transfer controls: `transferable` toggle; `transferFeeBps` up to 15%.
- Fee distribution: owner `feeReceiver` and protocol `protocolFeeReceiver` with `protocolRakeBps` up to 20% of the fee portion.

## Claim Tokens

- Generic farm claim: `contracts/ClaimToken.sol` → `FarmClaimToken` extending `BaseClaimToken` (mint/burn restricted to designated minter).
- Root claim & governance: `contracts/vDXPToken.sol`
  - Transfer fee (via protocol setting) is burned; equivalent DXP is unlocked in `RootFarm.unlockDXP(fee)`.
  - Cooling period tracking: `coolingPeriod`, `lastAcquireTimestamp` for voting/claim gating.

## DXP Tokenomics

- File: `contracts/DXPToken.sol`
- Supply: 21M total; 60% emissions (12.6M), 40% vested (8.4M).
- Emissions: `emitTokens()` mints based on time intervals (`blockTime`) since `lastEmissionTime`; halves every 4 years (`halvingInterval`).
- Vesting: `createVestingWallet(...)` deploys cliff+linear `VestingComponent` per beneficiary and mints allocation.
- Recycling: `recycleTokens(amount)` burns sender tokens and re-mints to `address(this)` supply accounting.

## Root Farm Mechanics (legacy path)

- `contracts/RootFarm.sol`: LPs deposit DXP and receive vDXP 1:1; DXP is tracked as `lockedDXP` and unlocked via `vDXPToken` transfer fees calling `unlockDXP`.
