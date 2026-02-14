# Tennova Labs × Dexponent — Lido CSM Integration

## 1. Executive Summary

Tennova Labs is a node operator company. They run Ethereum validators (the infrastructure).
Dexponent provides the DeFi product layer (vaults, farms) that collects LP capital.

The partnership: Dexponent collects ETH from LPs → posts it as **bond** to Lido's Community Staking Module (CSM) → Lido provides 32 ETH per validator from its pool → Tennova runs the validators → staking rewards flow back to LPs.

### Value Chain

| Party | Provides | Risk |
|---|---|---|
| LPs | Capital (ETH) | Bond slashing if validators misbehave |
| Dexponent | DeFi infrastructure, smart contracts | Smart contract risk, operational risk |
| Tennova | Node operation (servers, uptime, BLS keys) | Slashing penalties, performance penalties |
| Lido CSM | 32 ETH per validator, protocol framework | Protocol-level risk |

---

## 2. How Lido CSM Actually Works

### 2.1 The Bond ≠ Stake Model

CSM is NOT like regular staking where you deposit 32 ETH to run a validator.

- You post a **bond** (collateral) — typically **~1.5 ETH for the first key**, decreasing per additional key via a curve
- In exchange, Lido allocates **32 ETH from its staking pool** to activate your validator on the beacon chain
- This is ~20x leverage on your capital
- The bond is stored as **stETH** internally (ETH/stETH/wstETH accepted, converted on deposit)
- The bond is security collateral against slashing/penalties

### 2.2 End-to-End CSM Lifecycle

```
1. Node Operator registered on CSM (one-time)
   ├── managerAddress: controls key uploads, settings
   ├── rewardAddress: receives reward claims
   └── bond curve assigned (determines bond per key)

2. Upload keys + bond
   ├── Call addValidatorKeysETH(nodeOperatorId, keysCount, pubkeys, sigs) {value: bondETH}
   ├── OR pre-deposit bond via depositETH(nodeOperatorId) {value: bondETH}  (anyone can call)
   │   then manager uploads keys separately
   └── Keys enter FIFO queue

3. Lido activates validators (automatic, no human action)
   ├── Lido Staking Router picks next keys from queue
   ├── Deposit bot sends 32 ETH → Beacon Chain deposit contract
   └── Validator activates on beacon chain (enters activation queue)

4. Validator operates (Tennova's responsibility)
   ├── Signs attestations every epoch (~6.4 min)
   ├── Proposes blocks when selected
   └── Participates in sync committees

5. Rewards accrue
   ├── Bond rebases with stETH (passive yield)
   ├── Node operator share of staking rewards (active yield)
   └── Claimable via claimRewardsStETH (requires Merkle proof from Lido oracle)

6. Exit (when needed)
   ├── Validator exits beacon chain (initiated via protocol or voluntary)
   ├── Withdrawal balance reported to CSM
   ├── Bond released (minus any penalties)
   └── ETH returned
```

### 2.3 Key CSM Contract Functions

| Function | Access | Purpose |
|---|---|---|
| `addNodeOperatorETH(...)` | Anyone (one-time) | Create new NO + upload first keys + bond |
| `addValidatorKeysETH(noId, count, keys, sigs)` | Manager only + must send exact bond ETH | Add more keys to existing NO |
| `depositETH(noId)` | Anyone | Top up bond without uploading keys |
| `claimRewardsStETH(noId, amount, cumFeeShares, proof)` | Manager OR rewardAddress | Claim accumulated rewards |
| `claimRewardsWstETH(...)` | Manager OR rewardAddress | Claim rewards as wstETH |
| `proposeNodeOperatorManagerAddressChange(noId, addr)` | Current manager | Change manager |
| `removeKeys(noId, startIdx, count)` | Manager only | Remove undeposited keys (charged a fee) |

### 2.4 CSM Mainnet Addresses (Ethereum L1)

- CSModule: `0xdA7dE2ECdDa7286B5082a8718210CB8867f1fB1e` (verify on docs.lido.fi/deployed-contracts)
- CSAccounting: check Lido deployed contracts page
- stETH: `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84`
- wstETH: `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0`

---

## 3. Current Dexponent v3 Infrastructure

### 3.1 What We Have

| Component | Contract | Purpose |
|---|---|---|
| Vault | `IndexSwapV3.sol` | Multi-token weighted portfolio vault, ERC20 shares |
| Vault Safe | `VaultSafe.sol` | Multisig controller for vault operations |
| Module Registry | `ModuleRegistry.sol` | Registry for swap, lend, borrow, staking modules |
| Factory | `IndexSwapFactory.sol` | Clones IndexSwapV3 for new vaults |
| Oracle | via ModuleRegistry | Price feeds for TVL calculation |
| Fee Collector | `FeeCollector.sol` | Performance fee distribution |

