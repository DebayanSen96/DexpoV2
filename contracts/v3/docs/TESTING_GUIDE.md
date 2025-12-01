# IndexSwap System Testing Guide

## Overview

This guide explains how to test the IndexSwap vault system using the comprehensive test script.

## Prerequisites

1. **Start Hardhat Local Node**:
   ```bash
   npx hardhat node
   ```

2. **Deploy the System** (in another terminal):
   ```bash
   npx hardhat run scripts/deploy-indexswap-system.ts --network localhost
   ```

## Running the Complete Test

```bash
npx hardhat run scripts/test-indexswap-complete.ts --network localhost
```

## What the Test Covers

### 1. **Vault Creation**
- Creates a vault with multi-token portfolio (WETH, USDC, WBTC)
- Initial weights: 50% WETH, 30% USDC, 20% WBTC
- Deploys VaultSafe (multisig owner) and IndexSwap (vault logic)

**Key Metrics to Check**:
- Safe address
- IndexSwap address
- Initial portfolio weights

### 2. **Multi-Token Deposits**
- Tests deposits from multiple users
- Each deposit receives proportional shares based on USD value
- Share price calculated as: `TVL / Total Shares`

**Example**:
```
Deployer deposits: 2 WETH + 3000 USDC + 0.04 WBTC = $10,000
Receives: 10,000 shares (first deposit, 1:1 ratio)

User1 deposits: 1 WETH + 1500 USDC + 0.02 WBTC = $5,000
Receives: 3,333.33 shares (at share price of $1.50)
```

**Key Metrics to Check**:
- Shares received match deposit value / share price
- Token balances in vault match deposits
- TVL increases correctly

### 3. **TVL Calculation**
Total Value Locked is calculated as:
```
TVL = Σ(token balance × token price in USD)
    + Σ(lending positions)
    - Σ(borrowing positions)
```

**Key Metrics to Check**:
- TVL matches sum of all token values
- Share price = TVL / Total Supply
- Accurate across multiple deposits

### 4. **User Position Tracking**
Each user's position is tracked via ERC20 share tokens.

**Metrics Displayed**:
- **Shares Held**: User's share balance
- **Position Value**: `(User Shares × TVL) / Total Supply`
- **Ownership %**: `(User Shares / Total Supply) × 100`

**Example Output**:
```
👤 Deployer Position:
  Shares: 10,000
  Value: $11,250 USD
  Ownership: 75%

👤 User1 Position:
  Shares: 3,333.33
  Value: $3,750 USD
  Ownership: 24%
```

### 5. **Portfolio Weight Updates**
Vault owner can update target allocation weights.

**Test Flow**:
1. Initial weights: 50/30/20 (WETH/USDC/WBTC)
2. Update to: 40/40/20
3. Verify new weights are stored

**Key Metrics to Check**:
- Portfolio weights updated correctly
- Weights sum to 10,000 (100%)
- No immediate rebalancing (requires explicit call)

### 6. **Rebalancing**
Adjusts actual holdings to match target weights via swaps.

**Before Rebalance**:
```
Holdings: 3 WETH ($7,500), 4,500 USDC ($4,500), 0.06 WBTC ($3,000)
Actual: 50% / 30% / 20%
Target: 40% / 40% / 20%
```

**After Rebalance**:
```
Holdings: 2.4 WETH ($6,000), 6,000 USDC ($6,000), 0.06 WBTC ($3,000)
Actual: 40% / 40% / 20% ✅
```

**Key Metrics to Check**:
- Token balances adjusted to match target weights
- TVL remains approximately constant (minus swap fees)
- Proportions match target weights

### 7. **Withdrawals**
Users can withdraw proportional amounts of all portfolio tokens.

**Test Flow**:
1. User1 withdraws 50% of shares (1,666.67 shares)
2. Receives proportional tokens from vault
3. Remaining shares: 1,666.67

**Key Metrics to Check**:
- Share balance decreases correctly
- User receives proportional tokens
- TVL decreases by withdrawal value
- Share price remains stable

## Key Formulas

### Share Price Calculation
```
Share Price = TVL / Total Supply
```

### Shares on Deposit
```
Shares Minted = Deposit Value (USD) / Current Share Price
```

