# Integration Notes & Gaps

Implementation notes for integrators and outstanding gaps.

- __Restake Integration__
  - `RestakeFarm` calls `RootFarm.restakeDeposit(lp, bonusDXP)` and `RootFarm.reverseRestake(lp, bonusDXP)`; these are not yet present in `RootFarm.sol`.
  - Recommended additions in `RootFarm`:
    - `restakeDeposit(lp, amount)` — accept DXP from `RestakeFarm`, mint `vDXP` to `lp`, adjust `lockedDXP`.
    - `reverseRestake(lp, amount)` — burn or pull vDXP and reverse DXP as needed.

- __LiquidityManager & Pool__
  - Ensure `Farm.setPool(address)` points to a pool exposing `getDXPToken()`.
  - Configure `ProtocolCore.setLiquidityManager(address)` to a swap router that supports `getBestSwapAmountOut()` and `swap()` for assets → DXP.

- __Parameterization__
  - Testnets: `setTimeScale(num, den)` can accelerate maturity/time-based calcs; avoid on mainnet.
  - `transferFeeRate` must be set sensibly as it directly affects RootFarm revenue via vDXP.

- __Empty Recipient Lists__
  - If no verifiers/yodas are approved, their shares accrue to `protocolReserves`.

- __Security__
  - Keep `ProtocolCore` ownership in DAO/multisig in production.
  - `RootFarm.unlockDXP()` should remain restricted to vDXP only (already enforced).
