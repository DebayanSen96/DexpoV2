# IndexSwap Integration Guide

## Quick Start

### 1. Deploy the System

```bash
# Deploy shared infrastructure (once per network)
npx hardhat run scripts/deploy-indexswap-system.ts --network baseSepolia
```

**Deployed Contracts**:
- ModuleRegistry: Central registry for all modules
- SwapModule: Token swap operations
- BuySellModule: Buy/sell operations
- LendModule: Lending operations
- BorrowModule: Borrowing operations
- IndexSwapFactory: Vault deployment factory

### 2. Create a Vault

```typescript
import { ethers } from "hardhat";

// Get factory contract
const factory = await ethers.getContractAt(
  "IndexSwapFactory",
  FACTORY_ADDRESS
);

// Define portfolio (weights must sum to 10000 = 100%)
const portfolio = [
  { 
    token: "0x4200000000000000000000000000000000000006", // WETH
    weightBps: 5000  // 50%
  },
  { 
    token: "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4", // USDC
    weightBps: 3000  // 30%
  },
  { 
    token: "0x...", // WBTC or other token
    weightBps: 2000  // 20%
  }
];

// Create vault
const tx = await factory.createVault(
  [ownerAddress],              // Safe owners (can be multiple)
  1,                           // Threshold (M-of-N signatures)
  "My Balanced Fund",          // Vault name
  "MBF",                       // Vault symbol
  portfolio,                   // Token weights
  0,                           // farmId (0 = standalone vault)
  ethers.ZeroAddress           // Use default swap router
);

const receipt = await tx.wait();
const event = receipt.logs.find(log => 
  log.topics[0] === factory.interface.getEvent("VaultCreated").topicHash
);
const { safe, indexSwap } = event.args;

console.log("Safe deployed at:", safe);
console.log("IndexSwap deployed at:", indexSwap);
```

### 3. User Deposits

#### Option A: Multi-Token Deposit

```typescript
const indexSwap = await ethers.getContractAt("IndexSwap", VAULT_ADDRESS);

// Approve tokens
await weth.approve(VAULT_ADDRESS, wethAmount);
await usdc.approve(VAULT_ADDRESS, usdcAmount);
await wbtc.approve(VAULT_ADDRESS, wbtcAmount);

// Deposit (amounts array matches portfolio order)
const amounts = [wethAmount, usdcAmount, wbtcAmount];
const tx = await indexSwap.deposit(amounts);
const receipt = await tx.wait();

// Get shares minted
const event = receipt.logs.find(log => 
  log.topics[0] === indexSwap.interface.getEvent("Deposit").topicHash
);
const shares = event.args.shares;
```

#### Option B: Single-Token Deposit with Auto-Allocation

```typescript
// Approve single token
await usdc.approve(VAULT_ADDRESS, depositAmount);

// Deposit - vault automatically swaps to portfolio tokens
const tx = await indexSwap.depositWithAutoAllocation(
  USDC_ADDRESS,
  depositAmount
);
const receipt = await tx.wait();

// Vault will:
// 1. Calculate deposit value in USD
// 2. Swap USDC to WETH (50%), keep USDC (30%), swap to WBTC (20%)
// 3. Mint shares based on deposit value
```

### 4. User Withdrawals

```typescript
const indexSwap = await ethers.getContractAt("IndexSwap", VAULT_ADDRESS);

// Get user's share balance
const shares = await indexSwap.balanceOf(userAddress);

// Withdraw (burns shares, returns proportional tokens)
const tx = await indexSwap.withdraw(shares);
const receipt = await tx.wait();

// User receives:
// - 50% of their value in WETH
// - 30% of their value in USDC
// - 20% of their value in WBTC
```

### 5. Vault Management

#### Update Portfolio Weights

```typescript
// Only Safe owners or protocol owner can call
const newPortfolio = [
  { token: WETH_ADDRESS, weightBps: 4000 },  // 40%
  { token: USDC_ADDRESS, weightBps: 4000 },  // 40%
  { token: WBTC_ADDRESS, weightBps: 2000 }   // 20%
];

await indexSwap.setPortfolio(newPortfolio);
```

#### Trigger Rebalancing

```typescript
// Adjusts holdings to match target weights
await indexSwap.rebalance();
```

#### Add/Remove Tokens