### Withdrawal Amount
```
Token Amount = (Shares Burned / Total Supply) × Token Balance
```

### Position Value
```
User Value = (User Shares / Total Supply) × TVL
```

## Expected Test Results

### ✅ Success Criteria

1. **Vault Creation**: Safe and IndexSwap deployed successfully
2. **Deposits**: 
   - Shares minted correctly based on USD value
   - Token balances match deposits
3. **TVL**: Accurately reflects all holdings
4. **Share Price**: Calculated correctly as TVL / Supply
5. **User Positions**: Tracked accurately with correct ownership %
6. **Weight Updates**: Portfolio weights change without affecting holdings
7. **Rebalancing**: Holdings adjusted to match target weights
8. **Withdrawals**: Users receive proportional tokens, shares burned

### 📊 Sample Output Metrics

```
Final Vault Metrics:
  TVL: $13,125 USD
  Share Price: $1.125 USD
  Total Supply: 11,666.67 shares

Deployer Position:
  Shares: 10,000
  Value: $11,250 USD
  Ownership: 75%

User1 Position:
  Shares: 1,666.67
  Value: $1,875 USD
  Ownership: 14%
```

## Troubleshooting

### Common Issues

**1. "Transaction reverted without a reason"**
- Ensure Hardhat node is running
- Redeploy system if contracts changed
- Delete `deployments/hardhat/hardhat.json` before redeploying

**2. "Invalid amounts length"**
- Deposit amounts array must match portfolio length
- Check portfolio has correct number of tokens

**3. "Weights must sum to 100%"**
- Portfolio weights must sum to exactly 10,000 (basis points)
- Example: [4000, 4000, 2000] = 100%

**4. "Not authorized"**
- Only Safe owners or protocol owner can manage vault
- Check caller is authorized

## Advanced Testing

### Testing Module Operations

**Swap Module**:
```typescript
const swapModule = await ethers.getContractAt("SwapModule", SWAP_MODULE_ADDRESS);
await swapModule.swap(vaultAddress, tokenIn, tokenOut, amountIn);
```

**Lend Module**:
```typescript
const lendModule = await ethers.getContractAt("LendModule", LEND_MODULE_ADDRESS);
await lendModule.lend(vaultAddress, token, amount);
const position = await lendModule.getPosition(vaultAddress, token);
```

**Borrow Module**:
```typescript
const borrowModule = await ethers.getContractAt("BorrowModule", BORROW_MODULE_ADDRESS);
await borrowModule.borrow(vaultAddress, token, amount);
```

### Testing Multisig Operations

```typescript
const safe = await ethers.getContractAt("VaultSafe", safeAddress);

// Submit transaction
const data = vault.interface.encodeFunctionData("rebalance", []);
const txHash = await safe.submitTransaction(vaultAddress, 0, data);

// Confirm (if threshold > 1)
await safe.connect(owner2).confirmTransaction(txHash);

// Execute
await safe.executeTransaction(txHash);
```

## Metrics to Monitor

### Vault Health
- **TVL**: Should increase with deposits, decrease with withdrawals
- **Share Price**: Should remain stable or increase (never decrease without withdrawals)
- **Total Supply**: Increases with deposits, decreases with withdrawals

### User Positions
- **Share Balance**: User's ownership in the vault
- **Position Value**: Real-time USD value of user's shares
- **Ownership %**: User's share of total vault

### Portfolio Composition
- **Token Balances**: Actual holdings in vault
- **Target Weights**: Desired allocation percentages
- **Actual Weights**: Current allocation percentages
- **Rebalance Needed**: Difference between target and actual

## Continuous Testing

For ongoing development, run the test after any changes to:
- Vault contracts (VaultSafe, IndexSwap)
- Module contracts (Swap, BuySell, Lend, Borrow)
- Factory contracts (IndexSwapFactory)
- Core contracts (ProtocolCore, ModuleRegistry)

Always test on localhost before deploying to testnet or mainnet.

## Next Steps

After successful localhost testing:
1. Deploy to Base Sepolia testnet
2. Test with real testnet tokens
3. Verify all functionality in production-like environment
4. Audit contracts before mainnet deployment
