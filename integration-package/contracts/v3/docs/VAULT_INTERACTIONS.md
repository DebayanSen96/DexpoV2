# IndexSwap Vault Interaction Guide

## Overview

This guide explains how Asset Managers can interact with their IndexSwap vaults to perform various operations including manual trading, lending, borrowing, and rebalancing.

## Table of Contents
1. [Access Control](#access-control)
2. [Manual Operations](#manual-operations)
3. [Automatic Rebalancing](#automatic-rebalancing)
4. [TVL and Metrics Calculation](#tvl-and-metrics-calculation)
5. [Fund Flow Diagrams](#fund-flow-diagrams)

---

## Access Control

### Who Can Perform Operations?

**Safe Owners** (Asset Managers) can perform ALL vault operations:
- ✅ Manual swaps
- ✅ Buy/Sell tokens
- ✅ Lend assets
- ✅ Borrow assets
- ✅ Rebalance portfolio
- ✅ Update portfolio weights
- ✅ Approve tokens for modules

**Protocol Owner** also has access to all operations for admin purposes.

### Authorization Flow

```solidity
modifier onlyAuthorized(address vault) {
    bool isSafeOwner = IVaultSafe(vault).isOwner(msg.sender);
    bool isProtocolOwner = (msg.sender == protocolCore.owner());
    require(isSafeOwner || isProtocolOwner, "Not authorized");
    _;
}
```

---

## Manual Operations

Asset Managers can manually execute DeFi operations WITHOUT relying on automatic rebalancing.

### 1. Manual Token Swaps

**Use Case**: Swap one portfolio token for another

**Steps**:
```typescript
// 1. Get module and vault contracts
const swapModule = await ethers.getContractAt("SwapModule", SWAP_MODULE_ADDRESS);
const vault = await ethers.getContractAt("IndexSwap", vaultAddress);

// 2. Approve the swap module to spend vault's tokens
const amountIn = ethers.parseEther("100"); // 100 WETH
await vault.approveToken(WETH_ADDRESS, SWAP_MODULE_ADDRESS, amountIn);

// 3. Execute swap
await swapModule.swap(
    vaultAddress,
    WETH_ADDRESS,  // tokenIn
    USDC_ADDRESS,  // tokenOut
    amountIn
);
```

**Fund Flow**:
```
Vault (WETH) → SwapModule → MockSwapRouter → SwapModule → Vault (USDC)
```

### 2. Buy/Sell Tokens

**Use Case**: Buy a new token or sell an existing one

**Steps**:
```typescript
const buySellModule = await ethers.getContractAt("BuySellModule", BUYSELL_MODULE_ADDRESS);

// Buy a token
await vault.approveToken(USDC_ADDRESS, BUYSELL_MODULE_ADDRESS, ethers.parseUnits("5000", 6));
await buySellModule.buy(
    vaultAddress,
    USDC_ADDRESS,     // paymentToken
    WBTC_ADDRESS,     // tokenToBuy
    ethers.parseUnits("5000", 6)  // paymentAmount
);

// Sell a token
await vault.approveToken(WBTC_ADDRESS, BUYSELL_MODULE_ADDRESS, ethers.parseUnits("0.1", 8));
await buySellModule.sell(
    vaultAddress,
    WBTC_ADDRESS,     // tokenToSell
    USDC_ADDRESS,     // receiveToken
    ethers.parseUnits("0.1", 8)  // sellAmount
);
```

**Fund Flow (Buy)**:
```
Vault (USDC) → BuySellModule → MockSwapRouter → BuySellModule → Vault (WBTC)
```

### 3. Lend Assets

**Use Case**: Lend idle assets to earn yield

**Steps**:
```typescript
const lendModule = await ethers.getContractAt("LendModule", LEND_MODULE_ADDRESS);

// 1. Approve lend module
const lendAmount = ethers.parseUnits("5000", 6); // 5000 USDC
await vault.approveToken(USDC_ADDRESS, LEND_MODULE_ADDRESS, lendAmount);

// 2. Lend
await lendModule.lend(
    vaultAddress,
    USDC_ADDRESS,
    lendAmount
);

// 3. Check position
const position = await lendModule.getPosition(vaultAddress, USDC_ADDRESS);
console.log("Principal:", position.principal);
console.log("Accrued:", position.accrued);
console.log("APR:", position.aprBps / 100, "%");
```

**Fund Flow**:
```
Vault (USDC) → LendModule (holds and accrues interest)
```

**Interest Accrual**:
- Interest accrues every second based on APR
- Formula: `interest = principal × (aprBps / 10000) × (elapsed / 365 days)`
- Default APR: 5% (500 bps)

### 4. Borrow Assets

**Use Case**: Borrow assets for leverage or liquidity

**Steps**:
```typescript
const borrowModule = await ethers.getContractAt("BorrowModule", BORROW_MODULE_ADDRESS);

// 1. Borrow (no approval needed, funds come TO vault)
const borrowAmount = ethers.parseEther("2"); // 2 WETH
await borrowModule.borrow(
    vaultAddress,
    WETH_ADDRESS,
    borrowAmount
);

// 2. Check position
const position = await borrowModule.getPosition(vaultAddress, WETH_ADDRESS);
console.log("Principal:", position.principal);
console.log("Accrued Debt:", position.accrued);
console.log("APR:", position.aprBps / 100, "%");

// 3. Repay (partial or full)
const repayAmount = ethers.parseEther("1");
await vault.approveToken(WETH_ADDRESS, BORROW_MODULE_ADDRESS, repayAmount);
await borrowModule.repay(
    vaultAddress,
    WETH_ADDRESS,
    repayAmount
);
```

**Fund Flow (Borrow)**:
```
BorrowModule → Vault (borrowed assets)
```

**Fund Flow (Repay)**:
```
Vault → BorrowModule (repayment)
```

**Interest Accrual**:
- Interest accrues every second based on APR
- Formula: `interest = principal × (aprBps / 10000) × (elapsed / 365 days)`
- Default APR: 8% (800 bps)

---

## Automatic Rebalancing

### What is Rebalancing?

Rebalancing adjusts the vault's actual token holdings to match the target portfolio weights.

### When to Rebalance?

**Manual Trigger**: Asset managers call `rebalance()` when they want to adjust holdings.

**Automatic**: NOT automatic - must be explicitly called.

### How Rebalancing Works

```typescript
const vault = await ethers.getContractAt("IndexSwap", vaultAddress);

// 1. Update portfolio weights (if needed)
const newPortfolio = [
    { token: WETH_ADDRESS, weightBps: 4000 },  // 40%
    { token: USDC_ADDRESS, weightBps: 4000 },  // 40%
    { token: WBTC_ADDRESS, weightBps: 2000 }   // 20%
];
await vault.setPortfolio(newPortfolio);

// 2. Trigger rebalance
await vault.rebalance();
```

### Rebalancing Algorithm

1. **Calculate Target Values**:
   ```
   Target Value (token) = TVL × (weight / 10000)
   ```

2. **Calculate Current Values**:
   ```
   Current Value (token) = balance × price
   ```

3. **Determine Actions**:
   - If `current > target`: Sell excess
   - If `current < target`: Buy more

4. **Execute Swaps**:
   - Swaps executed via `MockSwapRouter`
   - Slippage handled by router's quote system

### Example

**Before Rebalance**:
```
Portfolio: 50% WETH, 30% USDC, 20% WBTC
Holdings: 3 WETH ($7,500), 4,500 USDC ($4,500), 0.06 WBTC ($3,000)
TVL: $15,000
```

**Update Weights to**: 40% WETH, 40% USDC, 20% WBTC

**After Rebalance**:
```
Target: $6,000 WETH, $6,000 USDC, $3,000 WBTC
Holdings: 2.4 WETH ($6,000), 6,000 USDC ($6,000), 0.06 WBTC ($3,000)
```

**Actions Taken**:
- Sold 0.6 WETH for $1,500
- Bought $1,500 worth of USDC
- WBTC unchanged (already at target)

---

## TVL and Metrics Calculation

### Total Value Locked (TVL)

TVL includes ALL vault assets:

```solidity
function getTotalValueUsd() public view returns (uint256 totalUsd) {
    // 1. Token holdings
    for (uint256 i = 0; i < portfolio.length; i++) {
        address token = portfolio[i].token;
        uint256 balance = IERC20(token).balanceOf(address(this));
        totalUsd += _getTokenValueUsd(token, balance);
    }
    
    // 2. Add lending positions
    if (lendModule != address(0)) {
        uint256 lendValue = IPositionModule(lendModule).getPositionValue(address(this), address(0));
        totalUsd += lendValue;
    }
    
    // 3. Subtract borrowing positions
    if (borrowModule != address(0)) {
        uint256 borrowValue = IPositionModule(borrowModule).getPositionValue(address(this), address(0));
        totalUsd -= borrowValue;
    }
}
```

### Formula Breakdown

**Token Value**:
```
Token Value (USD) = balance × priceUsdE18 / (10 ** decimals)
```

**Lending Value**:
```
Lend Value = principal + accrued_interest
Accrued Interest = principal × (apr / 10000) × (elapsed / 365 days)
```

**Borrowing Value**:
```
Borrow Value = principal + accrued_interest
Accrued Interest = principal × (apr / 10000) × (elapsed / 365 days)
```

**Net TVL**:
```
TVL = Σ(token holdings) + Σ(lend positions) - Σ(borrow positions)
```

### Share Price

```
Share Price = TVL / Total Supply
```

### User Position Value

```
User Value = (User Shares / Total Supply) × TVL
```

### Calculating Metrics for API Response

Based on your example JSON, here's how to calculate each metric:

```typescript
// Get vault contract
const vault = await ethers.getContractAt("IndexSwap", vaultAddress);

// 1. Total Supply
const totalSupply = await vault.totalSupply();

// 2. TVL (includes holdings + lending - borrowing)
const tvlUsd = await vault.getTotalValueUsd();

// 3. Share Price
const sharePrice = tvlUsd / totalSupply;

// 4. Get portfolio tokens
const portfolio = await vault.getPortfolio();

// 5. Calculate per-token metrics
const supportedAssets = [];
for (let i = 0; i < portfolio.length; i++) {
    const tokenAddr = portfolio[i][0];
    const weightBps = portfolio[i][1];
    
    // Get token contract
    const token = await ethers.getContractAt("IERC20Metadata", tokenAddr);
    const decimals = await token.decimals();
    const symbol = await token.symbol();
    const name = await token.name();
    
    // Get balance
    const balance = await token.balanceOf(vaultAddress);
    
    // Get price from router
    const router = await ethers.getContractAt("MockSwapRouter", routerAddress);
    const priceUsd = await router.priceUsdE18(tokenAddr);
    
    // Calculate USD value
    const usdValue = (balance * priceUsd) / (10n ** BigInt(decimals));
    
    supportedAssets.push({
        token: tokenAddr,
        tokenSymbol: symbol,
        tokenName: name,
        tokenDecimals: decimals,
        amount: ethers.formatUnits(balance, decimals),
        amountBaseUnits: balance.toString(),
        usdValue: ethers.formatEther(usdValue),
        weightBps: Number(weightBps),
        weightPct: Number(weightBps) / 100
    });
}

// 6. Idle vs Invested calculation
let idleAssets = 0n;
let investedAssets = 0n;

// Tokens in vault = idle
for (const asset of supportedAssets) {
    idleAssets += BigInt(asset.amountBaseUnits);
}

// Lent assets = invested
if (lendModule) {
    for (const asset of supportedAssets) {
        const lendPos = await lendModule.getPosition(vaultAddress, asset.token);
        investedAssets += lendPos.accrued;
    }
}

// 7. Total assets = idle + invested
const totalAssets = idleAssets + investedAssets;

// 8. Response object
const response = {
    vaultAddress: vaultAddress,
    totalSupply: ethers.formatEther(totalSupply),
    tvlUsd: ethers.formatEther(tvlUsd),
    pricePerShare: ethers.formatEther(sharePrice),
    totalAssets: totalAssets.toString(),
    idleAssets: idleAssets.toString(),
    investedAssets: investedAssets.toString(),
    supportedAssets: supportedAssets
};
```

### Metrics Explanation

| Metric | Description | Calculation |
|--------|-------------|-------------|
| `totalAssets` | Total base asset equivalent | Sum of all holdings in base asset terms |
| `idleAssets` | Assets sitting in vault | Token balances in vault |
| `investedAssets` | Assets in DeFi positions | Lent + LP positions |
| `tvlUsd` | Total Value in USD | Holdings + Lent - Borrowed |
| `pricePerShare` | Value per share token | TVL / Total Supply |
| `weightBps` | Target allocation | Set by asset manager (basis points) |
| `weightPct` | Target allocation % | weightBps / 100 |

---

## Fund Flow Diagrams

### Deposit Flow

```
User
  │
  ├─> Approve tokens to IndexSwap
  │
  └─> Call deposit([amounts])
        │
        ├─> Transfer tokens from user to vault
        ├─> Calculate USD value of deposit
        ├─> Calculate shares = value / sharePrice
        └─> Mint shares to user
```

### Withdrawal Flow

```
User
  │
  └─> Call withdraw(shares)
        │
        ├─> Calculate proportion = shares / totalSupply
        ├─> For each portfolio token:
        │     └─> Transfer (balance × proportion) to user
        └─> Burn shares from user
```

### Swap Flow

```
Asset Manager
  │
  ├─> Call vault.approveToken(tokenIn, swapModule, amount)
  │
  └─> Call swapModule.swap(vault, tokenIn, tokenOut, amount)
        │
        ├─> Transfer tokenIn from vault to swapModule
        ├─> Approve tokenIn to router
        ├─> Call router.swapFrom()
        │     └─> Router executes swap at fixed price
        └─> Transfer tokenOut to vault
```

### Lend Flow

```
Asset Manager
  │
  ├─> Call vault.approveToken(token, lendModule, amount)
  │
  └─> Call lendModule.lend(vault, token, amount)
        │
        ├─> Transfer token from vault to lendModule
        ├─> Create/update lending position
        │     ├─> principal += amount
        │     ├─> lastAccrualTime = now
        │     └─> aprBps = defaultApr
        └─> Interest accrues over time
```

### Borrow Flow

```
Asset Manager
  │
  └─> Call borrowModule.borrow(vault, token, amount)
        │
        ├─> Transfer token from borrowModule to vault
        ├─> Create/update borrow position
        │     ├─> principal += amount
        │     ├─> lastAccrualTime = now
        │     └─> aprBps = defaultApr
        └─> Interest accrues over time

Repayment:
  │
  ├─> Call vault.approveToken(token, borrowModule, amount)
  │
  └─> Call borrowModule.repay(vault, token, amount)
        │
        ├─> Calculate accrued debt
        ├─> Transfer repayment from vault to borrowModule
        └─> Reduce principal by repaid amount
```

### Rebalance Flow

```
Asset Manager
  │
  ├─> (Optional) Call vault.setPortfolio(newWeights)
  │
  └─> Call vault.rebalance()
        │
        ├─> Calculate TVL
        ├─> For each token:
        │     ├─> targetValue = TVL × weight
        │     ├─> currentValue = balance × price
        │     └─> delta = targetValue - currentValue
        │
        ├─> If delta > 0: Buy more
        │     ├─> Find token with excess
        │     ├─> Approve swap module
        │     └─> Swap excess → needed token
        │
        └─> If delta < 0: Sell excess
              ├─> Approve swap module
              └─> Swap excess → needed token
```

---

## Best Practices

### 1. Check Balances Before Operations

```typescript
const balance = await token.balanceOf(vaultAddress);
if (balance < amountNeeded) {
    throw new Error("Insufficient balance");
}
```

### 2. Monitor Lending/Borrowing Positions

```typescript
const lendPos = await lendModule.getPosition(vaultAddress, tokenAddress);
const borrowPos = await borrowModule.getPosition(vaultAddress, tokenAddress);

// Check health ratio
const healthRatio = lendPos.accrued / borrowPos.accrued;
if (healthRatio < 1.5) {
    console.warn("Low health ratio - consider repaying or adding collateral");
}
```

### 3. Rebalance Regularly

```typescript
// Check if rebalance is needed
const portfolio = await vault.getPortfolio();
let needsRebalance = false;

for (let i = 0; i < portfolio.length; i++) {
    const token = portfolio[i][0];
    const targetWeight = portfolio[i][1];
    
    const balance = await IERC20(token).balanceOf(vaultAddress);
    const value = await vault._getTokenValueUsd(token, balance);
    const tvl = await vault.getTotalValueUsd();
    
    const actualWeight = (value * 10000n) / tvl;
    const deviation = Math.abs(Number(actualWeight - targetWeight));
    
    if (deviation > 500) { // 5% deviation
        needsRebalance = true;
        break;
    }
}

if (needsRebalance) {
    await vault.rebalance();
}
```

### 4. Gas Optimization

- Batch operations when possible
- Use `approveToken` once for multiple operations
- Rebalance during low gas periods

---

## Summary

**Manual Operations**: ✅ YES - Asset managers can manually call swap, buy/sell, lend, borrow

**Automatic Rebalancing**: ❌ NO - Must manually call `rebalance()`

**TVL Calculation**: Includes holdings + lending - borrowing

**Access Control**: Safe owners (asset managers) have full control

**Fund Flow**: All operations go through modules with proper authorization checks
