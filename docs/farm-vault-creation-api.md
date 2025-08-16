# Dexponent v3 – Farm/Vault Creation API Payloads

This document defines the two-payload flow to create a customized vault stack and attach strategy adapters. It specifies field types, accepted values, constraints, and on-chain mappings.

- Step 1 (Create Vault Stack): Deploys and wires BaseVault, StrategyRouter, PayoutPolicy, LockupPolicy, StakeholderRegistry, and applies ShareToken settings.
- Step 2 (Attach Adapters): Creates protocol-specific adapters (optional) and sets router target allocations.

Note: Applying ShareToken settings during creation requires `VaultFactory` to accept and apply a `ShareTokenConfig` before transferring ownership.

---

## Data Types

- Addr: 20-byte hex address string. Pattern: `0x[a-fA-F0-9]{40}`
- Bytes32: 32-byte hex string. Pattern: `0x[a-fA-F0-9]{64}`
- uint16: 0..65535
- uint64: 0..18446744073709551615
- BPS: basis points, 10_000 = 100%

---

## Step 1 – VaultCreationPayload

One payload to create and configure the entire vault stack and ShareToken.

### Type (TypeScript)

```ts
type Addr = `0x${string}`;
type Bytes32 = `0x${string}`;

type VaultCreationPayload = {
  creator: Addr; // EOA that signs the tx; must be an approved farm owner
  asset: Addr; // ERC20 base asset
  vaultName: string; // ShareToken name
  vaultSymbol: string; // ShareToken symbol

  recipients: {
    ownerRecipient: Addr; // Address to receive owner streamed rewards
  };

  splits: {
    lpBps: number;       // 0..10000
    ownerBps: number;    // 0..10000
    verifierBps: number; // 0..10000
    // Constraint: lpBps + ownerBps + verifierBps == 10000
  };

  lockConfig: {
    enabled: boolean;          // Enable lockup on deposit
    allowEarlyExit: boolean;   // Allow early exit with penalty
    earlyExitBps: number;      // 0..10000, penalty applied on early exit
    lockupSeconds: number;     // uint64, lock duration per deposit
    postLockMode: number;      // uint8, reserved for future modes (currently not enforced)
  };

  payoutConfig: {
    mode: "Stream" | "Lockup";     // Stream=0, Lockup=1
    streamBps: number;             // 0..10000; fraction of harvest streamed when mode=Stream
    compoundBps: number;           // 0..10000; typically streamBps + compoundBps == 10000
    epochSeconds: number;          // uint64 > 0; stream window length
    minHarvestIntervalSeconds: number; // uint64 ≥ 0; required gap for harvestIfNeeded
    compoundLpOnLock: boolean;     // When mode=Lockup: true => all compounded; false => all streamed
  };

  // Optional here; adapters are attached in Step 2. If provided, bps must sum 10000.
  strategies?: {
    key: Bytes32;   // Strategy id
    adapter: Addr;  // Adapter address
    bps: number;    // 0..10000
  }[];

  shareToken: {
    transferable: boolean;          // Toggle transfers
    transferFeeBps: number;         // 0..1500 (max 15%)
    feeReceiver: Addr;              // Required if transferFeeBps > 0
    protocolFeeReceiver?: Addr;     // Optional protocol rake recipient
    protocolRakeBps?: number;       // 0..2000 (max 20% of the fee portion)
  };

  meta?: { chainId?: number };
};
```

### Field Semantics and Constraints

- creator: Must be an approved farm owner; becomes owner of vault and all modules.
- asset: ERC20 base asset for the vault.
- vaultName / vaultSymbol: Used to deploy the ShareToken.
- recipients.ownerRecipient: Streams for owner are accrued to this address.
- splits:
  - Must sum to 10_000 (100%).
  - Applied by `StakeholderRegistry` to split streamed rewards: LP retained in vault idle, owner streamed, verifiers streamed equally.
- lockConfig:
  - enabled: If true, each deposit starts a lock window per user.
  - allowEarlyExit: If false, withdrawals before lock end revert; if true, penalty applies.
  - earlyExitBps: Penalty fraction for early exit (≤ 10000).
  - lockupSeconds: Duration per deposit (uint64).
  - postLockMode: Reserved for future use; uint8 range 0..255.
