# Consensus & Verifiers

- Contract: `contracts/Consensus.sol`
- Purpose: manages ephemeral rounds per farm, collects submissions from approved verifiers, computes averages, and reports results to `ProtocolCore`.

## Lifecycle

- Start: `startRound(farmId)` -> emits `RoundStarted`.
- Submit: `submit(farmId, score, benchmark)` by approved verifiers (`ProtocolCore.isApprovedVerifier(farmId, sender)`), records once per round.
- Finalize: `finalizeRound(farmId)` averages submitted values if `count >= minQuorum` and calls `protocolCore.recordConsensus(...)`.

## Config

- `minQuorum` adjustable by owner.
- `ProtocolCore` address settable by owner; many modules gate updates by `ProtocolCore` owner.
