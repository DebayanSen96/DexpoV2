# API Integration Guide

This guide provides detailed instructions for integrating the Dexponent Protocol into your backend API.

## 🏗️ Architecture Overview

```
Frontend (User) 
    ↓
Backend API (Your Server)
    ↓
Ethers.js Provider
    ↓
Base Sepolia RPC
    ↓
Smart Contracts
```

## 🔑 Wallet Management

### Three Types of Wallets

1. **Protocol Owner** (`0xC7ab...7B`)
   - Used by backend for protocol operations
   - Store private key in environment variables
   - Required for: vault creation, price updates, protocol management

2. **Token Owner** (`0x5786...8C`)
   - Used by backend for token operations
   - Store private key in environment variables
   - Required for: minting test tokens, funding router

3. **End Users** (Any address)
   - Users connect their own wallets (MetaMask, WalletConnect)
   - Never store user private keys
   - Required for: deposits, withdrawals, swaps

### Environment Variables Setup

```bash
# .env file
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
PROTOCOL_OWNER_PRIVATE_KEY=your_protocol_owner_key_here
TOKEN_OWNER_PRIVATE_KEY=6e748857c30404a686a96457624bffc3e3f06346a29c7d808671687dcdc7a34b

# Contract addresses
PROTOCOL_CORE_ADDRESS=0xd080d29eAfEe778f6E348D6B75b631674BBF9A43
INDEX_SWAP_FACTORY=0xEa50dB92C163e395a8394ec4F3A3Fe65fb77657C
MOCK_SWAP_ROUTER=0x706c3bA805980B692f1E48161213153c179C9dC1
MOCK_ORACLE=0x3c5AfF213F18DFFB2a88c97206006859ffd3677c
LENDING_HUB=0x8f1E7021512085C68b9664e5c68bC64cCf220e6F
```

## 📡 API Endpoint Implementation

### 1. Vault Creation Endpoint

```typescript
// POST /api/vaults/create
import { ethers } from "ethers";

interface CreateVaultRequest {
  userAddress: string;
  name: string;
  symbol: string;
  portfolio: Array<{
    token: string;
    weightBps: number;
  }>;
  managementFee: number;
  performanceFee: number;
}

async function createVault(req: CreateVaultRequest) {
  // Validate portfolio weights sum to 10000
  const totalWeight = req.portfolio.reduce((sum, p) => sum + p.weightBps, 0);
  if (totalWeight !== 10000) {
    throw new Error("Portfolio weights must sum to 10000 bps (100%)");
  }
  
  // Setup provider with protocol owner wallet
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const signer = new ethers.Wallet(process.env.PROTOCOL_OWNER_PRIVATE_KEY!, provider);
  
  // Load ProtocolCore ABI
  const protocolCoreAbi = require("./abis/ProtocolCore.json").abi;
  const protocolCore = new ethers.Contract(
    process.env.PROTOCOL_CORE_ADDRESS!,
    protocolCoreAbi,
    signer
  );
  
  // Create vault
  const tx = await protocolCore.createIndexSwapVault(
    req.userAddress,
    req.name,
    req.symbol,
    req.portfolio,
    req.managementFee,
    req.performanceFee
  );
  
  const receipt = await tx.wait();
  
  // Parse event to get vault address
  const event = receipt.logs.find((log: any) => {
    try {
      const parsed = protocolCore.interface.parseLog({
        topics: log.topics,
        data: log.data
      });
      return parsed?.name === "IndexSwapVaultCreated";
    } catch {
      return false;
    }
  });
  
  const parsed = protocolCore.interface.parseLog({
    topics: event.topics,
    data: event.data
  });
  
  const vaultAddress = parsed.args[1];
  
  // Store in database
  await db.vaults.create({
    address: vaultAddress,
    owner: req.userAddress,
    name: req.name,
    symbol: req.symbol,
    portfolio: req.portfolio,
    createdAt: new Date(),
    txHash: tx.hash
  });
  
  return {
    vaultAddress,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber
  };
}
```

### 2. Swap Quote Endpoint

