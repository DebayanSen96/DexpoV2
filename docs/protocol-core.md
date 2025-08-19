# ProtocolCore (v3) – Responsibilities & APIs

File: `contracts/ProtocolCore.sol`
Interfaces: `contracts/v3/interfaces/IProtocolCore.sol`

## Responsibilities

- Owns protocol-wide configuration and permissions.
- Approves farm owners and orchestrates v3 farm creation via `FarmFactory`.
- Validates farm configuration against protocol rules via `assertFarmConfigValid`.
- Maintains registries mapping `farmId` ⇄ `baseFarm` and module addresses.
- Tracks and receives protocol rake reports from farms.
- Manages verifier approvals and provides them to modules.
- Emits `FarmCreated` on both root and v3 farm creations.

## Key State

- `uint256 nextFarmId` – v3 farm ids start at 1 (0 reserved for Root).
- `mapping(uint256 => address) farmAddressOf` – farmId → baseFarm.
- `mapping(address => FarmDetails) farms` and `mapping(uint256 => FarmDetails_V3) farmsById`.
- `IFarmFactory farmFactory` – factory used to deploy farm stacks.
- `mapping(address => bool) approvedFarmOwners` – whitelist to create farms.

## Farm Creation

- `createApprovedFarm(asset, farmName, farmSymbol, ownerRecipient, lpBps, ownerBps, verifierBps, lockCfg, payoutCfg, stCfg, adapterKeys, adapterAddrs, adapterBps)`
  - Requires `approvedFarmOwners[msg.sender]` and `Split==100%`.
  - Increments `nextFarmId` and calls `farmFactory.createFarmStack(...)` with `core=address(this)`.
  - Registers farm in registries and emits `FarmCreated` with module addresses.
  - Returns `(farmIdOut, baseFarm)`.

- `createApprovedFarmFor(creator, ...)`
  - Allows protocol owner to create for any approved `creator`, or an approved owner to create for self.
  - Same wiring and registration as above; emits `FarmCreated`.

## Protocol Rules & Interfaces

- Interface: `IProtocolCoreV3` (`contracts/v3/interfaces/IProtocolCore.sol`)
  - `getApprovedVerifiers(farmId)`, `isApprovedVerifier(farmId, who)` – used by `StakeholderRegistry` and consensus.
  - `getFarmRules() -> FarmRules { minLpBps, maxOwnerBps, maxVerifierBps, maxTransferFeeBps, maxProtocolRakeBps, maxEarlyExitBps, maxLockupSeconds, maxNoExitLockupSeconds, minEpochSeconds, maxEpochSeconds }`.
  - `assertFarmConfigValid(lpBps, ownerBps, verifierBps, lockEnabled, allowEarlyExit, earlyExitBps, lockupSeconds, postLockMode, payoutMode, streamBps, compoundBps, epoch, minHarvestInterval, compoundLpOnLock, shareTransferable, shareTransferFeeBps, protocolRakeBps)` – called by `FarmFactory.createFarmStack()`.
  - `registerFarm(owner, farm, farmId)` – called by factory during creation.
  - `reportProtocolFee(farmId, amount)` – called by `BaseFarm.harvest()` when protocol rake is applied.

### Farm Rules Constraints (`FarmRules`)

- `minLpBps` — minimum LP split share required for a farm.
- `maxOwnerBps` — upper bound on owner split share.
- `maxVerifierBps` — upper bound on verifier split share.
- `maxTransferFeeBps` — cap for `ShareToken` transfer fee.
- `maxProtocolRakeBps` — cap for protocol rake applied on owner share.
- `maxEarlyExitBps` — maximum early-withdrawal penalty.
- `maxLockupSeconds` — max lockup when early exit is allowed.
- `maxNoExitLockupSeconds` — stricter max when early exit is disabled.
- `minEpochSeconds` — lower bound for payout streaming epoch.
- `maxEpochSeconds` — upper bound for payout streaming epoch.

## Interactions with Modules

- `StakeholderRegistry.activeVerifiers()` pulls from `protocolCore.getApprovedVerifiers(farmId)`.
- `BaseFarm._isProtocolOwner()` checks `IHasOwner(protocolCore).owner()` for gating updates to modules.
- `Consensus` calls `recordConsensus(...)` in `ProtocolCore` to update farm benchmarks used elsewhere (e.g., bonus calculations).

## Events

- `FarmCreated(farmId, baseFarm, owner, router, payoutPolicy, lockupPolicy, stakeholderRegistry)` – emitted on v3 creation.
- Additional protocol-wide events (e.g., verifier staking, rule updates) are defined within `ProtocolCore.sol`.
