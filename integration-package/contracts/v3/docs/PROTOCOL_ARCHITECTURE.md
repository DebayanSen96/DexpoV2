# V3 Protocol Architecture - Base Mainnet

## System Overview

```mermaid
graph TB
    subgraph "User Layer"
        User[👤 User/Investor]
        SafeOwner[👤 Safe Owner]
    end

    subgraph "Core Protocol"
        ProtocolCore[🏛️ ProtocolCore<br/>Owner & Governance]
        DXPToken[🪙 DXP Token<br/>Protocol Token]
        FeeCollector[💰 FeeCollector<br/>Fee Distribution]
        ModuleRegistry[📋 ModuleRegistry<br/>Module Discovery]
        ChainlinkOracle[🔮 ChainlinkOracle<br/>Price Feeds]
    end

    subgraph "Vault Layer"
        VaultSafe[🔐 VaultSafe<br/>Multi-sig Safe<br/>Asset Custody]
        IndexSwapV3[📊 IndexSwapV3<br/>ERC4626 Vault<br/>Portfolio Management]
        IndexSwapFactory[🏭 IndexSwapFactory<br/>Vault Deployment]
    end

    subgraph "Swap Infrastructure"
        SwapHub[🔄 SwapHub<br/>Swap Orchestrator<br/>Multi-DEX Router]
        
        subgraph "Swap Adapters"
            AerodromeAdapter[🌊 AerodromeAdapter<br/>Aerodrome DEX]
            UniswapV3Adapter[🦄 UniswapV3Adapter<br/>Uniswap V3]
        end
    end

    subgraph "Lending Infrastructure"
        LendingHub[🏦 LendingHub<br/>Lending Orchestrator<br/>Multi-Protocol Router]
        
        subgraph "Lending Adapters"
            AaveV3Adapter[⚡ AaveV3Adapter<br/>Aave V3 Protocol]
        end
    end

    subgraph "External Protocols - Base Mainnet"
        Aerodrome[Aerodrome Router<br/>0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43]
        UniswapRouter[Uniswap V3 Router<br/>0x2626664c2603336E57B271c5C0b26F421741e481]
        AavePool[Aave V3 Pool<br/>via PoolProvider<br/>0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D]
        ChainlinkFeeds[Chainlink Price Feeds<br/>USDC/USD, ETH/USD]
    end

    User -->|Deposit/Withdraw| IndexSwapV3
    SafeOwner -->|Manage| VaultSafe
    
    IndexSwapFactory -->|Deploys| IndexSwapV3
    IndexSwapFactory -->|Deploys| VaultSafe
    
    IndexSwapV3 -->|Holds Assets| VaultSafe
    IndexSwapV3 -->|Queries Modules| ModuleRegistry
    IndexSwapV3 -->|Pays Fees| FeeCollector
    
    ModuleRegistry -->|Registers| SwapHub
    ModuleRegistry -->|Registers| LendingHub
    ModuleRegistry -->|Registers| ChainlinkOracle
    
    IndexSwapV3 -->|Swap Tokens| SwapHub
    IndexSwapV3 -->|Supply/Withdraw| LendingHub
    
    SwapHub -->|Routes to| AerodromeAdapter
    SwapHub -->|Routes to| UniswapV3Adapter
    SwapHub -->|Price Validation| ChainlinkOracle
    
    LendingHub -->|Routes to| AaveV3Adapter
    LendingHub -->|Price Validation| ChainlinkOracle
    
    AerodromeAdapter -->|Executes Swap| Aerodrome
    UniswapV3Adapter -->|Executes Swap| UniswapRouter
    AaveV3Adapter -->|Supply/Withdraw| AavePool
    
    ChainlinkOracle -->|Fetches Prices| ChainlinkFeeds
    
    ProtocolCore -->|Governs| FeeCollector
    ProtocolCore -->|Governs| ModuleRegistry
    ProtocolCore -->|Governs| IndexSwapFactory
    
    FeeCollector -->|Distributes| DXPToken

    style ProtocolCore fill:#e1f5ff,stroke:#0066cc,stroke-width:3px
    style SwapHub fill:#fff4e1,stroke:#ff9800,stroke-width:3px
    style LendingHub fill:#e8f5e9,stroke:#4caf50,stroke-width:3px
    style IndexSwapV3 fill:#f3e5f5,stroke:#9c27b0,stroke-width:3px
    style VaultSafe fill:#ffebee,stroke:#f44336,stroke-width:2px
```

