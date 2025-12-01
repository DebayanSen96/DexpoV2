# IndexSwap Vault Deployment Flow

## Overview

This document explains the complete deployment flow for IndexSwap vaults, including the role of ProtocolCore, factories, and all configuration parameters.

## Architecture

```
ProtocolCore (Central Hub)
    ↓ registers
IndexSwapFactory (Vault Deployer)
    ↓ creates
VaultSafe + IndexSwap (Vault System)
```

## Deployment Flow

### Phase 1: Infrastructure Setup

#### 1.1 Deploy Core Infrastructure

```typescript
// 1. Deploy DXPToken
const DXPToken = await ethers.getContractFactory("DXPToken");
const dxpToken = await DXPToken.deploy();

// 2. Deploy ProtocolCore
const ProtocolCore = await ethers.getContractFactory("ProtocolCore");
const protocolCore = await ProtocolCore.deploy(
    dxpToken.address,
    70,  // verifierSplitBps (7%)
    10,  // yieldYodaSplitBps (1%)
    30   // farmOwnerSplitBps (3%)
);

// 3. Deploy MockSwapRouter (testnet only)
const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
const swapRouter = await MockSwapRouter.deploy(
    deployer.address,
    [],  // initial tokens
    []   // initial prices
);
```

#### 1.2 Deploy Module System

```typescript
// 1. Deploy ModuleRegistry
const ModuleRegistry = await ethers.getContractFactory("ModuleRegistry");
const moduleRegistry = await ModuleRegistry.deploy();

// 2. Deploy Shared Modules
const SwapModule = await ethers.getContractFactory("SwapModule");
const swapModule = await SwapModule.deploy(
    protocolCore.address,
    swapRouter.address
);

const BuySellModule = await ethers.getContractFactory("BuySellModule");
const buySellModule = await BuySellModule.deploy(
    protocolCore.address,
    swapRouter.address
);

const LendModule = await ethers.getContractFactory("LendModule");
const lendModule = await LendModule.deploy(
    protocolCore.address,
    swapRouter.address
);

const BorrowModule = await ethers.getContractFactory("BorrowModule");
const borrowModule = await BorrowModule.deploy(
    protocolCore.address,
    swapRouter.address
);

// 3. Register modules in registry
await moduleRegistry.setSwapModule(swapModule.address);
await moduleRegistry.setBuySellModule(buySellModule.address);
await moduleRegistry.setLendModule(lendModule.address);
await moduleRegistry.setBorrowModule(borrowModule.address);
```

#### 1.3 Deploy IndexSwapFactory

```typescript
const IndexSwapFactory = await ethers.getContractFactory("IndexSwapFactory");
const factory = await IndexSwapFactory.deploy(
    protocolCore.address,
    moduleRegistry.address,
    swapRouter.address  // default swap router
);
```

#### 1.4 Register Factory with ProtocolCore

```typescript
// Register the IndexSwapFactory with ProtocolCore
await protocolCore.setIndexSwapFactory(factory.address);
```

### Phase 2: Vault Creation

There are **two ways** to create vaults:

#### Option A: Direct Factory Call (Current)

```typescript
const portfolio = [
    { token: WETH, weightBps: 5000 },  // 50%
    { token: USDC, weightBps: 3000 },  // 30%
    { token: WBTC, weightBps: 2000 }   // 20%
];

const tx = await factory.createVault(
    [owner1, owner2],        // safeOwners
    2,                       // safeThreshold (2-of-2 multisig)
    "My Index Fund",         // name
    "MIF",                   // symbol
    portfolio,               // token weights
    farmId,                  // farmId (0 if not registering)
    ethers.ZeroAddress       // customSwapRouter (0 = use default)
);
```

#### Option B: Via ProtocolCore (Recommended) ⭐

```typescript
// Protocol owner creates vault through ProtocolCore
const tx = await protocolCore.createIndexSwapVault(
    [owner1, owner2],        // safeOwners
    2,                       // safeThreshold
    "My Index Fund",         // name
    "MIF",                   // symbol
    portfolio,               // token weights
    farmId,                  // farmId
    ethers.ZeroAddress       // customSwapRouter
);
```

**Benefits of Option B**:
- ✅ Centralized control through ProtocolCore
- ✅ Automatic farm registration
- ✅ Consistent access control
- ✅ Better audit trail

---

## Configuration Parameters

### 1. Safe Configuration

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `safeOwners` | `address[]` | List of multisig owners | `[0x123..., 0x456...]` |
| `safeThreshold` | `uint256` | M-of-N signature threshold | `2` (for 2-of-3) |

**Rules**:
- Must have at least 1 owner
- Threshold must be ≤ number of owners
- Threshold must be ≥ 1