```typescript
// GET /api/swap/quote?tokenIn=:address&tokenOut=:address&amount=:amount

async function getSwapQuote(tokenIn: string, tokenOut: string, amountIn: string) {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  
  const routerAbi = require("./abis/MockSwapRouter.json").abi;
  const router = new ethers.Contract(
    process.env.MOCK_SWAP_ROUTER!,
    routerAbi,
    provider // Read-only, no signer needed
  );
  
  const amountOut = await router.quote(tokenIn, tokenOut, amountIn);
  
  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountOut: amountOut.toString(),
    router: process.env.MOCK_SWAP_ROUTER
  };
}
```

### 3. Execute Swap (User-Signed)

```typescript
// POST /api/swap/execute
// User signs transaction on frontend, backend just validates and monitors

interface ExecuteSwapRequest {
  userAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string; // Slippage protection
  signature: string; // User's signature
}

async function executeSwap(req: ExecuteSwapRequest) {
  // This is executed on FRONTEND with user's wallet
  // Backend just provides the transaction data
  
  const txData = {
    to: process.env.MOCK_SWAP_ROUTER,
    data: router.interface.encodeFunctionData("swap", [
      req.tokenIn,
      req.tokenOut,
      req.amountIn,
      req.userAddress
    ])
  };
  
  return {
    txData,
    estimatedGas: "150000" // Estimate gas
  };
}
```

### 4. Vault Deposit (User-Signed)

```typescript
// POST /api/vaults/:address/deposit

interface DepositRequest {
  vaultAddress: string;
  userAddress: string;
  amounts: string[]; // Amounts for each token in portfolio
}

async function prepareDeposit(req: DepositRequest) {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  
  const vaultAbi = require("./abis/IndexSwapV3.json").abi;
  const vault = new ethers.Contract(req.vaultAddress, vaultAbi, provider);
  
  // Get portfolio to validate amounts
  const [tokens, weights] = await vault.getPortfolio();
  
  if (tokens.length !== req.amounts.length) {
    throw new Error("Amounts array must match portfolio length");
  }
  
  // Prepare approval transactions for each token
  const approvals = tokens.map((token: string, i: number) => ({
    to: token,
    data: new ethers.Interface(["function approve(address,uint256)"]).encodeFunctionData(
      "approve",
      [req.vaultAddress, req.amounts[i]]
    )
  }));
  
  // Prepare deposit transaction
  const depositTx = {
    to: req.vaultAddress,
    data: vault.interface.encodeFunctionData("deposit", [req.amounts])
  };
  
  return {
    approvals,
    depositTx,
    estimatedGas: "300000"
  };
}
```

### 5. Get Vault Portfolio Value

```typescript
// GET /api/vaults/:address/value

async function getVaultValue(vaultAddress: string) {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  
  const vaultAbi = require("./abis/IndexSwapV3.json").abi;
  const vault = new ethers.Contract(vaultAddress, vaultAbi, provider);
  
  const oracleAbi = require("./abis/MockOracle.json").abi;
  const oracle = new ethers.Contract(process.env.MOCK_ORACLE!, oracleAbi, provider);
  
  // Get portfolio composition
  const [tokens, weights] = await vault.getPortfolio();
  const totalSupply = await vault.totalSupply();
  
  // Get token balances and prices
  let totalValueUsd = 0n;
  const holdings = [];
  
  for (let i = 0; i < tokens.length; i++) {
    const tokenContract = new ethers.Contract(
      tokens[i],
      ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"],
      provider
    );
    
    const balance = await tokenContract.balanceOf(vaultAddress);
    const decimals = await tokenContract.decimals();
    const price = await oracle.priceUsdE18(tokens[i]);
    
    const valueUsd = (balance * price) / (10n ** BigInt(decimals));
    totalValueUsd += valueUsd;
    
    holdings.push({
      token: tokens[i],
      balance: balance.toString(),
      decimals,
      priceUsd: ethers.formatEther(price),
      valueUsd: ethers.formatEther(valueUsd),
      weightBps: weights[i]
    });
  }
  
  return {
    vaultAddress,
    totalValueUsd: ethers.formatEther(totalValueUsd),
    totalSupply: ethers.formatEther(totalSupply),
    pricePerShare: totalSupply > 0n 
      ? ethers.formatEther(totalValueUsd * 10n**18n / totalSupply)
      : "0",
    holdings
  };
}
```