```typescript
// Can add new tokens or remove existing ones
const updatedPortfolio = [
  { token: WETH_ADDRESS, weightBps: 3000 },  // 30%
  { token: USDC_ADDRESS, weightBps: 3000 },  // 30%
  { token: WBTC_ADDRESS, weightBps: 2000 },  // 20%
  { token: LINK_ADDRESS, weightBps: 2000 }   // 20% (new)
];

await indexSwap.setPortfolio(updatedPortfolio);
await indexSwap.rebalance(); // Rebalance to new weights
```

## Module Usage

### Swap Module

```typescript
const swapModule = await ethers.getContractAt(
  "SwapModule",
  SWAP_MODULE_ADDRESS
);

// Get quote
const amountOut = await swapModule.quote(
  WETH_ADDRESS,
  USDC_ADDRESS,
  ethers.parseEther("1")
);

// Execute swap (only authorized)
await weth.approve(VAULT_ADDRESS, amountIn);
await swapModule.swap(
  VAULT_ADDRESS,
  WETH_ADDRESS,
  USDC_ADDRESS,
  amountIn
);
```

### Lend Module

```typescript
const lendModule = await ethers.getContractAt(
  "LendModule",
  LEND_MODULE_ADDRESS
);

// Lend tokens
await usdc.approve(VAULT_ADDRESS, lendAmount);
await lendModule.lend(
  VAULT_ADDRESS,
  USDC_ADDRESS,
  lendAmount
);

// Check position
const position = await lendModule.getPosition(
  VAULT_ADDRESS,
  USDC_ADDRESS
);
console.log("Principal:", position.principal);
console.log("Accrued:", position.accrued);
console.log("APR:", position.aprBps, "bps");

// Repay (get back principal + interest)
await lendModule.repay(
  VAULT_ADDRESS,
  USDC_ADDRESS,
  0  // 0 = repay full amount
);
```

### Borrow Module

```typescript
const borrowModule = await ethers.getContractAt(
  "BorrowModule",
  BORROW_MODULE_ADDRESS
);

// Borrow tokens (requires liquidity in module)
await borrowModule.borrow(
  VAULT_ADDRESS,
  USDC_ADDRESS,
  borrowAmount
);

// Check position
const position = await borrowModule.getPosition(
  VAULT_ADDRESS,
  USDC_ADDRESS
);

// Repay borrowed amount + interest
await usdc.approve(VAULT_ADDRESS, repayAmount);
await borrowModule.repay(
  VAULT_ADDRESS,
  USDC_ADDRESS,
  repayAmount
);
```

## View Functions

### Get Vault Info

```typescript
const indexSwap = await ethers.getContractAt("IndexSwap", VAULT_ADDRESS);

// Get portfolio
const portfolio = await indexSwap.getPortfolio();
console.log("Portfolio:", portfolio);

// Get TVL in USD
const tvlUsd = await indexSwap.getTotalValueUsd();
console.log("TVL:", ethers.formatUnits(tvlUsd, 18), "USD");

// Get share price
const sharePrice = await indexSwap.getSharePrice();
console.log("Share Price:", ethers.formatUnits(sharePrice, 18), "USD");

// Get total supply
const totalSupply = await indexSwap.totalSupply();
console.log("Total Shares:", ethers.formatUnits(totalSupply, 18));

// Get user balance
const userShares = await indexSwap.balanceOf(userAddress);
console.log("User Shares:", ethers.formatUnits(userShares, 18));
```

### Get Safe Info

```typescript
const safe = await ethers.getContractAt("VaultSafe", SAFE_ADDRESS);

// Get owners
const owners = await safe.getOwners();
console.log("Safe Owners:", owners);

// Get threshold
const threshold = await safe.threshold();
console.log("Threshold:", threshold);

// Check if address is owner
const isOwner = await safe.isOwner(address);
console.log("Is Owner:", isOwner);
```

## Multisig Operations

### Submit Transaction

```typescript
const safe = await ethers.getContractAt("VaultSafe", SAFE_ADDRESS);

// Encode function call
const indexSwap = await ethers.getContractAt("IndexSwap", VAULT_ADDRESS);
const data = indexSwap.interface.encodeFunctionData("rebalance", []);

// Submit transaction
const tx = await safe.submitTransaction(
  VAULT_ADDRESS,  // target
  0,              // value
  data            // calldata
);
const receipt = await tx.wait();

// Get transaction hash
const event = receipt.logs.find(log => 
  log.topics[0] === safe.interface.getEvent("TransactionSubmitted").topicHash
);
const txHash = event.args.txHash;
```

