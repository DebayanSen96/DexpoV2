# Idempotent Deployment System

Complete guide to the idempotent deployment system for V3 IndexSwap infrastructure.

## 🎯 Overview

The V3 deployment script (`scripts/deployV3-latest.ts`) is **idempotent**, meaning:
- ✅ Can be safely re-run multiple times
- ✅ Resumes from last successful step
- ✅ Skips already deployed contracts
- ✅ Saves state after each step
- ✅ Handles interruptions gracefully

## 📋 How It Works

### State Persistence

After each successful deployment step, the script saves the current state to:
```
deployments/v3-latest/[network-name].json
```

**Example state file**:
```json
{
  "network": "base-sepolia",
  "deployer": "0xC7ab...",
  "timestamp": 1700000000000,
  "lastStep": "testVault",
  "dxpToken": "0xE1E7...",
  "protocolCore": "0x2207...",
  "mockSwapRouter": "0x8C82...",
  "moduleRegistry": "0xE62c...",
  "swapModule": "0xdD08...",
  "buySellModule": "0x1468...",
  "lendModule": "0xa33a...",
  "borrowModule": "0xbEAE...",
  "indexSwapFactory": "0x6452...",
  "testTokens": {
    "usdx": "0xe50E...",
    "usdc": "0x822f...",
    "usdt": "0x1D19...",
    "dai": "0x5355..."
  },
  "testVault": {
    "safe": "0x2cFC...",
    "indexSwap": "0x5269..."
  }
}
```

### Deployment Flow

```
┌─────────────────────────────────────┐
│  Start Deployment Script            │
└──────────┬──────────────────────────┘
           │
           ▼
    ┌──────────────┐
    │ Load State?  │
    └──┬────────┬──┘
       │ No     │ Yes
       │        │
       ▼        ▼
    Fresh   Resume from
    Deploy  Last Step
       │        │
       └────┬───┘
            │
            ▼
    ┌───────────────────┐
    │ For Each Step:    │
    │ 1. Check if done  │
    │ 2. Deploy if not  │
    │ 3. Save state     │
    └─────────┬─────────┘
              │
              ▼
       ┌──────────────┐
       │ All Steps    │
       │ Complete     │
       └──────────────┘
```

## 🚀 Usage Examples

### 1. Fresh Deployment

```bash
# Deploy to Base Sepolia
npx hardhat run scripts/deployV3-latest.ts --network base-sepolia
```

**Output**:
```
🆕 Starting fresh deployment...

Step 0a: Deploy DXPToken...
DXPToken deployed to: 0xE1E7...
💾 Saved deployment state to deployments/v3-latest/base-sepolia.json

Step 0b: Deploy ProtocolCore...
ProtocolCore deployed to: 0x2207...
💾 Saved deployment state to deployments/v3-latest/base-sepolia.json

...
```

### 2. Resume After Interruption

If deployment fails at step 4 (e.g., network issue, gas problem):

```bash
# Simply re-run the same command
npx hardhat run scripts/deployV3-latest.ts --network base-sepolia
```

**Output**:
```
📂 Found existing deployment from 11/23/2025, 11:44:00 AM
   Last completed step: borrowModule
   Resuming deployment...

Step 0a: ✅ DXPToken already deployed: 0xE1E7...
Step 0b: ✅ ProtocolCore already deployed: 0x2207...
Step 1: ✅ ModuleRegistry already deployed: 0xE62c...
Step 2: Deploy Shared Modules...
✅ SwapModule already deployed: 0xdD08...
✅ BuySellModule already deployed: 0x1468...
✅ LendModule already deployed: 0xa33a...
✅ BorrowModule already deployed: 0xbEAE...

Step 3: Register Modules in ModuleRegistry...  ← Resumes here
SwapModule registered
...
```

### 3. Deploy Infrastructure Only (Skip Testing)

```bash
SKIP_TESTING=true npx hardhat run scripts/deployV3-latest.ts --network base-sepolia
```

**Output**:
```
...
Step 9: ✅ Test vault already created
  Safe: 0x2cFC...
  IndexSwap: 0x5269...

⏭️  Skipping testing steps (SKIP_TESTING=true)

============================================================
DEPLOYMENT SUMMARY
============================================================
...
```