## 🔄 Event Monitoring

### Setup Event Listeners

```typescript
import { ethers } from "ethers";

const provider = new ethers.WebSocketProvider("wss://sepolia.base.org");

// Monitor vault creations
const protocolCore = new ethers.Contract(
  process.env.PROTOCOL_CORE_ADDRESS!,
  protocolCoreAbi,
  provider
);

protocolCore.on("IndexSwapVaultCreated", async (safe, indexSwap, name, symbol, event) => {
  console.log("New vault created:", {
    owner: safe,
    vaultAddress: indexSwap,
    name,
    symbol,
    txHash: event.log.transactionHash
  });
  
  // Store in database
  await db.vaults.create({
    address: indexSwap,
    owner: safe,
    name,
    symbol,
    txHash: event.log.transactionHash,
    blockNumber: event.log.blockNumber
  });
});

// Monitor deposits
const vaultFilter = vault.filters.Deposit();
vault.on(vaultFilter, async (user, amounts, shares, event) => {
  console.log("Deposit:", {
    user,
    amounts: amounts.map((a: bigint) => a.toString()),
    shares: shares.toString()
  });
  
  // Update user balance in database
});
```

## 📊 Database Schema Suggestions

```sql
-- Vaults table
CREATE TABLE vaults (
  id SERIAL PRIMARY KEY,
  address VARCHAR(42) UNIQUE NOT NULL,
  owner VARCHAR(42) NOT NULL,
  name VARCHAR(255) NOT NULL,
  symbol VARCHAR(10) NOT NULL,
  portfolio JSONB NOT NULL,
  management_fee INTEGER NOT NULL,
  performance_fee INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  block_number INTEGER NOT NULL
);

-- User vault balances
CREATE TABLE vault_balances (
  id SERIAL PRIMARY KEY,
  vault_address VARCHAR(42) NOT NULL,
  user_address VARCHAR(42) NOT NULL,
  shares NUMERIC(78, 0) NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  UNIQUE(vault_address, user_address)
);

-- Swap history
CREATE TABLE swaps (
  id SERIAL PRIMARY KEY,
  user_address VARCHAR(42) NOT NULL,
  token_in VARCHAR(42) NOT NULL,
  token_out VARCHAR(42) NOT NULL,
  amount_in NUMERIC(78, 0) NOT NULL,
  amount_out NUMERIC(78, 0) NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp TIMESTAMP NOT NULL
);

-- Token prices (cached from oracle)
CREATE TABLE token_prices (
  token_address VARCHAR(42) PRIMARY KEY,
  price_usd NUMERIC(78, 18) NOT NULL,
  updated_at TIMESTAMP NOT NULL
);
```

## 🛡️ Security Best Practices

1. **Never expose private keys**
   - Store in environment variables
   - Use secret management services (AWS Secrets Manager, etc.)

2. **Validate all inputs**
   - Check addresses are valid
   - Validate amounts are positive
   - Ensure weights sum to 10000

3. **Implement rate limiting**
   - Prevent spam vault creation
   - Limit API calls per user

4. **Use read-only calls when possible**
   - Don't use signer for view functions
   - Cache oracle prices

5. **Implement proper error handling**
   - Catch and log all errors
   - Return user-friendly messages
   - Monitor failed transactions

6. **Gas estimation**
   - Always estimate gas before transactions
   - Add buffer for safety (1.2x estimated)

## 🧪 Testing Checklist

- [ ] Vault creation works
- [ ] Deposit flow works (approve + deposit)
- [ ] Withdrawal flow works
- [ ] Swap execution works
- [ ] Price quotes are accurate
- [ ] Event monitoring captures all events
- [ ] Database updates correctly
- [ ] Error handling works
- [ ] Rate limiting works
- [ ] Gas estimation is accurate

## 📞 Support

For integration issues, refer to:
- Example scripts in `examples/`
- Contract ABIs in `abis/`
- Deployment addresses in `deployments/`
