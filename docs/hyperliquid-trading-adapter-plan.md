# Dexponent v3: Hyperliquid HyperEVM Trading Adapter Plan

## Goals
- Add a new v3 adapter that trades on Hyperliquid perps via CoreWriter from HyperEVM.
- Keep base asset to USDC on HyperEVM testnet.
- Ensure compatibility with existing v3 stack (FarmFactory → BaseFarm → StrategyRouter → Adapter).

## References
- CoreWriter (system): 0x3333333333333333333333333333333333333333
- Read precompiles: 0x0000000000000000000000000000000000000800+ (per L1Read.sol in docs)
- Core↔EVM transfers (system addresses per token index): 0x20..index
- Testnet chain: HyperEVM Testnet (ChainId 998), RPC https://rpc.hyperliquid-testnet.xyz/evm

## Adapter scope (MVP)
- Asset: USDC (EVM ERC20 linked to Core USDC).
- Implement IStrategyAdapter:
  - deposit(amount): pull USDC from router; ERC20 transfer to USDC Core system address; action 7 (USD class transfer) to move to perp.
  - withdraw(amount): action 7 (to spot) + action 6 (spot send to USDC system address) to credit ERC20 to adapter; transfer to router.
  - harvest(): no-op (delta 0) initially.
  - totalAssets(): use precompiles to read vault equity (or spot+perp balances); convert units to ERC20 decimals.
- Trading ops (manager):
  - placeLimitOrder(assetId, isBuy, limitPx1e8, sz1e8, reduceOnly, tif, cloid)
  - cancel by oid/cloid

## Open items to confirm
- USDC token index (uint64) on testnet and size decimals.
- Linked EVM USDC ERC20 address and decimals.
- L1Read.sol method signatures for equity, spot balance, perp position, oracle price.

## Hardhat integration
- Add network: "hyperliquid-testnet" → RPC, chainId 998, accounts from PRIVATE_KEY.
- Ensure deploy script detects network and deploys second farm with trading adapter.

## Deployment flow updates
- If network === "hyperliquid-testnet":
  - Require ASSET_TOKEN (USDC ERC20) to be provided via env.
  - Deploy HyperPerpAdapter(asset=USDC, core=ProtocolCore).
  - Whitelist adapter if registry enforced.
  - Create a second farm with this adapter (bps=10000).

## Testing
- Unit tests for action payload encoding (IDs 1,6,7).
- Mock precompiles for totalAssets.
- Basic deposit/withdraw roundtrip with local harness or annotate expectations when using live testnet.

## Governance
- Start with onlyOwner for trading functions (farm owner). Optionally extend to EIP-712 dual-sig later to match BluechipIndexAdapter pattern.
