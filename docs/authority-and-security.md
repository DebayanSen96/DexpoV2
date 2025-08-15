# Authority, Access Control & Security

This document outlines roles, permissions, and key security properties.

- __Ownership__
  - `ProtocolCore`, `FarmFactory`, tokens and farms are `Ownable`. On mainnet, ownership is intended for DAO governance; on testnets, deployer.

- __Protocol Owner__ (`ProtocolCore`)
  - Approvals: `setApprovedFarmOwner()`, `createApprovedFarm()`, `setRootFarm()`.
  - Modules: `setConsensusModule()`, `setLiquidityManager()`, `setBridgingAdaptor()`.
  - Economics: `setDepositBonusRatio()`, `setProtocolFeeRate()`, `setTransferFeeRate()`.
  - Operations: `pullFarmRevenue()`, `triggerEmission()`, `syncProtocolReserves()`.
  - Time-scaling (testnet): `setTimeScale()`, `scalePeriod()`.

- __Farm Owner__
  - `setPool()`, bonus restake ops in `RestakeFarm` (`restakeBonus`, `reverseRestakedBonus`).

- __Protocol ↔ Farm trust__
  - Sensitive functions in `Farm` and `RootFarm` use `onlyProtocolMaster` (ProtocolCore) or `onlyFarmOwner`.
  - `RootFarm.unlockDXP()` restricted to the associated claim token (vDXP).

- __Reentrancy__
  - Critical functions are `nonReentrant` across `ProtocolCore`, `Farm`, `RootFarm`.

- __Verifier Stake__
  - `minVerifierStake` enforced; verifiers must stake DXP to register.

- __Transfer Fee Path__
  - `vDXP` burns transfer fees and triggers `unlockDXP`. Ensure correct `transferFeeRate` configuration.

- __Lists Empty Safety__
  - If no verifiers/yodas, their revenue portions accrue to `protocolReserves`.

- __Upgradability__
  - Testnet governance stubs exist in `ProtocolCore` (`proposeProtocolFeeUpdate`, `voteOnFeeUpdate`, etc.) as no-ops.
