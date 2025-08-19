# Stakeholders & Incentives

- Protocol core owner: governs system-wide settings and approves sensitive farm updates. Referenced by many modules via owner checks of `ProtocolCore`.
- Farm owner: receives configured share of streamed rewards; may manage allocations, policies (initially), and operational tasks.
- Liquidity Providers (LPs): deposit base asset to a farm and receive `ShareToken` reflecting proportional ownership of `BaseFarm.totalAssets()`.
- Verifiers: stake/are approved in `ProtocolCore` and provide submissions in consensus rounds; receive a split of streamed rewards.

## Splits and Recipients

- Splits stored in `contracts/v3/modules/StakeholderRegistry.sol`:
  - `setSplits(lpBps, ownerBps, verifierBps)` must sum to 10_000.
  - `setOwnerRecipient(recipient)` optionally routes owner share to a designated address.
- Splits are applied when `BaseFarm.harvest()` streams rewards.
