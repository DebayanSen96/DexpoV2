# Consensus & Benchmarks

Consensus is handled by `contracts/Consensus.sol` with storage and application in `contracts/ProtocolCore.sol`.

- __Rounds__
  - Start: `Consensus.startRound(farmId)` (owner-only).
  - Submit: `Consensus.submit(farmId, score, benchmark)` by verifiers approved in `ProtocolCore.isApprovedVerifier(farmId, who)`.
  - Finalize: `Consensus.finalizeRound(farmId)` (owner-only) → computes averages if `count >= minQuorum` and calls `ProtocolCore.recordConsensus(farmId, roundId, avgScore, avgBenchmark)`.

- __Protocol Storage__: `ProtocolCore`
  - `ConsensusResult { score, benchmark }` stored per farm and round.
  - `setConsensusModule(address)` for wiring.
  - Benchmark used by `distributeDepositBonus()` for expected-yield calculations.

- __Parameters__
  - `Consensus.minQuorum` (owner-configurable).
  - `ProtocolCore.minVerifierStake` for registration gating.

- __Verifier Lifecycle__
  - Register: `ProtocolCore.registerAsVerifier(farmId)` requires stake ≥ `minVerifierStake`.
  - Withdraw stake: `ProtocolCore.withdrawVerifierStake(farmId)` per rules.

- __Events__
  - `RoundStarted`, `SubmissionReceived`, `RoundFinalized` in `Consensus`.
  - `ConsensusRecorded` (and bonus/reserve events) in `ProtocolCore`.