- payoutConfig:
  - mode:
    - "Stream": streamed = (harvest * streamBps) / 10000; compounded = harvest - streamed.
    - "Lockup": if `compoundLpOnLock == true` then streamed=0 (all compounded); else streamed=full harvest.
  - streamBps / compoundBps: For "Stream", recommend `streamBps + compoundBps == 10000`.
  - epochSeconds: Streaming vesting window; must be > 0.
  - minHarvestIntervalSeconds: Harvest cadence guard for `harvestIfNeeded`.
- strategies (optional in Step 1): If provided, arrays must align and sum(bps) == 10000.
- shareToken:
  - transferFeeBps ≤ 1500; protocolRakeBps ≤ 2000.
  - If transferFeeBps > 0, feeReceiver must be non-zero.
  - Protocol rake is taken from the owner portion of streamed rewards and from transfer fees when `protocolFeeReceiver` is set.

### Example (Step 1)

```json
{
  "creator": "0xFARMOWNER00000000000000000000000000000001",
  "asset": "0xA0b86991c6218b36c1d19d4a2e9eb0cE3606eB48",
  "vaultName": "Alpha USDC Vault",
  "vaultSymbol": "aUSDC",
  "recipients": { "ownerRecipient": "0x1111111111111111111111111111111111111111" },
  "splits": { "lpBps": 9000, "ownerBps": 800, "verifierBps": 200 },
  "lockConfig": {
    "enabled": true,
    "allowEarlyExit": true,
    "earlyExitBps": 500,
    "lockupSeconds": 2592000,
    "postLockMode": 0
  },
  "payoutConfig": {
    "mode": "Stream",
    "streamBps": 3000,
    "compoundBps": 7000,
    "epochSeconds": 604800,
    "minHarvestIntervalSeconds": 3600,
    "compoundLpOnLock": false
  },
  "strategies": [],
  "shareToken": {
    "transferable": true,
    "transferFeeBps": 100,
    "feeReceiver": "0x1111111111111111111111111111111111111111",
    "protocolFeeReceiver": "0x4444444444444444444444444444444444444444",
    "protocolRakeBps": 500
  },
  "meta": { "chainId": 1 }
}
```

### On-chain Mapping (Step 1)

- `ProtocolCore.createApprovedVault`:
  - asset, vaultName, vaultSymbol
  - ownerRecipient
  - lpBps, ownerBps, verifierBps
  - lockCfg = { enabled, allowEarlyExit, earlyExitBps, lockupSeconds, postLockMode }
  - payoutCfg = {
    - mode: 0 if "Stream", 1 if "Lockup"
    - streamBps, compoundBps, epoch, minHarvestInterval, compoundLpOnLock
  }
  - adapterKeys = [], adapterAddrs = [], adapterBps = []
- `VaultFactory.createVaultStack`:
  - Deploys StrategyRouter, PayoutPolicy, LockupPolicy, StakeholderRegistry, BaseVault.
  - Wires modules to the vault and sets splits and ownerRecipient.
  - Applies ShareTokenConfig (transferability and fees) prior to transferring ownership to farm owner. Requires factory support.
- Returns: `(farmId, baseVault)`. Full module addresses via `ProtocolCore.vaultsById(farmId)`.

### Common Reverts (Step 1)

- Not an approved farm owner
- Split!=100%
- SumBps (for strategies if provided)
- LenMismatch (strategy arrays)
- FeeTooHigh (ShareToken fee or rake)

---

## Step 2 – AdapterAttachPayload

Creates protocol-specific adapters (optional) and sets router allocations in one UX step. Supports either pre-deployed adapters or deploy-then-attach.

### Type (TypeScript)

```ts
type Addr = `0x${string}`;
type Bytes32 = `0x${string}`;

type AdapterAllocInput = {
  key: Bytes32;            // bytes32 strategy id
  adapter?: Addr;          // existing adapter address
  deploy?: {
    factory: Addr;         // adapter factory address
    salt?: Bytes32;        // optional create2 salt
    initData: `0x${string}`; // ABI-encoded initializer for adapter
    value?: string;        // optional ETH value in wei
  };
  bps: number;             // 0..10000
};

type AdapterAttachPayload = {
  creator: Addr;           // farm owner (router owner)
  farmId?: number;         // either farmId or router address is required
  router?: Addr;
  adapters: AdapterAllocInput[]; // sum(bps) == 10000
  meta?: { chainId?: number };
};
```