### 3.2 Relevant Existing Hooks

- `ModuleRegistry.stakingModule` — slot exists, currently **unused**. This is where LidoCSMAdapter plugs in.
- `ModuleCommand` enum in IndexSwapV3 — currently has LEND_SUPPLY, LEND_WITHDRAW, LEND_WITHDRAW_ALL, SWAP, SWAP_WITH_SLIPPAGE. Needs new commands for staking.
- `getTotalValueUsd()` — already calls `IPositionModule(lendModule).getPositionValue()`. Same pattern works for staking positions.
- `approveToken()` — can approve staking module to pull tokens.

### 3.3 What Doesn't Fit

| Gap | Why |
|---|---|
| Multi-token portfolio design | CSM integration is single-asset (ETH). Portfolio weights are meaningless. |
| `getTotalValueUsd()` only counts `balanceOf(this)` for portfolio tokens | Bonded ETH leaves the vault — invisible to TVL unless position module tracks it |
| No native ETH handling in deposits | LPs deposit ERC20 tokens. CSM needs native ETH. Need WETH unwrap step. |
| No withdrawal queue | Bond is illiquid. Pro-rata withdrawal assumes tokens are in contract. |
| No staking commands in `ModuleCommand` | Can't route to staking module from `executeModuleAction` |

---

## 4. Partnership Structure — Two Options

### Option 1: Tennova's CSM Profile (Fast Path)

Tennova already has a CSM Node Operator profile (~250 testnet keys).

```
CSM Node Operator owner:  Tennova
managerAddress:           Dexponent (our vault or multisig)
rewardAddress:            Dexponent's LidoCSMAdapter contract
```

- Tennova adds Dexponent as `managerAddress` on their existing NO
- Dexponent provides bond via `depositETH(noId)` (anyone can call)
- Either party can upload keys (manager or NO owner depending on CSM version)
- Rewards claimable by manager or rewardAddress → must be set to our adapter

**Pros:** Fastest to launch. Tennova's existing profile and testnet setup.
**Cons:** Tennova owns the NO. They could change manager address back. Less control for Dexponent.

### Option 2: Dexponent's CSM Profile (Recommended for Production)

```
CSM Node Operator owner:  Dexponent (via LidoCSMAdapter contract)
managerAddress:           Dexponent multisig (or adapter contract)
rewardAddress:            LidoCSMAdapter contract
```

- Dexponent creates the NO via `addNodeOperatorETH` with our adapter as caller
- Set `managerAddress` to Dexponent multisig
- Tennova provides keys off-chain → Dexponent uploads them
- Full custody and control

**Pros:** Dexponent controls everything. Safer for LPs.
**Cons:** Need to register fresh NO. Queue position starts from scratch.

### Recommended: Start with Option 1 for testnet/MVP, migrate to Option 2 for mainnet.

---

## 5. Integration Architecture

### 5.1 Component Diagram

```
┌──────────────────────────────────────────────────┐
│                   LP Users                        │
│              deposit ETH/WETH                     │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│            IndexSwapV3 (Staking Vault)            │
│                                                   │
│  portfolio: [WETH, 100%]                          │
│  stakingModule: LidoCSMAdapter                    │
│                                                   │
│  deposit()      → LP deposits WETH                │
│  withdraw()     → withdrawal buffer or queue      │
│  executeModuleAction(STAKE_BOND, ...)             │
│  executeModuleAction(STAKE_CLAIM_REWARDS, ...)    │
│  getTotalValueUsd() → balance + adapter position  │
│                                                   │
│  New ModuleCommands:                              │
│    STAKE_BOND          → send ETH as CSM bond     │
│    STAKE_CLAIM_REWARDS → pull stETH rewards back  │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│            LidoCSMAdapter (New Contract)           │
│            Registered as stakingModule             │
│                                                   │
│  depositBond(vault, noId, amount)                 │
│    → unwrap WETH → call CSM.depositETH{value}()  │
│                                                   │
│  claimRewards(vault, noId, amount, proof)         │
│    → call CSM.claimRewardsStETH()                 │
│    → swap stETH → WETH (or keep as stETH)        │
│    → transfer back to vault                       │
│                                                   │
│  getPositionValue(vault) → returns:               │
│    bond value (stETH balance on CSM)              │
│    + pending unclaimed rewards                    │
│    all priced in USD via oracle                   │
│                                                   │
│  nodeOperatorId: stored per vault                 │
│  csModule: Lido CSM contract address              │
└──────────────┬───────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│         Lido CSModule (External, Mainnet)          │
│                                                   │
│  depositETH(noId) ← anyone can call               │
│  addValidatorKeysETH(noId, keys, sigs) ← manager  │
│  claimRewardsStETH(noId, ...) ← manager/reward    │
│                                                   │
│  Staking Router allocates 32 ETH per key          │
│  → deposited directly to Beacon Chain             │
└──────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────┐
│        Tennova Validators (Off-chain)             │
│                                                   │
│  Runs consensus + execution + validator clients   │
│  Holds BLS private keys                           │
│  Signs attestations, proposes blocks              │
│  Provides public keys to Dexponent (API/manual)   │
└──────────────────────────────────────────────────┘
```