## Authorization Flow

```mermaid
sequenceDiagram
    participant User
    participant SafeOwner
    participant IndexSwapV3
    participant SwapHub
    participant Adapter
    participant DEX

    Note over User,DEX: Deposit Flow
    User->>IndexSwapV3: deposit(amount)
    IndexSwapV3->>IndexSwapV3: mint shares
    IndexSwapV3->>VaultSafe: transfer tokens
    
    Note over User,DEX: Swap Flow (Safe Owner Initiated)
    SafeOwner->>IndexSwapV3: rebalance()
    IndexSwapV3->>SwapHub: swap(vault, tokenIn, tokenOut, amount)
    SwapHub->>SwapHub: Check authorization<br/>(vault, safe owner, or protocol owner)
    SwapHub->>SwapHub: Select best adapter
    SwapHub->>Adapter: swap(tokenIn, tokenOut, amount, minOut, recipient)
    Adapter->>Adapter: Check onlyHub
    Adapter->>DEX: Execute swap
    DEX-->>Adapter: Return tokens
    Adapter-->>SwapHub: amountOut
    SwapHub-->>IndexSwapV3: amountOut
    
    Note over User,DEX: Lending Flow
    SafeOwner->>IndexSwapV3: supplyToLending(token, amount)
    IndexSwapV3->>LendingHub: supply(vault, token, amount, adapterId)
    LendingHub->>LendingHub: Check authorization
    LendingHub->>AaveV3Adapter: supply(token, amount, onBehalfOf)
    AaveV3Adapter->>AaveV3Adapter: Check onlyHub
    AaveV3Adapter->>AavePool: supply(asset, amount, onBehalfOf, 0)
    AavePool-->>AaveV3Adapter: aTokens minted
    AaveV3Adapter-->>LendingHub: shares received
    LendingHub->>LendingHub: Update position tracking
```

## Hub-Adapter Pattern

```mermaid
graph LR
    subgraph "Hub Layer (Protocol Logic)"
        Hub[Hub Contract<br/>- Authorization<br/>- Adapter Registry<br/>- Best Quote<br/>- Position Tracking]
    end
    
    subgraph "Adapter Layer (Protocol Integration)"
        A1[Adapter 1<br/>Protocol A]
        A2[Adapter 2<br/>Protocol B]
        A3[Adapter 3<br/>Protocol C]
    end
    
    subgraph "External Layer"
        P1[Protocol A]
        P2[Protocol B]
        P3[Protocol C]
    end
    
    Vault[Vault] -->|Calls| Hub
    Hub -->|Routes| A1
    Hub -->|Routes| A2
    Hub -->|Routes| A3
    A1 -->|Integrates| P1
    A2 -->|Integrates| P2
    A3 -->|Integrates| P3
    
    style Hub fill:#fff4e1,stroke:#ff9800,stroke-width:3px
    style Vault fill:#f3e5f5,stroke:#9c27b0,stroke-width:2px
```

## Data Flow - Swap Example

