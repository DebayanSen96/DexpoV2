# Quick Reference Card

## 🔑 Essential Addresses

### Network
- **RPC**: `https://sepolia.base.org`
- **Chain ID**: `84532`
- **Explorer**: `https://sepolia.basescan.org`

### Core Contracts
```
ProtocolCore:     0xd080d29eAfEe778f6E348D6B75b631674BBF9A43
IndexSwapFactory: 0xEa50dB92C163e395a8394ec4F3A3Fe65fb77657C
MockSwapRouter:   0x706c3bA805980B692f1E48161213153c179C9dC1
MockOracle:       0x3c5AfF213F18DFFB2a88c97206006859ffd3677c
LendingHub:       0x8f1E7021512085C68b9664e5c68bC64cCf220e6F
SwapHub:          0xa7D29FBa9656035fc047B2FFc7b7A1A04e9Bf8bD
```

### Key Tokens
```
USDC: 0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4 (6 decimals)
USDT: 0x1D196BCE6Bbea402fEF328AB1Ac50C971497173D (6 decimals)
WETH: 0x3aAbBC9464fAA82B99c92b69A021FC8B4b639c4F (18 decimals)
WBTC: 0xc9ee2c5b745A84Faf6F902d795bd8bBb02d7CC27 (8 decimals)
DAI:  0x5355419854236B3D9c0675a87Fa560F230127663 (18 decimals)
```

## 👛 Wallets

### Protocol Owner: `0xC7ab880FE31B36eaF606b9a68e47a9AAbB5fb17B`
**Use for:** Vault creation, protocol management, price updates
**Store in:** Backend env var `PROTOCOL_OWNER_PRIVATE_KEY`

### Token Owner: `0x578636C1CDfd5BCA3F1e787Fa49c2ea664c7bd8C`
**Use for:** Minting test tokens, funding router
**Private Key:** `6e748857c30404a686a96457624bffc3e3f06346a29c7d808671687dcdc7a34b`

### End Users: Any wallet
**Use for:** Deposits, withdrawals, swaps
**Auth:** User's own wallet (MetaMask, etc.)

## 🚀 Quick Code Snippets

### Create Vault
```typescript
const tx = await protocolCore.createIndexSwapVault(
  userAddress,
  "My Vault",
  "MV",
  [
    { token: USDC, weightBps: 5000 },
    { token: WETH, weightBps: 5000 }
  ],
  0,    // managementFee
  1000  // performanceFee (10%)
);
```

### Get Swap Quote
```typescript
const amountOut = await router.quote(
  USDC,
  WETH,
  ethers.parseUnits("100", 6)
);
```

### Execute Swap
```typescript
await usdcToken.approve(routerAddress, amount);
await router.swap(USDC, WETH, amount, recipient);
```

### Deposit to Vault
```typescript
await usdcToken.approve(vaultAddress, amount1);
await wethToken.approve(vaultAddress, amount2);
await vault.deposit([amount1, amount2]);
```

### Withdraw from Vault
```typescript
await vault.withdraw(shares);
```

## 📊 API Endpoints (Suggested)

```
POST   /api/vaults/create
GET    /api/vaults/:address
POST   /api/vaults/:address/deposit
POST   /api/vaults/:address/withdraw

GET    /api/swap/quote
POST   /api/swap/execute

GET    /api/tokens
GET    /api/tokens/:address/price
GET    /api/tokens/:address/balance/:user

GET    /api/portfolio/:vault/value
GET    /api/portfolio/:vault/performance
```

## 🔐 Security Checklist

- [ ] Private keys in environment variables
- [ ] Input validation on all endpoints
- [ ] Rate limiting implemented
- [ ] Gas estimation before transactions
- [ ] Event monitoring for confirmations
- [ ] Error handling and logging
- [ ] Never store user private keys

## 📁 File Locations

```
deployments/base-sepolia-deployment.json  → All addresses
deployments/tokens.json                   → All token addresses
deployments/wallet-permissions.json       → Wallet roles

abis/ProtocolCore.json                    → Vault creation
abis/IndexSwapV3.json                     → Vault operations
abis/MockSwapRouter.json                  → Swap operations
abis/IERC20.json                          → Token operations

examples/01-create-vault.ts               → Vault creation example
examples/02-execute-swap.ts               → Swap example
examples/03-vault-deposit-withdraw.ts     → Deposit/withdraw example
examples/04-lending-operations.ts         → Lending example
```

## 🧪 Testing

1. Get testnet ETH: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet
2. Mint test tokens using token owner wallet
3. Test vault creation
4. Test deposits/withdrawals
5. Test swaps
6. Monitor on explorer: https://sepolia.basescan.org

## 📚 Documentation

- **README.md** - Quick start guide
- **API_INTEGRATION_GUIDE.md** - Detailed backend integration
- **PACKAGE_CONTENTS.md** - Complete package inventory
- **QUICK_REFERENCE.md** - This file

---
**Package Version:** 1.0.0  
**Network:** Base Sepolia (Testnet)  
**Last Updated:** March 17, 2026