### 5.2 Contract Changes Required

#### A. IndexSwapV3.sol — Add Staking Commands

```solidity
enum ModuleCommand {
    LEND_SUPPLY,
    LEND_WITHDRAW,
    LEND_WITHDRAW_ALL,
    SWAP,
    SWAP_WITH_SLIPPAGE,
    STAKE_BOND,            // NEW
    STAKE_CLAIM_REWARDS    // NEW
}
```

In `executeModuleAction`, add handlers:

```solidity
} else if (command == ModuleCommand.STAKE_BOND) {
    (uint256 amount) = abi.decode(params, (uint256));
    address staking = IModuleRegistry(moduleRegistry).getStakingModule();
    require(staking != address(0), "Staking module not set");
    // Approve WETH to staking module
    IERC20(portfolio[0].token).forceApprove(staking, amount);
    uint256 bonded = IStakingModule(staking).depositBond(address(this), amount);
    return abi.encode(bonded);

} else if (command == ModuleCommand.STAKE_CLAIM_REWARDS) {
    address staking = IModuleRegistry(moduleRegistry).getStakingModule();
    require(staking != address(0), "Staking module not set");
    uint256 claimed = IStakingModule(staking).claimRewards(address(this));
    return abi.encode(claimed);
}
```

#### B. getTotalValueUsd() — Already Handles This (Partially)

The existing code at line 610-614 already tries to get lendModule position value. We need the same for staking:

```solidity
address stakingMod = IModuleRegistry(moduleRegistry).getStakingModule();
if (stakingMod != address(0)) {
    try IPositionModule(stakingMod).getPositionValue(address(this), address(0)) returns (uint256 stakingValue) {
        totalUsd += stakingValue;
    } catch {}
}
```

#### C. New Contract: LidoCSMAdapter.sol

Core interface:

```solidity
interface IStakingModule {
    function depositBond(address vault, uint256 wethAmount) external returns (uint256 bondedAmount);
    function claimRewards(address vault) external returns (uint256 claimedAmount);
    function getPositionValue(address vault, address token) external view returns (uint256 valueUsd);
    function getNodeOperatorId(address vault) external view returns (uint256);
}
```

The adapter:
- Receives WETH from vault
- Unwraps to ETH
- Calls `CSModule.depositETH{value: amount}(nodeOperatorId)`
- For claims: calls `CSModule.claimRewardsStETH(...)` with Merkle proof
- Tracks bond amounts per vault
- Reports position value (bond + pending rewards) via `getPositionValue`

#### D. Key Upload — Separate Path (Off-chain → Manager EOA → CSM)

Key upload does NOT go through the vault. The flow is:
1. Tennova generates keys, sends pubkeys + signatures to Dexponent (API/manual)
2. Dexponent's manager address (EOA multisig) calls `CSModule.addValidatorKeysETH(noId, count, keys, sigs)` directly
3. Bond must already be pre-deposited via the vault → adapter → CSM path
4. If sufficient bond exists, `addValidatorKeysETH` can be called with `msg.value = 0`
   (because `getRequiredBondForNextKeys` returns 0 when bond is pre-deposited)

---

## 6. Withdrawal / Liquidity Design

This is the hardest problem. Bond locked in CSM cannot be withdrawn instantly.

### 6.1 Bond Unlock Timeline

```
Request validator exit → ~2-5 days for exit → withdrawal reported to CSM → bond unlocked
```

### 6.2 Recommended: Buffer + Queue Hybrid

```
Total Vault ETH = Buffer (liquid, in contract) + Bonded (locked in CSM)
```

- Maintain a **buffer ratio** (e.g., 20% liquid, 80% bonded)
- Small withdrawals served instantly from buffer
- Large withdrawals trigger validator exit request → enter withdrawal queue
- `lockupSeconds` parameter in IndexSwapV3 helps enforce minimum hold period

### 6.3 Implementation

```solidity
// In withdraw(), check buffer first
uint256 bufferBalance = IERC20(weth).balanceOf(address(this));
uint256 userShare = (bufferBalance * shares) / totalSupply();

if (userShare <= bufferBalance) {
    // Instant withdrawal from buffer
} else {
    // Queue withdrawal, request validator exits
    // LP gets a withdrawal NFT or queued position
}
```