```mermaid
flowchart TD
    Start([User wants to swap USDC → WETH])
    
    Start --> CheckAuth{Is caller authorized?<br/>Vault, Safe Owner, or Protocol Owner}
    CheckAuth -->|No| Reject[❌ Revert: NotAuthorized]
    CheckAuth -->|Yes| SelectAdapter{Adapter specified?}
    
    SelectAdapter -->|No| UseDefault[Use defaultAdapterId]
    SelectAdapter -->|Yes| UseSpecified[Use specified adapterId]
    
    UseDefault --> ValidateAdapter{Is adapter active?}
    UseSpecified --> ValidateAdapter
    
    ValidateAdapter -->|No| RejectAdapter[❌ Revert: AdapterNotActive]
    ValidateAdapter -->|Yes| CheckRoute{Is route supported?}
    
    CheckRoute -->|No| RejectRoute[❌ Revert: RouteNotSupported]
    CheckRoute -->|Yes| TransferTokens[Transfer USDC from vault to hub]
    
    TransferTokens --> ApproveAdapter[Approve adapter to spend USDC]
    ApproveAdapter --> CallAdapter[Call adapter.swap]
    
    CallAdapter --> AdapterValidation{Adapter checks onlyHub}
    AdapterValidation -->|Fail| RejectHub[❌ Revert: OnlyHub]
    AdapterValidation -->|Pass| ApproveRouter[Adapter approves DEX router]
    
    ApproveRouter --> ExecuteDEX[Execute swap on DEX<br/>Aerodrome or Uniswap]
    ExecuteDEX --> ReceiveTokens[Receive WETH to vault]
    
    ReceiveTokens --> CheckSlippage{amountOut >= minAmountOut?}
    CheckSlippage -->|No| RejectSlippage[❌ Revert: SlippageExceeded]
    CheckSlippage -->|Yes| EmitEvent[✅ Emit Swapped event]
    
    EmitEvent --> End([Swap complete])
    
    style Start fill:#e3f2fd
    style End fill:#c8e6c9
    style Reject fill:#ffcdd2
    style RejectAdapter fill:#ffcdd2
    style RejectRoute fill:#ffcdd2
    style RejectHub fill:#ffcdd2
    style RejectSlippage fill:#ffcdd2
```

## Contract Addresses (Base Mainnet)

### Core Contracts
- **ProtocolCore**: Deployed via deploy-protocol.ts
- **DXP Token**: Deployed via deploy-protocol.ts
- **FeeCollector**: Deployed via deploy-protocol.ts
- **ModuleRegistry**: Deployed via deploy-protocol.ts
- **ChainlinkOracle**: Deployed via deploy-protocol.ts

### Swap Infrastructure
- **SwapHub**: Deployed via deploy-protocol.ts
- **AerodromeAdapter**: Deployed via deploy-protocol.ts
  - Adapter ID: `keccak256("AERODROME")`
- **UniswapV3Adapter**: Deployed via deploy-protocol.ts
  - Adapter ID: `keccak256("UNISWAP_V3")`

### Lending Infrastructure
- **LendingHub**: Deployed via deploy-protocol.ts
- **AaveV3Adapter**: Deployed via deploy-protocol.ts
  - Adapter ID: `keccak256("AAVE_V3")`

### Factory & Vault
- **IndexSwapFactory**: Deployed via deploy-protocol.ts
- **VaultSafe** (Test): Deployed via deploy-protocol.ts
- **IndexSwapV3** (Test): Deployed via deploy-protocol.ts

### External Protocol Addresses (Base Mainnet)
- **USDC**: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **WETH**: `0x4200000000000000000000000000000000000006`
- **Aave Pool Provider**: `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D`
- **Aerodrome Router**: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- **Aerodrome Factory**: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`
- **Uniswap V3 Router**: `0x2626664c2603336E57B271c5C0b26F421741e481`
- **Uniswap V3 Quoter**: `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
- **Chainlink USDC/USD**: `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B`
- **Chainlink ETH/USD**: `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`

## Key Features

### Hub-Adapter Architecture
- **Modularity**: Add/remove DEXes and lending protocols without redeploying hubs
- **Best Execution**: `getBestQuote()` compares all active adapters
- **Fallback**: Route to alternative protocols if one fails
- **Upgradability**: Update adapter implementations independently

### Authorization Model
- **Three-tier access**: Vault itself, Safe owners, Protocol owner
- **Hub-only adapters**: Adapters can only be called by their respective hubs
- **Reentrancy protection**: All hubs use `nonReentrant` modifier

### Position Tracking
- **LendingHub**: Tracks shares, supplied amounts, and adapter IDs per vault per token
- **Interest accrual**: Calculates current value vs supplied principal
- **Multi-adapter support**: Each vault can use different adapters per token

### Fee Management
- **Performance fees**: Charged on profits above high water mark
- **Protocol cut**: FeeCollector distributes fees between vault owner and protocol
- **Authorized vaults**: Only whitelisted vaults can use FeeCollector
