# IndexSwap V3 Documentation

Complete documentation for the IndexSwap modular vault system.

## 📚 Documentation Index

### 1. [DEPLOYMENT_FLOW.md](./DEPLOYMENT_FLOW.md) 🚀 **START HERE FOR DEPLOYMENT**
**Complete deployment guide**

Learn:
- Infrastructure setup (ProtocolCore, Modules, Factory)
- Two ways to create vaults (Direct vs via ProtocolCore)
- All configuration parameters explained
- Best practices and examples

### 2. [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md) ⭐ **START HERE FOR OPERATIONS**
**Complete guide for Asset Managers**

Learn how to:
- Manually execute swaps, buy/sell, lend, borrow
- Trigger rebalancing
- Calculate TVL and metrics
- Understand fund flows

**Key Questions Answered**:
- ✅ Can I manually buy/sell tokens? **YES**
- ✅ Can I manually lend/borrow? **YES**
- ✅ Does rebalancing happen automatically? **NO - must call manually**
- ✅ How is TVL calculated? **Holdings + Lending - Borrowing**

### 3. [INDEXSWAP_ARCHITECTURE.md](./INDEXSWAP_ARCHITECTURE.md)
**System architecture overview**

- Contract structure and relationships
- Design principles
- Module system
- Access control

### 4. [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md)
**Code examples and integration patterns**

- Creating vaults
- Depositing and withdrawing
- Using modules
- Frontend integration examples

### 5. [TESTING_GUIDE.md](./TESTING_GUIDE.md)
**Testing and verification**

- Running tests
- Expected metrics
- Troubleshooting
- Continuous testing

## 🚀 Quick Start

### For Protocol Deployers

1. Read [DEPLOYMENT_FLOW.md](./DEPLOYMENT_FLOW.md)
2. Deploy infrastructure (ProtocolCore, Modules, Factory)
3. Register factory with ProtocolCore
4. Create vaults via ProtocolCore

### For Asset Managers

1. Read [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md)
2. Learn how to manually execute operations
3. Understand TVL calculation
4. Check the metrics calculation section

### For Developers

1. Read [DEPLOYMENT_FLOW.md](./DEPLOYMENT_FLOW.md) for deployment
2. Read [INDEXSWAP_ARCHITECTURE.md](./INDEXSWAP_ARCHITECTURE.md) for architecture
3. Review [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) for code examples
4. Run tests following [TESTING_GUIDE.md](./TESTING_GUIDE.md)

### For API Integration

See the **TVL and Metrics Calculation** section in [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md) for:
- How to calculate `totalAssets`, `idleAssets`, `investedAssets`
- How to get `supportedAssets` array
- How to calculate `pricePerShare`
- How to get user positions

## 📊 Key Metrics Reference

```typescript
// TVL (Total Value Locked)
const tvl = await vault.getTotalValueUsd();

// Share Price
const sharePrice = tvl / totalSupply;

// User Position Value
const userValue = (userShares / totalSupply) * tvl;

// Token Holdings
const balance = await token.balanceOf(vaultAddress);

// Lending Position
const lendPos = await lendModule.getPosition(vaultAddress, tokenAddress);

// Borrowing Position
const borrowPos = await borrowModule.getPosition(vaultAddress, tokenAddress);
```

## 🔑 Core Concepts

### Vault Components

```
VaultSafe (Owner)
    ↓ owns
IndexSwap (Vault Logic)
    ↓ uses
Modules (DeFi Operations)
```

### Operations

| Operation | Manual | Automatic |
|-----------|--------|-----------|
| Swap | ✅ Yes | ❌ No |
| Buy/Sell | ✅ Yes | ❌ No |
| Lend | ✅ Yes | ❌ No |
| Borrow | ✅ Yes | ❌ No |
| Rebalance | ✅ Yes (call manually) | ❌ No |

### Access Control

- **Safe Owners**: Full control over vault operations
- **Protocol Owner**: Admin access to all vaults
- **Modules**: Check authorization on every operation

## 📖 Document Summaries

### VAULT_INTERACTIONS.md
- **Purpose**: Practical guide for asset managers
- **Audience**: Vault operators, asset managers
- **Content**: How-to guides, code examples, fund flows
- **Length**: Comprehensive (500+ lines)

### INDEXSWAP_ARCHITECTURE.md
- **Purpose**: System design and architecture
- **Audience**: Developers, auditors
- **Content**: Contract structure, design decisions
- **Length**: Detailed (400+ lines)

### INTEGRATION_GUIDE.md
- **Purpose**: Integration patterns and examples
- **Audience**: Frontend developers, integrators
- **Content**: Code examples, best practices
- **Length**: Practical (300+ lines)

### TESTING_GUIDE.md
- **Purpose**: Testing procedures and verification
- **Audience**: QA, developers
- **Content**: Test scripts, expected results
- **Length**: Comprehensive (200+ lines)

## 🎯 Common Use Cases

### 1. Calculate Vault Metrics for API
→ See [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md#tvl-and-metrics-calculation)

### 2. Execute Manual Swap
→ See [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md#1-manual-token-swaps)

### 3. Lend Idle Assets
→ See [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md#3-lend-assets)

### 4. Rebalance Portfolio
→ See [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md#automatic-rebalancing)

### 5. Create New Vault
→ See [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md)

### 6. Run Tests
→ See [TESTING_GUIDE.md](./TESTING_GUIDE.md)

## 🔗 Related Resources

- **Deployment**: `scripts/deploy-indexswap-system.ts`
- **Tests**: `scripts/test-indexswap-complete.ts`, `scripts/test-lend-borrow.ts`
- **Contracts**: `contracts/v3/`

## 📝 Version

**Version**: 3.0 (IndexSwap Modular Architecture)
**Date**: November 2025
**Status**: Production-ready for localhost, ready for testnet

---

**Need Help?**
- Start with [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md) for practical guides
- Check [TESTING_GUIDE.md](./TESTING_GUIDE.md) for troubleshooting
- Review [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) for code examples
