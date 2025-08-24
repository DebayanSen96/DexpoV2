# Adding New Strategy Adapters

This guide explains how to add new strategy adapters to Dexponent v3, wire them to the router, and expose them to the deployment server via templates.

## Overview
- __Adapters implement__: `contracts/v3/interfaces/IStrategyAdapter.sol`
- __Discovery__: JSON templates under `server/templates/<network>/...` (or `server/templates/base/...`)
- __Deployment__: `server/services/strategyService.ts` loads templates, resolves constructor params, deploys, calls post-deploy setters, and wires allocations

---

## 1) Implement the interface
Required methods in `IStrategyAdapter.sol`:
```solidity
interface IStrategyAdapter {
    function asset() external view returns (address);
    function deposit(uint256 amount, bytes calldata params) external returns (uint256 sharesOut);
    function withdraw(uint256 amount, bytes calldata params) external returns (uint256 baseOut);
    function harvest() external returns (uint256 baseDelta, address[] memory rewardTokens, uint256[] memory rewardAmts);
    function totalAssets() external view returns (uint256);
}
```
Guidelines:
- __asset()__: return the base asset address used for TVL and I/O with router.
- __deposit/withdraw__: must be callable by router; enforce access with `onlyRouter` style check.
- __harvest()__: return base delta and any explicit reward token amounts (if none, return zero arrays).
- __totalAssets() view__: DO NOT call non-view external contracts. If you need DEX quotes, cache prices during swaps and use cached values here.

Common additions used across adapters:
- `setRouterOnce(address)` gated to `protocolCore` or its owner.
- Optional setters: `setSlippageBps(uint16)`, `setMinDeposit(uint256)`, `setMinWithdraw(uint256)`.
- Pausing and Ownable admin controls.

Example adapter: `contracts/v3/adapters/BluechipIndexAdapter.sol`.

---

## 2) Compile and verify artifact path
Run:
```bash
npx hardhat compile
```
Confirm your artifact exists at:
```
artifacts/contracts/<path-to-your-adapter>.sol/<AdapterName>.json
```
You will reference this path in the template (relative to repo root).

---

## 3) Create a template JSON
Place a template under either:
- Network-specific: `server/templates/<network>/...`
- Network-agnostic (fallback): `server/templates/base/...`

Template fields (see `server/services/catalog.ts` and `strategyService.ts`):
```json
{
  "id": "index.bluechip.v1",             // unique ID referenced by API
  "title": "Index → Bluechip Basket",
  "kind": "index",                       // free-form; used for client filtering
  "path": ["index", "bluechip", "v1"], // optional breadcrumbs
  "artifact": "artifacts/contracts/v3/adapters/BluechipIndexAdapter.sol/BluechipIndexAdapter.json",
  "constructor": {
    "params": [
      "baseAsset",
      "protocolCore",
      "swapRouter",
      "quoter",
      "tokens",
      "weightsBps",
      "poolFees"
    ]
  },
  "defaults": {
    "tokens": [],
    "weightsBps": [],
    "poolFees": [],
    "swapRouter": "0x2626664c2603336E57B271c5C0b26F421741e481",
    "quoter": "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"
  },
  "postDeploy": {
    "setters": [
      { "fn": "setSlippageBps", "arg": "slippageBps" },
      { "fn": "setMinDeposit",  "arg": "minDeposit"   },
      { "fn": "setMinWithdraw", "arg": "minWithdraw"  }
    ]
  }
}
```
Notes:
- `constructor.params` must match the adapter constructor order. The server will auto-fill `baseAsset` and `protocolCore` if listed.
- `artifact` must point to the compiled artifact JSON.
- `defaults` are used unless overridden by the request payload.
- `postDeploy.setters` supports __single-argument__ functions only. Values come from `defaults` or request overrides.

---

## 4) How the server discovers and deploys
- Discovery: `server/services/catalog.ts`
  - Loads all JSON templates under `server/templates/<network>/**`. If none, falls back to `server/templates/base/**`.
  - Filters out bridge-kind templates by default.
