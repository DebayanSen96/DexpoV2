# Integration Package Contents

## 📦 Complete Package Inventory

This package contains everything needed to integrate with the Dexponent Protocol on Base Sepolia.

### 📁 Directory Structure

```
integration-package/
├── deployments/                    # Deployment information
│   ├── base-sepolia-deployment.json   # All contract addresses and metadata
│   ├── tokens.json                    # All 97 test token addresses
│   └── wallet-permissions.json        # Wallet roles and permissions
│
├── abis/                           # Contract ABIs for integration
│   ├── ProtocolCore.json              # Main protocol entry point
│   ├── IndexSwapV3.json               # Vault contract
│   ├── MockSwapRouter.json            # Swap router
│   ├── MockOracle.json                # Price oracle
│   ├── MockERC20.json                 # Test token contract
│   └── IERC20.json                    # Standard ERC20 interface
│
├── contracts/                      # Source contracts (reference)
│   ├── ProtocolCore.sol
│   ├── IndexSwapV3.sol
│   ├── MockSwapRouter.sol
│   ├── MockOracle.sol
│   └── MockERC20.sol
│
├── examples/                       # Integration examples
│   ├── 01-create-vault.ts             # How to create a vault
│   ├── 02-execute-swap.ts             # How to execute swaps
│   ├── 03-vault-deposit-withdraw.ts   # How to deposit/withdraw
│   └── 04-lending-operations.ts       # How to use lending
│
├── README.md                       # Quick start guide
├── API_INTEGRATION_GUIDE.md        # Detailed API integration guide
└── PACKAGE_CONTENTS.md             # This file
```

## 🔑 Key Information

### Network Details
- **Network**: Base Sepolia
- **Chain ID**: 84532
- **RPC URL**: https://sepolia.base.org
- **Explorer**: https://sepolia.basescan.org

### Core Contract Addresses
| Contract | Address |
|----------|---------|
| ProtocolCore | `0xd080d29eAfEe778f6E348D6B75b631674BBF9A43` |
| IndexSwapFactory | `0xEa50dB92C163e395a8394ec4F3A3Fe65fb77657C` |
| MockSwapRouter | `0x706c3bA805980B692f1E48161213153c179C9dC1` |
| MockOracle | `0x3c5AfF213F18DFFB2a88c97206006859ffd3677c` |
| LendingHub | `0x8f1E7021512085C68b9664e5c68bC64cCf220e6F` |
| SwapHub | `0xa7D29FBa9656035fc047B2FFc7b7A1A04e9Bf8bD` |

### Wallet Roles

#### Protocol Owner: `0xC7ab880FE31B36eaF606b9a68e47a9AAbB5fb17B`
**Use this wallet for:**
- Creating vaults via ProtocolCore
- Updating oracle prices
- Managing protocol settings
- Fee collection

**Private Key Location:** Backend environment variable `PROTOCOL_OWNER_PRIVATE_KEY`

#### Token Owner: `0x578636C1CDfd5BCA3F1e787Fa49c2ea664c7bd8C`
**Use this wallet for:**
- Minting test tokens
- Funding mock router with liquidity
- Distributing test tokens to users

**Private Key:** `6e748857c30404a686a96457624bffc3e3f06346a29c7d808671687dcdc7a34b`

#### End Users
**Use their own wallets for:**
- Depositing to vaults
- Withdrawing from vaults
- Executing swaps
- Lending operations

**Private Key:** Users provide via wallet connection (MetaMask, WalletConnect)

## 📊 Available Tokens

All 97 test tokens are available in `deployments/tokens.json`. Key tokens include:

| Symbol | Address | Decimals | Owner |
|--------|---------|----------|-------|
| USDC | `0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4` | 6 | Token Owner |
| USDT | `0x1D196BCE6Bbea402fEF328AB1Ac50C971497173D` | 6 | Token Owner |
| WETH | `0x3aAbBC9464fAA82B99c92b69A021FC8B4b639c4F` | 18 | Token Owner |
| WBTC | `0xc9ee2c5b745A84Faf6F902d795bd8bBb02d7CC27` | 8 | Token Owner |
| DAI | `0x5355419854236B3D9c0675a87Fa560F230127663` | 18 | Token Owner |