### 4. Force Fresh Deployment

```bash
# Delete state file
rm deployments/v3-latest/base-sepolia.json

# Run deployment
npx hardhat run scripts/deployV3-latest.ts --network base-sepolia
```

## 📊 Deployment Steps

| Step | Component | Idempotent | State Key |
|------|-----------|------------|-----------|
| 0a | DXPToken | ✅ Yes | `dxpToken` |
| 0b | ProtocolCore | ✅ Yes | `protocolCore` |
| 0c | MockSwapRouter | ✅ Yes | `mockSwapRouter` |
| 1 | ModuleRegistry | ✅ Yes | `moduleRegistry` |
| 2a | SwapModule | ✅ Yes | `swapModule` |
| 2b | BuySellModule | ✅ Yes | `buySellModule` |
| 2c | LendModule | ✅ Yes | `lendModule` |
| 2d | BorrowModule | ✅ Yes | `borrowModule` |
| 3 | Register Modules | ✅ Yes | `lastStep: "modulesRegistered"` |
| 4 | IndexSwapFactory | ✅ Yes | `indexSwapFactory` |
| 5 | Register Factory | ✅ Yes | `lastStep: "factoryRegistered"` |
| 6 | Test Tokens | ✅ Yes | `testTokens` |
| 7-8 | Configure Router | ⚠️ Conditional | - |
| 9 | Create Test Vault | ✅ Yes | `testVault` |
| 10-18 | Testing | ❌ No | - |

**Legend**:
- ✅ Yes: Fully idempotent, skipped if already done
- ⚠️ Conditional: Only runs on localhost/hardhat
- ❌ No: Runs every time (unless `SKIP_TESTING=true`)

## 🔍 State Checks

The script checks state before each step:

```typescript
// Example: Deploy DXPToken
if (!state.dxpToken) {
  console.log("Step 0a: Deploy DXPToken...");
  const DXPToken = await ethers.getContractFactory("DXPToken");
  const dxpToken = await DXPToken.deploy();
  await dxpToken.waitForDeployment();
  const dxpAddress = await dxpToken.getAddress();
  
  state.dxpToken = dxpAddress;
  state.lastStep = "dxpToken";
  saveDeploymentState(network.name, state);
} else {
  console.log("Step 0a: ✅ DXPToken already deployed:", state.dxpToken);
}
```

## ⚙️ Configuration

### Environment Variables

```bash
# Skip testing steps
SKIP_TESTING=true

# Use custom test wallet (Base Sepolia)
TEST_WALLET_PRIVATE_KEY=0x...

# Use existing MockSwapRouter
MOCK_SWAP_ROUTER=0x8C82...

# Use existing test tokens
BASE_SEPOLIA_USDX=0xe50E...
BASE_SEPOLIA_USDC=0x822f...
BASE_SEPOLIA_USDT=0x1D19...
BASE_SEPOLIA_DAI=0x5355...
```

### Network-Specific Behavior

**Hardhat/Localhost**:
```typescript
- Deploys all infrastructure
- Deploys new test tokens
- Configures MockSwapRouter
- Adds liquidity
```

**Base Sepolia**:
```typescript
- Deploys core contracts
- Uses existing MockSwapRouter
- Uses existing test tokens
- No router configuration needed
```

## 🛡️ Safety Features

### 1. Atomic State Updates

State is saved **after** each step completes successfully:

```typescript
await contract.waitForDeployment();  // Wait for confirmation
const address = await contract.getAddress();

state.contract = address;  // Update state
state.lastStep = "contract";
saveDeploymentState(network.name, state);  // Save atomically
```

### 2. Step Dependencies

Steps are executed in order with proper dependencies:

```typescript
// Can't deploy factory without modules
if (!state.swapModule || !state.buySellModule || ...) {
  throw new Error("Modules must be deployed first");
}

// Can't register factory without deploying it
if (state.lastStep === "indexSwapFactory") {
  await protocolCore.setIndexSwapFactory(factoryAddress);
}
```

