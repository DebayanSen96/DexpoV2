# Protocol Overview & Architecture

- Core registry and policy enforcement: `contracts/ProtocolCore.sol`.
- Farm stack (per vault): `contracts/v3/farm/BaseFarm.sol` with modular components wired by `contracts/v3/factories/FarmFactory.sol`.
- Strategy orchestration: `contracts/v3/strategies/StrategyRouter.sol` and pluggable strategy adapters.
- Payout, lockup, and stakeholder splits: `contracts/v3/modules/PayoutPolicy.sol`, `contracts/v3/modules/LockupPolicy.sol`, `contracts/v3/modules/StakeholderRegistry.sol`.
- Share token per farm: `contracts/v3/tokens/ShareToken.sol` (mint/burn by farm, optional transfer fee and protocol rake).
- Protocol tokenomics: `contracts/DXPToken.sol` (emissions and vesting). Root claim token: `contracts/vDXPToken.sol` (governance + claim).
- Consensus rounds for verifier inputs: `contracts/Consensus.sol`.

## High-level Architecture

- Base layer: `ProtocolCore` governs farm creation, approvals, fee/rake settings, verifier registry, and cross-farm accounting.
- Per-farm stack deployed via `FarmFactory.createFarmStack()`:
  - `BaseFarm` (ERC-4626-like) holds idle principal and integrates a `StrategyRouter`.
  - `ShareToken` minted/burned by `BaseFarm` tracks LP ownership.
  - `PayoutPolicy` streams realized base assets to beneficiaries over an epoch.
  - `LockupPolicy` enforces early-exit penalties when enabled.
  - `StakeholderRegistry` stores LP/Owner/Verifier split bps and owner recipient.
- Strategies: `StrategyRouter` manages adapter allocations and harvest/deallocate/allocate flows.

## Design Goals

- Modular policies for payout/lockup/splits; protocols can update modules subject to `ProtocolCore` owner gating.
- Deterministic accounting: NAV = idle + router.totalAssets(); share price reflects compounding and penalties.
- Minimal trust in adapters: router-only operations; adapters expose `deposit/withdraw/harvest/totalAssets`.