**Use Cases**:
- **Single Owner**: `safeOwners = [owner]`, `threshold = 1`
- **2-of-2 Multisig**: `safeOwners = [owner1, owner2]`, `threshold = 2`
- **2-of-3 Multisig**: `safeOwners = [owner1, owner2, owner3]`, `threshold = 2`

### 2. Vault Metadata

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `name` | `string` | Vault name (ERC20) | `"Balanced Index Fund"` |
| `symbol` | `string` | Vault symbol (ERC20) | `"BIF"` |

**Rules**:
- Name and symbol are used for the share token (ERC20)
- Should be descriptive and unique
- Symbol typically 2-5 characters

### 3. Portfolio Configuration

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `portfolio` | `TokenWeight[]` | Token allocation | See below |

**TokenWeight Structure**:
```solidity
struct TokenWeight {
    address token;      // Token address
    uint16 weightBps;   // Weight in basis points (10000 = 100%)
}
```

**Rules**:
- Must have at least 1 token
- Weights must sum to exactly 10000 (100%)
- Each token must be a valid ERC20
- No duplicate tokens

**Examples**:

**Balanced 50/50**:
```typescript
[
    { token: WETH, weightBps: 5000 },
    { token: USDC, weightBps: 5000 }
]
```

**Aggressive 70/20/10**:
```typescript
[
    { token: WETH, weightBps: 7000 },
    { token: WBTC, weightBps: 2000 },
    { token: USDC, weightBps: 1000 }
]
```

**Conservative Stablecoin Mix**:
```typescript
[
    { token: USDC, weightBps: 4000 },
    { token: DAI, weightBps: 3000 },
    { token: USDT, weightBps: 3000 }
]
```

### 4. Farm Integration

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `farmId` | `uint256` | Farm ID for registration | `1234` or `0` |

**Rules**:
- `farmId = 0`: Vault not registered with protocol (standalone)
- `farmId > 0`: Vault registered as a farm in ProtocolCore

**Use Cases**:
- **Standalone Vault**: `farmId = 0` (no protocol integration)
- **Protocol Farm**: `farmId = 1234` (registered with ProtocolCore)

### 5. Swap Router

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `customSwapRouter` | `address` | Custom router address | `0x123...` or `0x0` |

**Rules**:
- `address(0)`: Use factory's default router
- Custom address: Use specific router for this vault

**Use Cases**:
- **Default**: `customSwapRouter = ethers.ZeroAddress`
- **Custom**: `customSwapRouter = 0x123...` (e.g., Uniswap V3 router)

---

## Complete Deployment Example

### Testnet Deployment (Base Sepolia)

