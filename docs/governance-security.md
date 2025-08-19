# Governance & Security

## Ownership model

- System owner: `ProtocolCore` owner controls sensitive updates across farms via owner checks inside modules (e.g., `BaseFarm._isProtocolOwner()`).
- Farm owner: receives module ownership after factory wiring and can operate the farm (allocate/deallocate/rebalance) and configure `ShareToken`. First-time module set is allowed by farm owner; further updates require `ProtocolCore` owner.

## Permissions & Guards

- Reentrancy protection: `ReentrancyGuard` on state-changing flows (e.g., deposits/withdrawals/harvest/claim).
- Pausability: `BaseFarm` and `StrategyRouter` expose `pause/unpause`; harvest gated by `minHarvestInterval`.
- Caps and validation: farm splits must sum to 10_000 bps; `ShareToken` caps transfer fee (15%) and protocol rake (20%).
- Strategy isolation: router-only adapter calls; approvals reset with `forceApprove` for safety.

## Economic considerations

- Early-exit penalties retained in farm increase PPS for remaining LPs.
- Owner stream portion subject to protocol rake, ensuring protocol revenue capture.

## Testnet/time-scaling

- ProtocolCore supports time-scaling for testing (see `contracts/ProtocolCore.sol`), impacting benchmark/bonus/testing behavior where applicable.
