# Dexponent Protocol v3 – Documentation

This folder contains concise technical documentation for the Dexponent protocol contracts to support litepaper updates. Each page cites concrete contracts, functions, and file paths.

- Protocol Overview: `protocol-overview.md`
- Stakeholders & Incentives: `stakeholders.md`
- Farms (Creation & Customization): `farms.md`
- Rewards, Payouts & Claims: `rewards.md`
- Strategy Router: `router.md`
- Tokens (Share, Claim, DXP): `tokens.md`
- Consensus & Verifiers: `consensus.md`
- Governance & Security: `governance-security.md`
- End-to-end Flows: `flows.md`
- Glossary: `glossary.md`
- Architecture Diagrams: `architecture-diagrams.md`
- ProtocolCore: `protocol-core.md`

For code references, see:
- Core: `contracts/ProtocolCore.sol`
- Farm stack: `contracts/v3/farm/BaseFarm.sol`, `contracts/v3/factories/FarmFactory.sol`
- Modules: `contracts/v3/modules/*`
- Router & Adapters: `contracts/v3/strategies/StrategyRouter.sol`
- Tokens: `contracts/v3/tokens/ShareToken.sol`, `contracts/ClaimToken.sol`, `contracts/DXPToken.sol`, `contracts/vDXPToken.sol`
- Root Farm (legacy path): `contracts/RootFarm.sol`