```typescript
import { ethers } from "hardhat";

async function deployIndexSwapSystem() {
    const [deployer] = await ethers.getSigners();
    
    // ========== PHASE 1: INFRASTRUCTURE ==========
    
    console.log("1. Deploy DXPToken...");
    const DXPToken = await ethers.getContractFactory("DXPToken");
    const dxpToken = await DXPToken.deploy();
    await dxpToken.waitForDeployment();
    
    console.log("2. Deploy ProtocolCore...");
    const ProtocolCore = await ethers.getContractFactory("ProtocolCore");
    const protocolCore = await ProtocolCore.deploy(
        await dxpToken.getAddress(),
        70,  // 7% to verifiers
        10,  // 1% to yield yodas
        30   // 3% to farm owner
    );
    await protocolCore.waitForDeployment();
    
    console.log("3. Deploy MockSwapRouter...");
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
    const swapRouter = await MockSwapRouter.deploy(
        deployer.address,
        [],
        []
    );
    await swapRouter.waitForDeployment();
    
    console.log("4. Deploy ModuleRegistry...");
    const ModuleRegistry = await ethers.getContractFactory("ModuleRegistry");
    const moduleRegistry = await ModuleRegistry.deploy();
    await moduleRegistry.waitForDeployment();
    
    console.log("5. Deploy Modules...");
    const SwapModule = await ethers.getContractFactory("SwapModule");
    const swapModule = await SwapModule.deploy(
        await protocolCore.getAddress(),
        await swapRouter.getAddress()
    );
    await swapModule.waitForDeployment();
    
    const BuySellModule = await ethers.getContractFactory("BuySellModule");
    const buySellModule = await BuySellModule.deploy(
        await protocolCore.getAddress(),
        await swapRouter.getAddress()
    );
    await buySellModule.waitForDeployment();
    
    const LendModule = await ethers.getContractFactory("LendModule");
    const lendModule = await LendModule.deploy(
        await protocolCore.getAddress(),
        await swapRouter.getAddress()
    );
    await lendModule.waitForDeployment();
    
    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
        await protocolCore.getAddress(),
        await swapRouter.getAddress()
    );
    await borrowModule.waitForDeployment();
    
    console.log("6. Register Modules...");
    await moduleRegistry.setSwapModule(await swapModule.getAddress());
    await moduleRegistry.setBuySellModule(await buySellModule.getAddress());
    await moduleRegistry.setLendModule(await lendModule.getAddress());
    await moduleRegistry.setBorrowModule(await borrowModule.getAddress());
    
    console.log("7. Deploy IndexSwapFactory...");
    const IndexSwapFactory = await ethers.getContractFactory("IndexSwapFactory");
    const factory = await IndexSwapFactory.deploy(
        await protocolCore.getAddress(),
        await moduleRegistry.getAddress(),
        await swapRouter.getAddress()
    );
    await factory.waitForDeployment();
    
    console.log("8. Register Factory with ProtocolCore...");
    await protocolCore.setIndexSwapFactory(await factory.getAddress());
    
    // ========== PHASE 2: CREATE VAULT ==========
    
    console.log("\n9. Create Example Vault...");
    
    // Define portfolio
    const WETH = "0x4200000000000000000000000000000000000006"; // Base WETH
    const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base USDC
    
    const portfolio = [
        { token: WETH, weightBps: 6000 },  // 60%
        { token: USDC, weightBps: 4000 }   // 40%
    ];
    
    // Create vault via ProtocolCore
    const tx = await protocolCore.createIndexSwapVault(
        [deployer.address],           // Single owner
        1,                            // 1-of-1 (no multisig)
        "Balanced Crypto Fund",       // Name
        "BCF",                        // Symbol
        portfolio,                    // 60/40 WETH/USDC
        0,                            // No farm registration
        ethers.ZeroAddress            // Use default router
    );
    
    const receipt = await tx.wait();
    
    // Parse event to get vault addresses
    const event = receipt.logs.find(log => {
        try {
            const parsed = factory.interface.parseLog(log);
            return parsed?.name === "VaultCreated";
        } catch {
            return false;
        }
    });
    
    const parsedEvent = factory.interface.parseLog(event);
    const safeAddress = parsedEvent.args.safe;
    const indexSwapAddress = parsedEvent.args.indexSwap;
    
    console.log("\n✅ Vault Created!");
    console.log("Safe:", safeAddress);
    console.log("IndexSwap:", indexSwapAddress);
    
    return {
        protocolCore: await protocolCore.getAddress(),
        factory: await factory.getAddress(),
        swapRouter: await swapRouter.getAddress(),
        moduleRegistry: await moduleRegistry.getAddress(),
        modules: {
            swap: await swapModule.getAddress(),
            buySell: await buySellModule.getAddress(),
            lend: await lendModule.getAddress(),
            borrow: await borrowModule.getAddress()
        },
        vault: {
            safe: safeAddress,
            indexSwap: indexSwapAddress
        }
    };
}
```

---

## ProtocolCore Integration

### Current Implementation

The current `ProtocolCore` has:
- ✅ `setVaultFactory(address)` - Register old vault factory
- ✅ `createVaultViaCore(...)` - Create old-style vaults

### Recommended Updates

Add support for IndexSwapFactory:

```solidity
contract ProtocolCore {
    address public vaultFactory;        // Old vault factory (deprecated)
    address public indexSwapFactory;    // New IndexSwap factory
    
    // Register IndexSwapFactory
    function setIndexSwapFactory(address _factory) external onlyOwner {
        require(_factory != address(0), "Invalid factory");
        indexSwapFactory = _factory;
    }
    
    // Create IndexSwap vault via ProtocolCore
    function createIndexSwapVault(
        address[] calldata safeOwners,
        uint256 safeThreshold,
        string calldata name,
        string calldata symbol,
        TokenWeight[] calldata portfolio,
        uint256 farmId,
        address customSwapRouter
    ) external onlyOwner returns (address safe, address indexSwap) {
        require(indexSwapFactory != address(0), "Factory not set");
        
        (safe, indexSwap) = IIndexSwapFactory(indexSwapFactory).createVault(
            safeOwners,
            safeThreshold,
            name,
            symbol,
            portfolio,
            farmId,
            customSwapRouter
        );
        
        // Auto-register if farmId provided
        if (farmId > 0) {
            registerFarm(safeOwners[0], indexSwap, farmId);
        }
        
        emit IndexSwapVaultCreated(safe, indexSwap, farmId);
    }
    
    event IndexSwapVaultCreated(
        address indexed safe,
        address indexed indexSwap,
        uint256 indexed farmId
    );
}
```

---

## Deployment Checklist

### Infrastructure Setup
- [ ] Deploy DXPToken
- [ ] Deploy ProtocolCore
- [ ] Deploy MockSwapRouter (testnet) or configure real router (mainnet)
- [ ] Deploy ModuleRegistry
- [ ] Deploy all 4 modules (Swap, BuySell, Lend, Borrow)
- [ ] Register modules in ModuleRegistry
- [ ] Deploy IndexSwapFactory
- [ ] Register IndexSwapFactory in ProtocolCore