## 🚀 Quick Integration Steps

### 1. Setup Environment
```bash
npm install ethers
```

### 2. Configure Environment Variables
```bash
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
PROTOCOL_OWNER_PRIVATE_KEY=your_key_here
TOKEN_OWNER_PRIVATE_KEY=6e748857c30404a686a96457624bffc3e3f06346a29c7d808671687dcdc7a34b
```

### 3. Import ABIs
```typescript
import ProtocolCoreABI from "./abis/ProtocolCore.json";
import IndexSwapV3ABI from "./abis/IndexSwapV3.json";
import MockSwapRouterABI from "./abis/MockSwapRouter.json";
```

### 4. Create Provider and Signer
```typescript
const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
const signer = new ethers.Wallet(process.env.PROTOCOL_OWNER_PRIVATE_KEY, provider);
```

### 5. Interact with Contracts
See `examples/` folder for complete integration examples.

## 📖 Documentation Files

### README.md
- Quick start guide
- Basic usage examples
- API endpoint suggestions
- Testing instructions

### API_INTEGRATION_GUIDE.md
- Detailed backend integration guide
- Complete API endpoint implementations
- Database schema suggestions
- Event monitoring setup
- Security best practices
- Testing checklist

### wallet-permissions.json
- Detailed wallet roles and permissions
- Use cases for each wallet type
- Security notes
- Private key management

## 🔄 Common Integration Patterns

### Creating a Vault
1. User selects tokens and weights
2. Backend validates portfolio
3. Call `ProtocolCore.createIndexSwapVault()` with protocol owner wallet
4. Parse event for vault address
5. Store in database

### Executing a Swap
1. Get quote from `MockSwapRouter.quote()`
2. User approves tokens
3. User calls `MockSwapRouter.swap()`
4. Monitor swap event
5. Update balances

### Vault Deposit
1. User approves tokens to vault
2. User calls `IndexSwapV3.deposit()`
3. Parse deposit event for shares
4. Update user balance

### Vault Withdrawal
1. User calls `IndexSwapV3.withdraw()`
2. Parse withdraw event for amounts
3. Update user balance

## 🛠️ Development Tools

### Recommended Libraries
- **ethers.js v6**: Ethereum interaction
- **@types/node**: TypeScript support
- **dotenv**: Environment variable management

### Testing Tools
- Base Sepolia Faucet: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet
- Base Sepolia Explorer: https://sepolia.basescan.org

## 📞 Support Resources

1. **Example Scripts**: See `examples/` for working code
2. **Contract ABIs**: See `abis/` for all contract interfaces
3. **Deployment Info**: See `deployments/` for addresses and metadata
4. **Source Code**: See `contracts/` for contract source

## ✅ Integration Checklist

- [ ] Environment variables configured
- [ ] ABIs imported
- [ ] Provider and signers setup
- [ ] Vault creation endpoint implemented
- [ ] Swap quote endpoint implemented
- [ ] Swap execution flow implemented
- [ ] Vault deposit flow implemented
- [ ] Vault withdrawal flow implemented
- [ ] Event monitoring setup
- [ ] Database schema created
- [ ] Error handling implemented
- [ ] Security measures in place
- [ ] Testing completed

## 🔐 Security Reminders

1. **Never expose private keys** in client-side code
2. **Store protocol/token owner keys** in secure environment variables
3. **Never store user private keys** - use wallet signatures
4. **Validate all inputs** before sending transactions
5. **Implement rate limiting** on API endpoints
6. **Use read-only calls** when possible to save gas
7. **Monitor events** for transaction confirmation
8. **Estimate gas** before all transactions

## 📝 Notes

- This is a **testnet deployment** - do not use in production
- All tokens are **test tokens** with no real value
- Token owner can mint unlimited test tokens
- Mock router uses **price-based swaps** (not AMM)
- Oracle prices can be updated by protocol owner

## 🎯 Next Steps

1. Review `README.md` for quick start
2. Read `API_INTEGRATION_GUIDE.md` for detailed implementation
3. Study example scripts in `examples/`
4. Test integration on Base Sepolia
5. Deploy to production with real contracts

---

**Package Version**: 1.0.0  
**Last Updated**: March 17, 2026  
**Network**: Base Sepolia (Testnet)
