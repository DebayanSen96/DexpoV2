# IndexSwap Architecture - Modular Vault System

## Overview

This document describes the new modular vault architecture that replaces the problematic `BaseVault.sol` design. The new system cleanly separates concerns between ownership (Safe), investment logic (IndexSwap), and DeFi operations (Modules).

## Problem Statement

The previous `BaseVault.sol` (Vault4626) attempted to be both:
1. An ERC4626 yield vault (LP-facing)
2. A Safe-like multisig wallet (owner-facing)

This dual-purpose design created fundamental conflicts:
- **Single base asset constraint**: ERC4626 requires a single `asset()`, limiting multi-token portfolios
- **NAV0 revert issue**: When `totalAssets() == 0` but `totalSupply() > 0`, deposits would revert
- **Blurred ownership semantics**: LP shares vs owner control were conflated
- **Limited scalability**: Tight coupling made it hard to add new DeFi strategies

## New Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Protocol Layer                          │
│  ┌──────────────────┐         ┌──────────────────┐         │
│  │  ProtocolCore    │         │ ModuleRegistry   │         │
│  │  (existing)      │         │  (new)           │         │
│  └──────────────────┘         └──────────────────┘         │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                     Shared Modules                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Swap    │  │ BuySell  │  │   Lend   │  │  Borrow  │  │
│  │  Module  │  │  Module  │  │  Module  │  │  Module  │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                   Per-Vault Deployment                      │
│                                                             │
│  ┌──────────────────┐         ┌──────────────────┐        │
│  │   VaultSafe      │────────▶│   IndexSwap      │        │
│  │   (Owner)        │  owns   │   (Vault Logic)  │        │
│  │                  │         │                  │        │
│  │  - Multisig      │         │  - ERC20 shares  │        │
│  │  - Tx approval   │         │  - Deposits/     │        │
│  │  - Access ctrl   │         │    Withdrawals   │        │
│  │                  │         │  - Rebalancing   │        │
│  └──────────────────┘         │  - Weight mgmt   │        │
│                                └──────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

### 1. VaultSafe (Multisig Owner)

**Purpose**: Acts as the vault owner with multisig capabilities

**Key Features**:
- Multisig transaction approval (M-of-N signatures)
- Dual authorization: Safe owners OR protocol owner can execute
- Manages ownership of the IndexSwap vault
- No share token or deposit/withdrawal logic

**Access Control**:
```solidity
modifier onlyOwnerOrProtocolOwner() {
    bool isVaultOwner = isOwner[msg.sender];
    bool isProtocolOwner = (msg.sender == protocolCore.owner());
    require(isVaultOwner || isProtocolOwner, "Not authorized");
    _;
}
```

### 2. IndexSwap (Main Vault Logic)

**Purpose**: Manages LP deposits, portfolio allocation, and share tokens

**Key Features**:
- **ERC20 Share Token**: Represents LP ownership in the vault
- **Weight-Based Portfolio**: Define target allocations (e.g., 50% ETH, 30% USDC, 20% WBTC)
- **Auto-Allocation Deposits**: Automatically swap and distribute funds according to weights
- **Multi-Token Withdrawals**: Burn shares to receive proportional portfolio tokens
- **Rebalancing**: Adjust holdings to match target weights
- **TVL Calculation**: Aggregate value across all holdings + lending - borrowing

**Portfolio Configuration**:
```solidity
struct TokenWeight {
    address token;
    uint16 weightBps;  // Basis points (10000 = 100%)
}

// Example: 50% WETH, 30% USDC, 20% WBTC
TokenWeight[] memory portfolio = [
    TokenWeight(WETH, 5000),
    TokenWeight(USDC, 3000),
    TokenWeight(WBTC, 2000)
];
```

**Deposit Flow**:
1. User deposits single token (e.g., USDC)
2. IndexSwap calculates deposit value in USD
3. Swaps deposit token to portfolio tokens according to weights
4. Mints shares based on deposit value / current share price
5. Transfers shares to user

**Withdrawal Flow**:
1. User burns shares
2. IndexSwap calculates proportional holdings
3. Transfers each portfolio token to user
4. Updates share supply

**Access Control**:
- Safe owners OR protocol owner can:
  - Update portfolio weights
  - Trigger rebalancing
  - Set modules
  - Configure parameters