### Vault Creation
- [ ] Define portfolio weights (must sum to 10000)
- [ ] Choose Safe owners and threshold
- [ ] Decide on farm registration (farmId)
- [ ] Choose swap router (default or custom)
- [ ] Call `protocolCore.createIndexSwapVault()` or `factory.createVault()`
- [ ] Verify vault deployment (Safe + IndexSwap)
- [ ] Set modules on IndexSwap (if needed)

### Post-Deployment
- [ ] Configure token prices in MockSwapRouter (testnet)
- [ ] Add liquidity to MockSwapRouter (testnet)
- [ ] Test deposits
- [ ] Test rebalancing
- [ ] Test lending/borrowing
- [ ] Verify TVL calculation

---

## Configuration Best Practices

### Portfolio Design

**Diversified Portfolio**:
```typescript
// Good: Spread across multiple assets
[
    { token: WETH, weightBps: 3000 },   // 30%
    { token: WBTC, weightBps: 2000 },   // 20%
    { token: USDC, weightBps: 2500 },   // 25%
    { token: DAI, weightBps: 2500 }     // 25%
]
```

**Concentrated Portfolio**:
```typescript
// Risky: Heavy concentration
[
    { token: WETH, weightBps: 9000 },   // 90%
    { token: USDC, weightBps: 1000 }    // 10%
]
```

### Multisig Configuration

**Single Manager**:
```typescript
safeOwners: [manager],
threshold: 1
```

**Partnership (2-of-2)**:
```typescript
safeOwners: [partner1, partner2],
threshold: 2  // Both must approve
```

**DAO (3-of-5)**:
```typescript
safeOwners: [member1, member2, member3, member4, member5],
threshold: 3  // Any 3 can approve
```

### Farm Integration

**Standalone Vault** (No protocol integration):
```typescript
farmId: 0
```

**Protocol-Integrated Vault**:
```typescript
farmId: 1234  // Registered with ProtocolCore
```

---

## Deployment Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    INFRASTRUCTURE SETUP                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Deploy DXPToken                                         │
│  2. Deploy ProtocolCore(dxpToken)                           │
│  3. Deploy MockSwapRouter                                   │
│  4. Deploy ModuleRegistry                                   │
│  5. Deploy Modules (Swap, BuySell, Lend, Borrow)           │
│  6. Register Modules in Registry                            │
│  7. Deploy IndexSwapFactory(core, registry, router)         │
│  8. Register Factory: core.setIndexSwapFactory(factory)     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                      VAULT CREATION                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Option A: Direct                                           │
│  ─────────────────                                          │
│  factory.createVault(owners, threshold, name, ...)          │
│                                                              │
│  Option B: Via ProtocolCore (Recommended)                   │
│  ──────────────────────────────────────────                 │
│  protocolCore.createIndexSwapVault(owners, ...)             │
│      ↓                                                       │
│  factory.createVault(...)                                   │
│      ↓                                                       │
│  Deploy VaultSafe(core, owners, threshold)                  │
│      ↓                                                       │
│  Deploy IndexSwap(core, safe, router, name, portfolio)      │
│      ↓                                                       │
│  Set modules on IndexSwap                                   │
│      ↓                                                       │
│  Register farm (if farmId > 0)                              │
│      ↓                                                       │
│  Emit VaultCreated event                                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    VAULT READY TO USE                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  • Users can deposit                                        │
│  • Asset managers can trade, lend, borrow                   │
│  • Rebalancing available                                    │
│  • TVL tracked                                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Summary

### Key Points

1. **Infrastructure First**: Deploy ProtocolCore, modules, and factory before creating vaults
2. **Two Creation Methods**: Direct factory call OR via ProtocolCore (recommended)
3. **Configuration Flexibility**: Customize Safe, portfolio, farm integration, and router
4. **Modular Design**: Shared modules across all vaults for efficiency
5. **Protocol Integration**: Optional farm registration for protocol features

### Configuration Parameters Summary

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `safeOwners` | ✅ Yes | - | Multisig owners |
| `safeThreshold` | ✅ Yes | - | M-of-N threshold |
| `name` | ✅ Yes | - | Vault name |
| `symbol` | ✅ Yes | - | Share token symbol |
| `portfolio` | ✅ Yes | - | Token weights (must sum to 10000) |
| `farmId` | ✅ Yes | `0` | Farm ID (0 = standalone) |
| `customSwapRouter` | ✅ Yes | `address(0)` | Custom router (0 = use default) |

### Next Steps

1. Review [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md) for post-deployment operations
2. Check [TESTING_GUIDE.md](./TESTING_GUIDE.md) for testing procedures
3. See [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) for code examples
