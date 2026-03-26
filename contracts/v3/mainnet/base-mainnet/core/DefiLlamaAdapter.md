# DeFi Llama Integration Guide

## How DeFi Llama Works

DeFi Llama doesn't automatically detect your protocol. You need to **submit an adapter** to their GitHub repository.

## Steps to Get Listed on DeFi Llama

### 1. Fork the DeFi Llama Adapters Repository
```bash
git clone https://github.com/DefiLlama/DefiLlama-Adapters
cd DefiLlama-Adapters
```

### 2. Create Your Protocol Adapter

Create a file: `projects/dexpo/index.js`

```javascript
const sdk = require("@defillama/sdk");

const PROTOCOL_METRICS = "0xeAc37446FA10d76EFD2Cbc363583489B5C670675"; // Your ProtocolMetrics contract

async function tvl(api) {
  // Option 1: Call your ProtocolMetrics contract directly
  const totalTvl = await api.call({
    abi: "function getTotalTVL() view returns (uint256)",
    target: PROTOCOL_METRICS,
  });
  
  // DeFi Llama expects TVL in USD with 18 decimals
  // Your contract already returns USD with 18 decimals
  return {
    "usd": totalTvl / 1e18
  };
}

// Alternative: If you want to track individual tokens
async function tvlByToken(api) {
  const vaults = await api.call({
    abi: "function getAllVaults() view returns (address[])",
    target: PROTOCOL_METRICS,
  });
  
  const balances = {};
  
  for (const vault of vaults) {
    // Get token balances from each vault
    // Add to balances object
  }
  
  return balances;
}

module.exports = {
  methodology: "TVL is calculated by summing the USD value of all assets held in Dexpo vaults",
  base: {
    tvl,
  },
};
```

### 3. Submit a Pull Request

1. Test your adapter locally:
```bash
npm install
node test.js projects/dexpo
```

2. Create a PR to `DefiLlama/DefiLlama-Adapters`

3. Include in your PR:
   - Protocol name: Dexpo
   - Website: your-website.com
   - Twitter: @your_twitter
   - Category: Yield Aggregator / Asset Management

### 4. For Fee Tracking (Revenue)

DeFi Llama also tracks protocol fees/revenue. Create: `fees/dexpo/index.js`

```javascript
const { getFeesExport } = require("../helper/getUniSubgraphFees");

async function fetch(api) {
  const FEE_COLLECTOR = "0xef7E35164ec2648BAE01D332f18a2a0FA103124c";
  
  // Get total fees from your FeeCollector
  const totalFees = await api.call({
    abi: "function getTotalFeesCollectedUsd() view returns (uint256)",
    target: "0xeAc37446FA10d76EFD2Cbc363583489B5C670675", // ProtocolMetrics
  });
  
  return {
    dailyFees: totalFees / 1e18, // You'd need to track daily
    totalFees: totalFees / 1e18,
  };
}

module.exports = {
  base: { fetch },
};
```

## Your Contract Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| ProtocolMetrics | `0xeAc37446FA10d76EFD2Cbc363583489B5C670675` |
| FeeCollector | `0xef7E35164ec2648BAE01D332f18a2a0FA103124c` |

## Available Functions for DeFi Llama

```solidity
// ProtocolMetrics.sol
function getTotalTVL() external view returns (uint256);           // Total TVL in USD (18 decimals)
function getTotalFeesCollectedUsd() external view returns (uint256); // Total fees in USD
function getProtocolStats() external view returns (
    uint256 totalTvl,
    uint256 totalFees,
    uint256 vaultCount,
    uint256 tokenCount
);
function getAllVaults() external view returns (address[] memory);
function getVaultTVL(address vault) external view returns (uint256);
```

## Timeline

- PR Review: 1-3 days
- After merge: Shows up on defillama.com within 24 hours

## Resources

- [DeFi Llama Adapters Repo](https://github.com/DefiLlama/DefiLlama-Adapters)
- [Adapter Documentation](https://docs.llama.fi/list-your-project/submit-a-project)
- [Example Adapters](https://github.com/DefiLlama/DefiLlama-Adapters/tree/main/projects)
