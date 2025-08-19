# Glossary

- Base asset: ERC-20 principal token accepted by a farm (`BaseFarm.asset`).
- ShareToken: ERC-20 share token minted/burned by `BaseFarm` representing LP ownership.
- Stream: Linear vesting window maintained by `PayoutPolicy`.
- Router: `StrategyRouter` managing target allocations and adapter operations.
- Adapter: Strategy integration implementing `IStrategyAdapter` (`deposit/withdraw/harvest/totalAssets`).
- Splits: LP/Owner/Verifier basis points in `StakeholderRegistry`.
- Protocol rake: protocol cut from owner’s streamed portion, configured on `ShareToken`.
- Lockup: Time window enforced by `LockupPolicy` with optional early-exit penalty.
- Root Farm: Special DXP farm where vDXP is minted 1:1 and DXP unlocks via vDXP transfer fees.