### 3. Network Validation

State files are network-specific:

```typescript
const state = loadDeploymentState(network.name);
if (state && state.network !== network.name) {
  throw new Error("Network mismatch!");
}
```

## 📝 Best Practices

### 1. Always Check State Before Deployment

```bash
# View current state
cat deployments/v3-latest/base-sepolia.json

# Or use jq for pretty printing
cat deployments/v3-latest/base-sepolia.json | jq
```

### 2. Backup State Files

```bash
# Before major changes
cp deployments/v3-latest/base-sepolia.json \
   deployments/v3-latest/base-sepolia.backup.json
```

### 3. Use SKIP_TESTING for Production

```bash
# Production deployment
SKIP_TESTING=true npx hardhat run scripts/deployV3-latest.ts --network mainnet
```

### 4. Verify After Each Major Step

```bash
# After factory deployment
npx hardhat verify --network base-sepolia \
  0x6452025ACc27690b0188AF11110AD59207c38744 \
  0x22074D0c47bc824E18dE784e28B34aAbaeBCa15E \
  0xE62c60734cd70809C57b5aCA9DBeB5FA877ae75f \
  0x8C82f93a99518f7381BBb29Cc29128e7C5249042
```

### 5. Monitor Gas Usage

```bash
# Check gas prices before deployment
cast gas-price --rpc-url https://sepolia.base.org

# Use gas limit if needed
npx hardhat run scripts/deployV3-latest.ts \
  --network base-sepolia \
  --gas-limit 10000000
```

## 🐛 Troubleshooting

### Issue: "Found existing deployment" but contracts don't exist

**Cause**: State file exists but contracts were deployed on a different chain or reset

**Solution**:
```bash
# Delete state file
rm deployments/v3-latest/[network].json

# Redeploy
npx hardhat run scripts/deployV3-latest.ts --network [network]
```

### Issue: Deployment fails mid-step

**Cause**: Network issue, insufficient gas, contract bug

**Solution**:
1. Fix the underlying issue
2. Re-run the script (it will retry the failed step)
3. State is saved **after** each step, so no progress is lost

### Issue: Wrong deployer address

**Cause**: Different account used than in state file

**Solution**:
```bash
# Option 1: Use same account
export PRIVATE_KEY=0x...  # Same as in state file

# Option 2: Start fresh
rm deployments/v3-latest/[network].json
```

### Issue: State file corrupted

**Cause**: Manual editing, disk error

**Solution**:
```bash
# Restore from backup
cp deployments/v3-latest/[network].backup.json \
   deployments/v3-latest/[network].json

# Or start fresh
rm deployments/v3-latest/[network].json
```

## 📈 Benefits

### 1. Resume After Failures

Network issues, gas problems, rate limits - just re-run:

```bash
# Deployment interrupted at step 4
# Simply re-run
npx hardhat run scripts/deployV3-latest.ts --network base-sepolia
```

### 2. Save Gas

Don't redeploy contracts that already exist:

```
Fresh deployment: ~15M gas
Resume from step 4: ~8M gas saved
```

### 3. Audit Trail

Complete deployment history in JSON:

```json
{
  "timestamp": 1700000000000,
  "deployer": "0xC7ab...",
  "dxpToken": "0xE1E7...",
  "protocolCore": "0x2207...",
  ...
}
```

### 4. Reproducible

Same addresses on re-run (if state exists):

```bash
# Run 1
IndexSwapFactory: 0x6452...

# Run 2 (resumes)
IndexSwapFactory: 0x6452...  # Same address
```

### 5. Safe

No accidental re-deployments:

```typescript
if (!state.protocolCore) {
  // Deploy
} else {
  // Skip, already deployed
}
```

## 🔗 Related Documentation

- [Deployment README](../../../deployments/v3-latest/README.md)
- [Deployment Flow](./DEPLOYMENT_FLOW.md)
- [Vault Interaction Reference](./VAULT_INTERACTION_REFERENCE.md)

---

**Last Updated**: November 23, 2025  
**Script**: `scripts/deployV3-latest.ts`  
**Status**: ✅ Production Ready