### 3. Module System

**Purpose**: Shared DeFi operation contracts used across all vaults

#### SwapModule
- Token-to-token swaps via MockSwapRouter
- Tracks swap volume per vault
- Quote functionality

#### BuySellModule
- Buy tokens with base currency
- Sell tokens for base currency
- Volume tracking

#### LendModule
- Lend tokens to earn interest
- Simulated lending with APR accrual
- Position tracking per vault/token
- Contributes to TVL calculation

#### BorrowModule
- Borrow tokens against collateral
- Simulated borrowing with APR accrual
- Position tracking per vault/token
- Reduces TVL calculation

**Module Access Control**:
```solidity
modifier onlyAuthorized(address vault) {
    bool isSafeOwner = IVaultSafe(vault).isOwner(msg.sender);
    bool isProtocolOwner = (msg.sender == protocolCore.owner());
    require(isSafeOwner || isProtocolOwner, "Not authorized");
    _;
}
```

### 4. ModuleRegistry

**Purpose**: Central registry for module addresses

**Functions**:
- `getSwapModule()` / `setSwapModule()`
- `getBuySellModule()` / `setBuySellModule()`
- `getLendModule()` / `setLendModule()`
- `getBorrowModule()` / `setBorrowModule()`

**Benefits**:
- Single source of truth for module addresses
- Easy upgrades (deploy new module, update registry)
- All vaults automatically use updated modules

### 5. IndexSwapFactory

**Purpose**: Deploy complete vault systems (Safe + IndexSwap)

**Deployment Process**:
1. Deploy VaultSafe with specified owners and threshold
2. Deploy IndexSwap with portfolio configuration
3. Wire IndexSwap to modules from registry
4. Register vault with ProtocolCore (if farmId provided)
5. Record deployment in factory registry

**Function Signature**:
```solidity
function createVault(
    address[] calldata safeOwners,
    uint256 safeThreshold,
    string calldata name,
    string calldata symbol,
    TokenWeight[] calldata portfolio,
    uint256 farmId,
    address customSwapRouter
) external returns (address safe, address indexSwap)
```

## Key Improvements

### 1. Clean Separation of Concerns

| Component | Responsibility |
|-----------|---------------|
| VaultSafe | Ownership & access control |
| IndexSwap | Investment logic & LP interface |
| Modules | Reusable DeFi operations |

### 2. Multi-Token Support

- No single "base asset" constraint
- Portfolio can hold any mix of tokens
- Weights define target allocation
- Automatic rebalancing to maintain weights

### 3. Scalable Module System

- Modules deployed once, used by all vaults
- Easy to add new operations (flashloans, LP positions, etc.)
- Modules track positions per vault
- Protocol-wide upgrades by updating registry

### 4. Flexible Access Control

- Safe owners have full control over their vault
- Protocol owner can also manage vaults (for admin/emergency)
- Both have equal privileges on vault operations
- Multisig support for institutional users

### 5. Proper TVL Accounting

```solidity
TVL = Σ(token balances in USD) 
    + Σ(lending positions in USD) 
    - Σ(borrowing positions in USD)

Share Price = TVL / Total Shares
```

### 6. No NAV0 Issues

- IndexSwap doesn't have the ERC4626 NAV0 constraint
- If TVL = 0 and shares > 0, first deposit sets new price
- Clean slate for new deposits after full withdrawal

## Integration with Existing System

### ProtocolCore Integration

The new system integrates with existing ProtocolCore:
- Vaults register via `registerFarm()` for farmId tracking
- Protocol owner access preserved via `owner()` query
- Pause functionality respected in IndexSwap
- Module addresses stored in separate ModuleRegistry

### MockSwapRouter Integration

All swap operations use the existing MockSwapRouter:
- Address: `0x8C82f93a99518f7381BBb29Cc29128e7C5249042`
- Provides price quotes and swap execution
- Used for TVL calculation (USD pricing)
- Supports all tokens on Base Sepolia

### USDC as Reference Currency

- USDC address: `0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4` (6 decimals)
- Used as USD reference for TVL calculations
- MockSwapRouter provides USDC price quotes

## Deployment Guide

### 1. Deploy Shared Infrastructure (Once)