### Confirm Transaction (if threshold > 1)

```typescript
// Other owners confirm
await safe.connect(owner2).confirmTransaction(txHash);
await safe.connect(owner3).confirmTransaction(txHash);

// Once threshold reached, anyone can execute
await safe.executeTransaction(txHash);
```

## Frontend Integration

### React Example

```typescript
import { useContract, useContractRead } from 'wagmi';
import IndexSwapABI from './abis/IndexSwap.json';

function VaultDashboard({ vaultAddress }) {
  // Read vault data
  const { data: tvl } = useContractRead({
    address: vaultAddress,
    abi: IndexSwapABI,
    functionName: 'getTotalValueUsd',
  });

  const { data: sharePrice } = useContractRead({
    address: vaultAddress,
    abi: IndexSwapABI,
    functionName: 'getSharePrice',
  });

  const { data: portfolio } = useContractRead({
    address: vaultAddress,
    abi: IndexSwapABI,
    functionName: 'getPortfolio',
  });

  return (
    <div>
      <h2>Vault Dashboard</h2>
      <p>TVL: ${formatUnits(tvl, 18)}</p>
      <p>Share Price: ${formatUnits(sharePrice, 18)}</p>
      <h3>Portfolio</h3>
      <ul>
        {portfolio?.map((item, i) => (
          <li key={i}>
            {item.token}: {item.weightBps / 100}%
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## Common Patterns

### Check Authorization

```typescript
async function isAuthorized(vaultAddress, userAddress) {
  const safe = await getSafeAddress(vaultAddress);
  const vaultSafe = await ethers.getContractAt("VaultSafe", safe);
  
  // Check if user is safe owner
  const isSafeOwner = await vaultSafe.isOwner(userAddress);
  
  // Check if user is protocol owner
  const core = await ethers.getContractAt("ProtocolCore", CORE_ADDRESS);
  const protocolOwner = await core.owner();
  const isProtocolOwner = userAddress === protocolOwner;
  
  return isSafeOwner || isProtocolOwner;
}
```

### Calculate Expected Shares

```typescript
async function calculateExpectedShares(vaultAddress, depositAmount, depositToken) {
  const indexSwap = await ethers.getContractAt("IndexSwap", vaultAddress);
  const router = await ethers.getContractAt("IMockSwapRouter", ROUTER_ADDRESS);
  
  // Get deposit value in USD
  const price = await router.priceUsdE18(depositToken);
  const decimals = await depositToken.decimals();
  const depositValueUsd = (depositAmount * price) / (10n ** decimals);
  
  // Get current share price
  const totalSupply = await indexSwap.totalSupply();
  if (totalSupply === 0n) {
    return depositValueUsd; // First deposit
  }
  
  const tvl = await indexSwap.getTotalValueUsd();
  const expectedShares = (depositValueUsd * totalSupply) / tvl;
  
  return expectedShares;
}
```

## Troubleshooting

### Common Errors

**"Not authorized"**
- Ensure caller is Safe owner or protocol owner
- Check Safe ownership with `safe.isOwner(address)`

**"Weights must sum to 100%"**
- Portfolio weights must sum to exactly 10000 (basis points)
- Example: [5000, 3000, 2000] = 100%

**"Insufficient liquidity"**
- BorrowModule needs liquidity deposited
- Use `borrowModule.depositLiquidity()` to add funds

**"Zero shares"**
- Deposit amount too small
- Increase deposit amount or check token decimals

**"Tx execution failed"**
- Check Safe transaction has enough confirmations
- Verify target contract and calldata are correct

## Best Practices

1. **Always check authorization** before calling management functions
2. **Validate portfolio weights** sum to 10000 before setting
3. **Use auto-allocation deposits** for better UX
4. **Rebalance periodically** to maintain target weights
5. **Monitor module positions** (lending/borrowing)
6. **Set appropriate Safe threshold** (2-of-3 recommended for institutional)
7. **Test on testnet** before mainnet deployment

## Support

For questions or issues:
- Review architecture docs: `docs/INDEXSWAP_ARCHITECTURE.md`
- Check contract source: `contracts/v3/vault/` and `contracts/v3/modules/`
- Test deployment: `scripts/deploy-indexswap-system.ts`
