# Dexponent Protocol - Base Sepolia Integration Package

This package contains all the necessary information to integrate with the Dexponent Protocol deployed on Base Sepolia testnet.

## 📁 Package Structure

```
integration-package/
├── deployments/           # Deployment addresses and configurations
│   ├── base-sepolia-deployment.json  # All contract addresses and permissions
│   └── tokens.json                   # All test token addresses and metadata
├── abis/                  # Contract ABIs for integration
│   ├── ProtocolCore.json
│   ├── IndexSwapV3.json
│   ├── MockSwapRouter.json
│   ├── MockOracle.json
│   ├── MockERC20.json
│   └── IERC20.json
├── examples/              # Example integration scripts
│   ├── 01-create-vault.ts
│   ├── 02-execute-swap.ts
│   └── 03-vault-deposit-withdraw.ts
└── README.md             # This file

```

## 🔑 Key Addresses

### Network Configuration
- **Network**: Base Sepolia
- **Chain ID**: 84532
- **RPC URL**: https://sepolia.base.org
- **Block Explorer**: https://sepolia.basescan.org

### Core Contracts
- **ProtocolCore**: `0xd080d29eAfEe778f6E348D6B75b631674BBF9A43`
- **IndexSwapFactory**: `0xEa50dB92C163e395a8394ec4F3A3Fe65fb77657C`
- **MockSwapRouter**: `0x706c3bA805980B692f1E48161213153c179C9dC1`
- **MockOracle**: `0x3c5AfF213F18DFFB2a88c97206006859ffd3677c`

### Wallet Permissions

#### Protocol Owner: `0xC7ab880FE31B36eaF606b9a68e47a9AAbB5fb17B`
- Deploy new vaults via ProtocolCore
- Manage protocol settings
- Update oracle prices
- Manage swap/lending adapters
- Collect protocol fees

#### Token Owner: `0x578636C1CDfd5BCA3F1e787Fa49c2ea664c7bd8C`
- Mint test tokens (MockERC20)
- Transfer test tokens
- Fund mock router with tokens

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install ethers
```

### 2. Create a Vault
```typescript
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

const protocolCore = new ethers.Contract(
  "0xd080d29eAfEe778f6E348D6B75b631674BBF9A43",
  PROTOCOL_CORE_ABI,
  signer
);

const tx = await protocolCore.createIndexSwapVault(
  signer.address,
  "My Vault",
  "MV",
  [
    { token: "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4", weightBps: 5000 }, // USDC 50%
    { token: "0x3aAbBC9464fAA82B99c92b69A021FC8B4b639c4F", weightBps: 5000 }  // WETH 50%
  ],
  0,    // managementFee
  1000  // performanceFee (10%)
);
```

### 3. Execute a Swap
```typescript
const router = new ethers.Contract(
  "0x706c3bA805980B692f1E48161213153c179C9dC1",
  SWAP_ROUTER_ABI,
  signer
);

// Approve tokens
await usdcToken.approve(router.address, amount);

// Execute swap
await router.swap(
  USDC_ADDRESS,
  WETH_ADDRESS,
  amount,
  recipient
);
```

## 📊 Available Test Tokens

All 97 test tokens are available in `deployments/tokens.json`. Key tokens include:

| Symbol | Address | Decimals | Owner |
|--------|---------|----------|-------|
| USDC | `0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4` | 6 | 0x5786...bd8C |
| USDT | `0x1D196BCE6Bbea402fEF328AB1Ac50C971497173D` | 6 | 0x5786...bd8C |
| WETH | `0x3aAbBC9464fAA82B99c92b69A021FC8B4b639c4F` | 18 | 0x5786...bd8C |
| WBTC | `0xc9ee2c5b745A84Faf6F902d795bd8bBb02d7CC27` | 8 | 0x5786...bd8C |
| DAI | `0x5355419854236B3D9c0675a87Fa560F230127663` | 18 | 0x5786...bd8C |

## 🔄 API Endpoint Suggestions

### Vault Management
```
POST   /api/vaults/create
GET    /api/vaults/:address
GET    /api/vaults/:address/portfolio
POST   /api/vaults/:address/deposit
POST   /api/vaults/:address/withdraw
GET    /api/vaults/:address/performance
```

### Swap Operations
```
GET    /api/swap/quote?tokenIn=:address&tokenOut=:address&amount=:amount
POST   /api/swap/execute
GET    /api/swap/history/:userAddress
```

### Token Information
```
GET    /api/tokens
GET    /api/tokens/:address
GET    /api/tokens/:address/price
GET    /api/tokens/:address/balance/:userAddress
```

### Portfolio Analytics
```
GET    /api/portfolio/:vaultAddress/value
GET    /api/portfolio/:vaultAddress/composition
GET    /api/portfolio/:vaultAddress/history
GET    /api/portfolio/:vaultAddress/performance
```

## 📝 Integration Flow

### Creating a Vault
1. User selects tokens and weights
2. Backend validates portfolio (weights sum to 10000 bps)
3. Call `ProtocolCore.createIndexSwapVault()`
4. Parse `IndexSwapVaultCreated` event for vault address
5. Store vault address in database

### Depositing to Vault
1. User specifies deposit amounts
2. Backend calculates proportional amounts based on vault weights
3. User approves tokens to vault address
4. Call `IndexSwapV3.deposit(amounts)`
5. Parse `Deposit` event for shares received
6. Update user balance in database

### Executing Swaps
1. User specifies swap parameters
2. Call `MockSwapRouter.quote()` to get expected output
3. User approves tokenIn to router
4. Call `MockSwapRouter.swap()`
5. Parse `Swap` event for actual amounts
6. Update user balances

### Withdrawing from Vault
1. User specifies shares to withdraw
2. Call `IndexSwapV3.withdraw(shares)`
3. Parse `Withdraw` event for token amounts received
4. Update user balances

## 🔐 Security Considerations

1. **Private Keys**: Never expose private keys in client-side code
2. **Approvals**: Always check and set appropriate token approvals
3. **Slippage**: Implement slippage protection for swaps
4. **Gas Estimation**: Estimate gas before transactions
5. **Event Monitoring**: Monitor events for transaction confirmation

## 🧪 Testing

All contracts are deployed on Base Sepolia testnet. Use the following for testing:

1. Get testnet ETH from [Base Sepolia Faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
2. Mint test tokens using the token owner wallet (`0x5786...bd8C`)
3. Test vault creation, deposits, swaps, and withdrawals
4. Monitor transactions on [Base Sepolia Explorer](https://sepolia.basescan.org)

## 📚 Additional Resources

- **Ethers.js Documentation**: https://docs.ethers.org/v6/
- **Base Sepolia Docs**: https://docs.base.org/
- **Contract Source**: See `contracts/` folder in main repository

## 🆘 Support

For integration support or questions:
- Review example scripts in `examples/`
- Check contract ABIs in `abis/`
- Refer to deployment addresses in `deployments/`

## 📄 License

MIT License - See main repository for details