- Deployment: `server/services/strategyService.ts` → `deployAdapterFromTemplateAndWire()`
  - Loads template and artifact.
  - Builds `inputs` from `defaults` + request `overrides`.
  - Auto-resolves `baseAsset` and `protocolCore` from the router when present in `constructor.params`.
  - Deploys adapter.
  - Calls `setRouterOnce(router)` if supported.
  - Applies common setters if present and provided (slippage/mins).
  - Applies `postDeploy.setters` from the template.
  - Computes strategy key as `bytes32(adapterAddress)` and, unless `deployOnly`, wires allocations via `router.setAllocations()`.

---

## 5) Request payload examples
Create farm + deploy and allocate one adapter (POST `/api/v3/create-farm-with-strategies`):
```json
{
  "network": "localhost",
  "payload": {
    "creator": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "asset": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    "farmName": "Bluechip Index",
    "farmSymbol": "dINDEX",
    "recipients": { "ownerRecipient": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
    "splits": { "lpBps": 7000, "ownerBps": 2000, "verifierBps": 1000 },
    "lockConfig": { "enabled": false, "allowEarlyExit": true, "earlyExitBps": 0, "lockupSeconds": 0, "postLockMode": 0 },
    "payoutConfig": { "mode": "Stream", "streamBps": 3000, "compoundBps": 7000, "epochSeconds": 86400, "minHarvestIntervalSeconds": 300, "compoundLpOnLock": true },
    "shareToken": { "transferable": true, "transferFeeBps": 0 }
  },
  "items": [
    {
      "templateId": "index.bluechip.v1",
      "bps": 10000,
      "overrides": {
        "tokens": [],
        "weightsBps": [],
        "poolFees": [],
        "slippageBps": 50,
        "minDeposit": "0",
        "minWithdraw": "0"
      }
    }
  ]
}
```

Deploy-only (no allocation yet): set `items[].bps` to `0` and let the server pass `deployOnly: true` when using internal APIs, or perform wiring later via router.

---

## 6) Adding another adapter: checklist
- __Contract__
  - Implement `IStrategyAdapter` methods.
  - Ensure `totalAssets()` is view-safe.
  - Add `setRouterOnce()` to anchor adapter to router once deployed.
  - Optionally expose `setSlippageBps`, `setMinDeposit`, `setMinWithdraw` setters.
- __Compile__
  - `npx hardhat compile`, verify artifact path.
- __Template__
  - Create `server/templates/<network>/<family>/<name>/v1.json` (or under `base/`).
  - Set a unique `id` (e.g., `dex.<family>.<name>.v1`).
  - Fill `constructor.params` in exact order.
  - Provide `defaults` and `postDeploy.setters` as needed.
- __Test__
  - Call `/api/v3/catalog?network=<network>` and confirm your template is listed.
  - Use `/api/v3/create-farm-with-strategies` with your `templateId`.

---

## 7) Strategy key and IDs
- The server computes the strategy key as `bytes32(adapterAddress)` at deploy time (see `deployAdapterFromTemplateAndWire`).
- You do not need to hardcode a strategy key in the template; the API returns `strategyKeyUsed` and the router allocation tx hash.
- If you require a specific key, you can extend the server to accept it, but the default is deterministic and sufficient in most cases.

---

## 8) Troubleshooting
- __Invalid address__: All addresses must match `^0x[a-fA-F0-9]{40}$`.
- __Missing constructor param__: Ensure every name in `constructor.params` is provided either by defaults, overrides, or resolved (baseAsset/protocolCore).
- __Artifact not found__: Check the `artifact` path in your template.
- __BPS sum errors__: `items[].bps` must sum to 10000 for allocations. Farm `splits` must also sum to 10000.
- __Non-view in totalAssets__: Avoid calling DEX quoters in view; use cached prices or on-chain oracles.

---

## 9) References
- Interface: `contracts/v3/interfaces/IStrategyAdapter.sol`
- Example adapters: `contracts/v3/adapters/`
- Template loader: `server/services/catalog.ts`
- Deployer/wirer: `server/services/strategyService.ts`
- Example template: `server/templates/base/index/bluechip/v1.json`