```bash
npx hardhat run scripts/deploy-indexswap-system.ts --network baseSepolia
```

This deploys:
- ModuleRegistry
- SwapModule
- BuySellModule
- LendModule
- BorrowModule
- IndexSwapFactory

### 2. Create Individual Vaults (Per User)

```typescript
const portfolio = [
  { token: WETH_ADDRESS, weightBps: 5000 },  // 50%
  { token: USDC_ADDRESS, weightBps: 3000 },  // 30%
  { token: WBTC_ADDRESS, weightBps: 2000 }   // 20%
];

const tx = await indexSwapFactory.createVault(
  [ownerAddress],           // Safe owners
  1,                        // Threshold (1-of-1)
  "My Index Fund",          // Vault name
  "MIF",                    // Vault symbol
  portfolio,                // Token weights
  0,                        // farmId (0 = no registration)
  ethers.ZeroAddress        // Use default swap router
);
```

### 3. User Deposits

```typescript
// Approve USDC
await usdc.approve(indexSwapAddress, depositAmount);

// Deposit with auto-allocation
await indexSwap.depositWithAutoAllocation(
  usdcAddress,
  depositAmount
);
```

### 4. Rebalancing

```typescript
// Triggered by Safe owner or protocol owner
await indexSwap.rebalance();
```

### 5. Update Portfolio Weights

```typescript
const newPortfolio = [
  { token: WETH_ADDRESS, weightBps: 4000 },  // 40%
  { token: USDC_ADDRESS, weightBps: 4000 },  // 40%
  { token: WBTC_ADDRESS, weightBps: 2000 }   // 20%
];

await indexSwap.setPortfolio(newPortfolio);
```

## Migration Path

### For Existing BaseVault Users

1. **Deploy new IndexSwap vault** with desired portfolio
2. **Withdraw from old BaseVault** (if possible)
3. **Deposit into new IndexSwap** with auto-allocation
4. **Update frontend** to use new contract addresses
5. **Deprecate BaseVault** deployments

### Backward Compatibility

- Old BaseVault contracts continue to function
- No forced migration required
- New deployments use IndexSwap system
- Gradual transition over time

## Security Considerations

### Access Control

- **Safe owners**: Full control over their vault
- **Protocol owner**: Admin access to all vaults (emergency)
- **Module authorization**: Checked on every operation
- **Reentrancy protection**: All state-changing functions protected

### Economic Security

- **Share price manipulation**: First deposit sets price (standard ERC20 vault behavior)
- **Rebalancing slippage**: Uses MockSwapRouter quotes (deterministic on testnet)
- **Lending/borrowing**: Simulated with fixed APRs (testnet only)

### Upgrade Path

- **Modules**: Upgradeable via ModuleRegistry
- **Factory**: Deploy new factory, deprecate old
- **Individual vaults**: Immutable after deployment

## Testing Checklist

- [ ] Deploy shared infrastructure
- [ ] Create test vault with 2-token portfolio
- [ ] Deposit single token with auto-allocation
- [ ] Verify correct token distribution
- [ ] Withdraw and verify proportional returns
- [ ] Update portfolio weights
- [ ] Trigger rebalancing
- [ ] Test lending module
- [ ] Test borrowing module
- [ ] Verify TVL calculation
- [ ] Test multisig Safe (2-of-3)
- [ ] Test protocol owner access

## Future Enhancements

### Short Term
- Flash loan module
- LP position module (Uniswap V3, etc.)
- Automated rebalancing triggers
- Fee collection mechanism

### Long Term
- Cross-chain vault support
- Advanced strategies (delta-neutral, yield farming)
- Governance token integration
- Insurance fund

## Conclusion

The new IndexSwap architecture solves the fundamental design flaws of BaseVault.sol by:

1. **Separating concerns**: Safe (owner) vs IndexSwap (logic) vs Modules (operations)
2. **Enabling multi-token portfolios**: Weight-based allocation without base asset constraint
3. **Scaling DeFi operations**: Shared modules across all vaults
4. **Maintaining compatibility**: Works with existing ProtocolCore and MockSwapRouter
5. **Providing flexibility**: Both Safe owners and protocol owner can manage vaults

This design is inspired by Velvet Protocol's architecture but tailored to our specific requirements and testnet environment.