### Field Semantics and Constraints

- creator: Must be the router owner (farm owner).
- farmId/router: Provide one. If farmId provided, resolve router from `ProtocolCore.vaultsById(farmId)`.
- adapters:
  - key: Strategy identifier used by the router.
  - adapter or deploy: Provide exactly one per item.
    - adapter: Use this address directly.
    - deploy: Backend or a factory contract deploys the adapter with `initData` (protocol-specific).
  - bps: Target allocation; all items must sum to 10000.
- After deployment/collection, call `StrategyRouter.setAllocations(keys[], adapters[], bps[])` (owner-only).

### Example (Step 2)

```json
{
  "creator": "0xFARMOWNER00000000000000000000000000000001",
  "farmId": 42,
  "adapters": [
    {
      "key": "0x616176652d757364630000000000000000000000000000000000000000000000",
      "deploy": {
        "factory": "0xFAc0000000000000000000000000000000000000",
        "salt": "0x0000000000000000000000000000000000000000000000000000000000000042",
        "initData": "0xabcdef0123"
      },
      "bps": 6000
    },
    {
      "key": "0x6c69646f2d737464000000000000000000000000000000000000000000000000",
      "adapter": "0x3333333333333333333333333333333333333333",
      "bps": 4000
    }
  ],
  "meta": { "chainId": 1 }
}
```

### On-chain Mapping (Step 2)

- Resolve router address:
  - If farmId provided: `router = ProtocolCore.vaultsById(farmId).router`.
  - Else: use `payload.router`.
- If deploy specified per adapter:
  - Deploy adapter via the specified factory and `initData`.
- Aggregate arrays and call:
  - `StrategyRouter.setAllocations(keys, adapters, bps)`
    - Constraints: lengths equal; sum(bps) == 10000.

### Common Reverts (Step 2)

- Owner-only: Only router owner can set allocations.
- LenMismatch: Arrays not aligned.
- SumBps: Allocation bps not summing to 10000.
- BadAdapter: Zero address provided.

---

## Validation Checklist (Client-side)

- Addresses are valid 0x-prefixed 20-byte hex.
- Bytes32 keys are valid 0x-prefixed 32-byte hex.
- Step 1 splits sum to 10000.
- lockConfig.earlyExitBps ≤ 10000.
- payoutConfig.mode ∈ {"Stream", "Lockup"}.
- payoutConfig.epochSeconds > 0; minHarvestIntervalSeconds ≥ 0.
- For "Stream", enforce `streamBps + compoundBps == 10000` by convention.
- shareToken.transferFeeBps ≤ 1500; protocolRakeBps ≤ 2000; if transferFeeBps > 0 then feeReceiver != 0x0.
- Step 2 adapters sum(bps) == 10000, arrays aligned; each item provides exactly one of `adapter` or `deploy`.

---

## Contract References

- `contracts/v3/ProtocolCore.sol` – `createApprovedVault`: entrypoint; enforces owner approval and split sum.
- `contracts/v3/interfaces/IVaultFactory.sol` – `createVaultStack`: deploys modules, wires, sets splits and ownerRecipient; apply ShareTokenConfig before ownership transfer (if supported).
- `contracts/v3/vault/BaseVault.sol` – `shareToken()`, `rebalance(...)`.
- `contracts/v3/strategies/StrategyRouter.sol` – `setAllocations`, `allocate`, `deallocate`, `harvest`, `totalAssets`.
- `contracts/v3/modules/PayoutPolicy.sol` – Mode enum: 0=Stream, 1=Lockup; streaming behavior and accrual.
- `contracts/v3/modules/LockupPolicy.sol` – lockup behavior, early-exit penalty.
- `contracts/v3/tokens/ShareToken.sol` – transferability and fee settings, constraints.

---

## Flow Summary

1) Step 1: Frontend sends `VaultCreationPayload`; farm owner wallet submits `createApprovedVault` with ShareTokenConfig applied during factory deploy.
2) Retrieve `(farmId, baseVault)` and module addresses from `ProtocolCore.vaultsById(farmId)`.
3) Step 2: Frontend sends `AdapterAttachPayload`; deploy adapters if requested and call `StrategyRouter.setAllocations` with keys/adapters/bps.
