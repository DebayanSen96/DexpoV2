# V3 Latest Deployment - Idempotent Deployment System

This directory contains deployment state files for the V3 IndexSwap system. The deployment script is **idempotent**, meaning it can be safely re-run and will resume from the last successful step.

## 📁 Directory Structure

```
deployments/v3-latest/
├── README.md                 # This file
├── localhost.json            # Localhost deployment state
├── base-sepolia.json         # Base Sepolia deployment state
├── hardhat.json              # Hardhat network deployment state
└── [network-name].json       # Other network deployments
```

## 🔄 How Idempotent Deployment Works

The deployment script (`scripts/deployV3-latest.ts`) automatically:

1. **Saves state after each step** - Every contract deployment is saved to a JSON file
2. **Resumes from last step** - If interrupted, the script picks up where it left off
3. **Skips completed steps** - Already deployed contracts are not re-deployed
4. **Updates state incrementally** - Each successful step updates the state file

### Deployment Steps Tracked

| Step | Component | State Key |
|------|-----------|-----------|
| 0a | DXPToken | `dxpToken` |
| 0b | ProtocolCore | `protocolCore` |
| 0c | MockSwapRouter | `mockSwapRouter` |
| 1 | ModuleRegistry | `moduleRegistry` |
| 2 | SwapModule | `swapModule` |
| 2 | BuySellModule | `buySellModule` |
| 2 | LendModule | `lendModule` |
| 2 | BorrowModule | `borrowModule` |
| 3 | Module Registration | `lastStep: "modulesRegistered"` |
| 4 | IndexSwapFactory | `indexSwapFactory` |
| 5 | Factory Registration | `lastStep: "factoryRegistered"` |
| 6 | Test Tokens | `testTokens` |
| 9 | Test Vault | `testVault` |

## 🚀 Usage

### Fresh Deployment

```bash
# Deploy to localhost
npx hardhat run scripts/deployV3-latest.ts --network localhost

# Deploy to Base Sepolia
npx hardhat run scripts/deployV3-latest.ts --network base-sepolia
```

### Resume Interrupted Deployment

Simply re-run the same command. The script will:
- Load the existing deployment state
- Show which step it's resuming from
- Continue from the last successful step

```bash
# If deployment was interrupted at step 4
npx hardhat run scripts/deployV3-latest.ts --network base-sepolia

# Output:
# 📂 Found existing deployment from 11/23/2025, 11:44:00 AM
#    Last completed step: borrowModule
#    Resuming deployment...
#
# Step 0a: ✅ DXPToken already deployed: 0x...
# Step 0b: ✅ ProtocolCore already deployed: 0x...
# ...
# Step 3: Register Modules in ModuleRegistry...  ← Resumes here
```

### Skip Testing Steps

To deploy infrastructure only without running tests:

```bash
SKIP_TESTING=true npx hardhat run scripts/deployV3-latest.ts --network base-sepolia
```

### Force Fresh Deployment

To start over from scratch, delete the state file:

```bash
# Windows
del deployments\v3-latest\base-sepolia.json

# Linux/Mac
rm deployments/v3-latest/base-sepolia.json

# Then run deployment
npx hardhat run scripts/deployV3-latest.ts --network base-sepolia
```

## 📊 State File Format

Each network's JSON file contains:

