# Protocol Parameters

This document enumerates key tunables and where they live.

- __ProtocolCore__ (`contracts/ProtocolCore.sol`)
  - `depositBonusRatio` — % applied to expected yield when issuing bonuses.
  - `protocolFeeRate` — % on farm-owner revenue slice (≤ 100).
  - `transferFeeRate` — basis points (≤ 2000) for claim token transfers (vDXP uses it to burn & unlock).
  - `minVerifierStake` — stake to register as verifier.
  - Time-scaling — `setTimeScale(num, den)` and helper `scalePeriod()`.
  - `COOLDOWN_PERIOD` — 1 day for bonus return recycling.
  - Modules — `liquidityManager`, `consensus`, `bridgeAdapter`, `rootFarm`, `factory`, `dxpToken`, `vdxpToken`.

- __Farm__ (`contracts/Farm.sol`)
  - Splits — `lpIncentiveSplit`, `verifierIncentiveSplit`, `yieldYodaIncentiveSplit` (immutable).
  - `minimumMaturityPeriod`.
  - `strategy`, `pool`. `setPool(address)`.

- __DXP Token__ (`contracts/DXPToken.sol`)
  - Emission — `emissionPerBlock`, `blockTime`, `lastEmissionTime`, `lastHalvingTime`, `halvingInterval`.
  - Supply — `TOTAL_SUPPLY`, `EMISSION_SUPPLY`, `VESTED_SUPPLY`.

- __vDXP Token__ (`contracts/vDXPToken.sol`)
  - `coolingPeriod`.
