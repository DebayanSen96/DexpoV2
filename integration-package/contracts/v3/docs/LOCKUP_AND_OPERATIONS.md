# Lockup Configuration & Manual Operations

## 📋 Table of Contents
1. [Lockup Configuration](#lockup-configuration)
2. [Deposit Auto-Allocation](#deposit-auto-allocation)
3. [Manual Buy/Sell Operations](#manual-buysell-operations)
4. [Weight Management](#weight-management)
5. [Rebalancing](#rebalancing)

---

## 🔒 Lockup Configuration

### Current Status: **NOT IMPLEMENTED**

The IndexSwap vault **does not currently support lockup periods**. Users can withdraw at any time without restrictions.

### Implementation Options

If you want to add lockup functionality, here are the recommended approaches:

#### Option 1: Per-Vault Lockup (Simple)

Add to `IndexSwap.sol`:

```solidity
uint256 public lockupSeconds;  // e.g., 3 days = 259200 seconds
mapping(address => uint256) public depositTimestamp;

function setLockupSeconds(uint256 _seconds) external onlySafeOrProtocolOwner {
    lockupSeconds = _seconds;
}

function withdraw(uint256 shares) external nonReentrant whenNotPaused {
    require(shares > 0, "Zero shares");
    require(balanceOf(msg.sender) >= shares, "Insufficient balance");
    
    // Check lockup
    if (lockupSeconds > 0) {
        require(
            block.timestamp >= depositTimestamp[msg.sender] + lockupSeconds,
            "Lockup period active"
        );
    }
    
    // ... rest of withdraw logic
}

function deposit(...) external {
    // ... deposit logic
    depositTimestamp[msg.sender] = block.timestamp;
}
```

#### Option 2: Per-User Lockup (Advanced)

```solidity
struct UserLockup {
    uint256 shares;
    uint256 unlockTime;
}

mapping(address => UserLockup[]) public userLockups;

function depositWithLockup(
    address depositToken,
    uint256 depositAmount,
    uint256 lockupSeconds
) external returns (uint256 shares) {
    // ... deposit logic
    
    userLockups[msg.sender].push(UserLockup({
        shares: shares,
        unlockTime: block.timestamp + lockupSeconds
    }));
}
```

#### Option 3: Factory-Level Configuration

Add to `IndexSwapFactory.createVault()`:

```solidity
function createVault(
    // ... existing params
    uint256 lockupSeconds  // NEW PARAMETER
) external returns (address safe, address indexSwap) {
    // ... create vault
    
    if (lockupSeconds > 0) {
        IIndexSwap(indexSwap).setLockupSeconds(lockupSeconds);
    }
}
```

---

## 💰 Deposit Auto-Allocation

### ✅ YES - Deposits Are Automatically Split by Weights

When a user deposits, the vault **automatically allocates** the deposit across all portfolio tokens according to their weights.

### How It Works

**Example**: User deposits 10,000 USDC into a vault with:
- USDC: 40%
- DAI: 30%
- USDT: 20%
- USDx: 10%

**Automatic Allocation**:
```
1. User deposits 10,000 USDC
2. Vault splits it:
   - 4,000 USDC stays as USDC (40%)
   - 3,000 USDC → swapped to DAI (30%)
   - 2,000 USDC → swapped to USDT (20%)
   - 1,000 USDC → swapped to USDx (10%)
3. User receives shares based on total USD value
```

### Code Reference

From `IndexSwap.sol` `deposit()` function:

```solidity
for (uint256 i = 0; i < portfolio.length; i++) {
    address targetToken = portfolio[i].token;
    uint16 weightBps = portfolio[i].weightBps;
    
    // Calculate target amount based on weight
    uint256 targetAmount = (depositAmount * weightBps) / BPS_DIVISOR;
    
    if (targetAmount > 0 && depositToken != targetToken) {
        // Swap to target token
        IERC20(depositToken).forceApprove(swapRouter, targetAmount);
        uint256 received = IMockSwapRouter(swapRouter).swapFrom(
            depositToken,
            targetToken,
            targetAmount,
            address(this),
            address(this)
        );
        amounts[i] = received;
    } else if (depositToken == targetToken) {
        // No swap needed
        amounts[i] = targetAmount;
    }
}
```

### Key Points

- ✅ **Fully Automatic**: No manual intervention needed
- ✅ **Weight-Based**: Always follows portfolio weights
- ✅ **Any Token**: Can deposit with any portfolio token
- ✅ **Swap Execution**: Uses MockSwapRouter for conversions

---

## 🛒 Manual Buy/Sell Operations

### Current Holdings Example

```
USDC: 4,000 (weight: 40%)
DAI:  3,000 (weight: 30%)
USDT: 2,000 (weight: 20%)
USDx: 1,000 (weight: 10%)
Total TVL: $10,000
```

### Scenario: Asset Manager Buys 100 USDC

**Question**: Won't this change the weights?

**Answer**: ✅ **YES** - Manual operations DO change actual holdings but NOT the target weights.

### What Happens

#### Step 1: Manual Buy Operation
```typescript
// Asset manager calls BuySellModule
await buySellModule.buyToken(
    vaultAddress,
    daiAddress,      // Sell DAI
    usdcAddress,     // Buy USDC
    100 * 1e18       // Spend 100 DAI
);
```

#### Step 2: Holdings After Buy
```
USDC: 4,100 (actual: 41%, target: 40%) ⚠️ OVER-WEIGHT
DAI:  2,900 (actual: 29%, target: 30%) ⚠️ UNDER-WEIGHT
USDT: 2,000 (actual: 20%, target: 20%) ✅
USDx: 1,000 (actual: 10%, target: 10%) ✅
Total TVL: $10,000 (unchanged)
```

#### Step 3: Vault is Now "Out of Balance"

The vault holdings no longer match the target weights:
- **Target Weights**: 40/30/20/10 (unchanged)
- **Actual Holdings**: 41/29/20/10 (changed)

---

## ⚖️ Weight Management

### Target Weights vs Actual Holdings

**Important Distinction**:

| Aspect | Target Weights | Actual Holdings |
|--------|---------------|-----------------|
| **What** | Desired allocation | Current balances |
| **Changed By** | `updatePortfolio()` | Deposits, withdrawals, buy/sell |
| **Used For** | Rebalancing target | TVL calculation |
| **Visible To** | `getPortfolio()` | Token balances |

### Target Weights Are Fixed

```solidity
// Target weights are stored in the portfolio array
TokenWeight[] public portfolio;

// These ONLY change when asset manager calls updatePortfolio()
function updatePortfolio(TokenWeight[] calldata newPortfolio) 
    external 
    onlySafeOrProtocolOwner 
{
    _setPortfolio(newPortfolio);
    emit PortfolioUpdated(newPortfolio);
}
```

### Actual Holdings Change Constantly

Actual holdings change from:
- ✅ User deposits
- ✅ User withdrawals
- ✅ Manual buy/sell operations
- ✅ Lending/borrowing
- ✅ Rebalancing

---

## 🔄 Rebalancing

### When to Rebalance

Rebalancing is needed when actual holdings drift from target weights due to:
1. Manual buy/sell operations
2. Price changes (if tokens have different prices)
3. Multiple deposits/withdrawals
4. Lending/borrowing activities

### How Rebalancing Works

```solidity
function rebalance() external onlySafeOrProtocolOwner nonReentrant {
    uint256 totalValueUsd = getTotalValueUsd();
    
    for (uint256 i = 0; i < portfolio.length; i++) {
        address token = portfolio[i].token;
        uint16 targetWeightBps = portfolio[i].weightBps;  // Target weight
        
        uint256 currentBalance = IERC20(token).balanceOf(address(this));
        uint256 currentValueUsd = _getTokenValueUsd(token, currentBalance);
        uint256 targetValueUsd = (totalValueUsd * targetWeightBps) / BPS_DIVISOR;
        
        if (currentValueUsd < targetValueUsd) {
            // Under-weight: Buy more
            uint256 deficitUsd = targetValueUsd - currentValueUsd;
            _rebalanceDeficit(token, deficitUsd);
        } else if (currentValueUsd > targetValueUsd) {
            // Over-weight: Sell excess
            uint256 excessUsd = currentValueUsd - targetValueUsd;
            _rebalanceSurplus(token, excessUsd);
        }
    }
}
```

### Rebalancing Example

**Before Rebalancing** (after buying 100 USDC):
```
USDC: 4,100 (41%) - OVER by 1%
DAI:  2,900 (29%) - UNDER by 1%
USDT: 2,000 (20%) - OK
USDx: 1,000 (10%) - OK
```

**Rebalancing Action**:
```
1. Detect USDC is over-weight by $100
2. Detect DAI is under-weight by $100
3. Swap 100 USDC → DAI
```

**After Rebalancing**:
```
USDC: 4,000 (40%) ✅
DAI:  3,000 (30%) ✅
USDT: 2,000 (20%) ✅
USDx: 1,000 (10%) ✅
```

---

## 📊 Summary

### Lockup Configuration
- ❌ **Not currently implemented**
- ✅ **Can be added** per-vault or per-user
- ✅ **Recommended**: Add `lockupSeconds` to vault constructor

### Deposit Auto-Allocation
- ✅ **Fully automatic** - splits by weights
- ✅ **No manual intervention** needed
- ✅ **Works with any portfolio token**

### Manual Operations
- ✅ **DO change actual holdings**
- ❌ **DO NOT change target weights**
- ⚠️ **Cause drift** from target allocation
- ✅ **Require rebalancing** to restore weights

### Weight Management
- **Target Weights**: Fixed until manually updated
- **Actual Holdings**: Change constantly
- **Rebalancing**: Brings holdings back to target weights

### Best Practices

1. **Set Lockup During Creation**: Add lockup parameter to factory
2. **Monitor Drift**: Track how far holdings deviate from targets
3. **Rebalance Regularly**: After manual operations or significant drift
4. **Document Operations**: Log all manual buy/sell for transparency
5. **Consider Slippage**: Large operations may cause price impact

---

## 🔗 Related Documentation

- [VAULT_INTERACTIONS.md](./VAULT_INTERACTIONS.md) - Manual operations guide
- [DEPLOYMENT_FLOW.md](./DEPLOYMENT_FLOW.md) - Vault creation
- [INDEXSWAP_ARCHITECTURE.md](./INDEXSWAP_ARCHITECTURE.md) - System design
