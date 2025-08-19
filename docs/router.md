# StrategyRouter (v3)

File: `contracts/v3/strategies/StrategyRouter.sol`
Interfaces: `contracts/v3/interfaces/IStrategyRouter.sol`, `contracts/v3/interfaces/IStrategyAdapter.sol`

## Responsibilities

- Hold target allocations across adapters and orchestrate allocate/deallocate/harvest.
- Enforce access: admin wiring by owner/protocol owner; operations only by the configured farm.

## Initialization & Wiring

- `initialize(asset, protocolCore, initialOwner)` — set base asset, core, owner.
- `setFarm(farm)` (onlyOwner, one-time) — authorize a farm for ops.

## Admin (Owner or Protocol Owner)

- `allocations() -> (ids, adapters, bps)` — view current targets.
- `setAllocations(ids, adapters, bps)` — replace all targets; `sum(bps) == 10_000`.
- `rebalance(targetBps)` — update target bps in-place; MVP does not move funds.
- `pause()` / `unpause()` — pause admin actions.

Access control helper: Only owner or `IOwnable(protocolCore).owner()` may call admin methods.

## Farm Operations (onlyFarm)

- `allocate(amount)` — pulls base from `msg.sender` (farm), splits by target bps, approves adapters, calls `IStrategyAdapter.deposit(part, bytes("") )`.
- `deallocate(amount)` — calls `IStrategyAdapter.withdraw(part, bytes("") )` per adapter and forwards received assets to `farm`.
- `harvest() -> baseReturned` — calls `adapter.harvest()` across adapters and forwards realized base to `farm`.
- `totalAssets()` — sum of `IStrategyAdapter.totalAssets()` across adapters.

## Notes

- Target bps must always total to 10_000.
- Router enforces `whenNotPaused` on admin and farm ops.
- Asset transfers use `SafeERC20` with `forceApprove` before adapter calls.