```json
{
  "network": "base-sepolia",
  "deployer": "0xC7ab880FE31B36eaF606b9a68e47a9AAbB5fb17B",
  "timestamp": 1700000000000,
  "lastStep": "testVault",
  "dxpToken": "0xE1E77D96eb4a146d158Be062FcaF032c82e39788",
  "protocolCore": "0x22074D0c47bc824E18dE784e28B34aAbaeBCa15E",
  "mockSwapRouter": "0x8C82f93a99518f7381BBb29Cc29128e7C5249042",
  "moduleRegistry": "0xE62c60734cd70809C57b5aCA9DBeB5FA877ae75f",
  "swapModule": "0xdD08b3f0450bB0cF974E1444e6Ae4dcF385B2ac9",
  "buySellModule": "0x146832EeA391F000215367678705604B93cBd16b",
  "lendModule": "0xa33a49d256EC210a859a675CF18A5F5bDA7A51C0",
  "borrowModule": "0xbEAE2AB97616f38824B4E25FC9D8f9c063AD6068",
  "indexSwapFactory": "0x6452025ACc27690b0188AF11110AD59207c38744",
  "testTokens": {
    "usdx": "0xe50E303b29aB28181460D335a1186033Af24Bf82",
    "usdc": "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4",
    "usdt": "0x1D196BCE6Bbea402fEF328AB1Ac50C971497173D",
    "dai": "0x5355419854236B3D9c0675a87Fa560F230127663"
  },
  "testVault": {
    "safe": "0x2cFCfE96bd1dCA29ACbe6CcbAD3f09a286Ac17e9",
    "indexSwap": "0x5269e4BA3fdfEe90Ab55C31322C8018885815E42"
  }
}
```

## ⚠️ Important Notes

### Testing Steps (10-18) Are Not Idempotent

The testing steps (deposit, buy/sell, lend/borrow, rebalance) run every time unless `SKIP_TESTING=true` is set. This is intentional because:
- Tests verify the system works
- Tests can be run multiple times
- Tests don't affect deployment state

### Network-Specific Behavior

**Localhost/Hardhat**:
- Deploys all infrastructure from scratch
- Deploys new test tokens
- Configures MockSwapRouter

**Base Sepolia**:
- Deploys core contracts
- Uses existing MockSwapRouter
- Uses existing test tokens

### State File Location

State files are saved to:
```
deployments/v3-latest/[network-name].json
```

The path is automatically created if it doesn't exist.

## 🔍 Troubleshooting

### "Found existing deployment" but want to redeploy

Delete the state file for that network:
```bash
rm deployments/v3-latest/[network-name].json
```

### Deployment failed mid-step

The script saves state **after** each step completes. If a step fails:
1. Fix the issue (e.g., add more ETH, fix contract bug)
2. Re-run the script
3. It will retry the failed step

### Wrong deployer address in state

If you need to use a different deployer:
1. Delete the state file
2. Run deployment with the new account

### State file corrupted

If the JSON is malformed:
1. Delete the file
2. Start fresh deployment

## 📝 Best Practices

1. **Always check state file** before deployment
   ```bash
   cat deployments/v3-latest/base-sepolia.json
   ```

2. **Backup state files** before major changes
   ```bash
   cp deployments/v3-latest/base-sepolia.json deployments/v3-latest/base-sepolia.backup.json
   ```

3. **Use SKIP_TESTING** for production deployments
   ```bash
   SKIP_TESTING=true npx hardhat run scripts/deployV3-latest.ts --network mainnet
   ```

4. **Verify addresses** after deployment
   - Check state file
   - Verify on block explorer
   - Test basic operations

## 🎯 Benefits of Idempotent Deployment

✅ **Resume after failures** - Network issues, gas problems, etc.  
✅ **Save gas** - Don't redeploy already deployed contracts  
✅ **Audit trail** - Complete deployment history in JSON  
✅ **Reproducible** - Same addresses on re-run  
✅ **Safe** - No accidental re-deployments  

## 📚 Related Documentation

- [Deployment Flow](../../contracts/v3/docs/DEPLOYMENT_FLOW.md)
- [Vault Interaction Reference](../../contracts/v3/docs/VAULT_INTERACTION_REFERENCE.md)
- [Lockup and Operations](../../contracts/v3/docs/LOCKUP_AND_OPERATIONS.md)

---

**Last Updated**: November 23, 2025  
**Script**: `scripts/deployV3-latest.ts`  
**Status**: ✅ Production Ready