### 6.4 Buffer Rebalancing

The vault owner periodically:
1. When buffer is high (deposits coming in) → `STAKE_BOND` to move ETH to CSM
2. When buffer is low (withdrawals draining it) → request validator exits, wait for bond to unlock

---

## 7. Reward Flow

### 7.1 Revenue Sources

| Source | Mechanism | Frequency |
|---|---|---|
| Bond rebase | stETH in CSM appreciates | Continuous (daily rebase) |
| NO reward share | Lido distributes staking rewards to NO | Per oracle report (~daily) |

### 7.2 Claiming

1. Lido oracle publishes reward distribution (Merkle tree)
2. Dexponent backend fetches proof for our `nodeOperatorId`
3. Vault owner calls `executeModuleAction(STAKE_CLAIM_REWARDS, ...)`
4. Adapter calls `CSModule.claimRewardsStETH(noId, amount, cumFeeShares, proof)`
5. stETH sent to adapter's `rewardAddress`
6. Adapter swaps stETH → WETH (via swap module or DEX) or keeps stETH
7. WETH transferred back to vault → vault TVL increases → share price goes up

### 7.3 Fee Collection

Existing `performanceFeeBps` + `FeeCollector` + high water mark mechanism in IndexSwapV3 handles this automatically. When claimed rewards increase vault TVL above HWM, performance fee is collectible.

---

## 8. Risk Matrix

| Risk | Severity | Mitigation |
|---|---|---|
| Tennova validators slashed | HIGH — bond (LP capital) penalized | Monitor validator performance; cap bond per validator; diversify operators later |
| Withdrawal liquidity crunch | MEDIUM — LPs can't exit | Buffer ratio; lockup period; withdrawal queue |
| Lido CSM protocol risk | LOW-MEDIUM — smart contract bug in CSM | Lido is audited, battle-tested; but tail risk exists |
| stETH negative rebase | LOW — bond value drops | Lido has insurance fund; historically never happened significantly |
| Tennova disappears | MEDIUM — validators go offline, leak penalties | Dexponent can request exits; bond covers initial penalties |
| Key front-running (deposit front-run) | LOW — Lido DSM mitigates this | CSM uses Deposit Security Module for vetting |
| Oracle manipulation (reward proofs) | LOW — Lido oracle is decentralized | Multiple oracle committee members |

---

## 9. Implementation Phases

### Phase 1: Testnet MVP (1-2 weeks)

- [ ] Deploy LidoCSMAdapter on Holesky testnet
- [ ] Register test Node Operator on CSM Holesky
- [ ] Add STAKE_BOND / STAKE_CLAIM_REWARDS commands to IndexSwapV3
- [ ] Add staking position value to getTotalValueUsd()
- [ ] Create staking vault (IndexSwapV3 with WETH-only portfolio)
- [ ] Test: deposit → bond → key upload → validator activation → reward claim
- [ ] Coordinate with Tennova for testnet key provision

### Phase 2: Mainnet Launch (2-3 weeks after Phase 1)

- [ ] Audit LidoCSMAdapter (at minimum internal review + external eyes)
- [ ] Deploy adapter to Ethereum mainnet
- [ ] Register mainnet Node Operator (Option 1: on Tennova's profile initially)
- [ ] Set up monitoring for validator performance
- [ ] Set up off-chain service for Merkle reward proof fetching
- [ ] Deploy staking vault via IndexSwapFactory
- [ ] Configure: buffer ratio, lockup period, performance fee, min deposit

### Phase 3: Production Hardening (ongoing)

- [ ] Migrate to Option 2 (Dexponent-owned NO) if needed
- [ ] Implement full withdrawal queue (ERC-721 withdrawal NFTs)
- [ ] Add multi-operator support (diversify beyond Tennova)
- [ ] Dashboard: validator status, bond utilization, APY tracking
- [ ] Automation: auto-bond when buffer threshold hit, auto-claim rewards

---

## 10. Open Questions for Tennova / Management

1. **Which CSM profile to use?** Option 1 (Tennova's existing) or Option 2 (Dexponent creates new)?
2. **Key delivery mechanism?** API endpoint, manual handoff, or automated pipeline?
3. **How many validators initially?** Determines initial capital requirement (bond curve).
4. **Who monitors validator health?** Tennova, Dexponent, or shared?
5. **Revenue split?** Is Tennova compensated from performance fee, or separate agreement?
6. **Target network?** Ethereum mainnet only, or also L2 restaking later?
7. **Buffer ratio preference?** Higher buffer = more liquid for LPs, lower capital efficiency.
