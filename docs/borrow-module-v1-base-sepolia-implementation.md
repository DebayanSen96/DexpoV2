# Borrow Module V1 (Base Sepolia) - Implementation Notes

## Date
- 2026-04-07

## Scope Implemented
- Added borrow simulation module contracts (hub + adapter).
- Added Base Sepolia testnet wrappers.
- Added vault-side borrow command wiring in `IndexSwapV3` (`executeModuleAction`).
- Updated testnet deploy/upgrade scripts for borrow wiring.
- Added test coverage for borrow hub auth/guards/repay accounting.

## Contracts Added
- `contracts/v3/mainnet/modules/borrow/IBorrowAdapter.sol`
- `contracts/v3/mainnet/modules/borrow/BorrowHub.sol`
- `contracts/v3/test/MockBorrowAdapter.sol`
- `contracts/v3/testnet/sepolia-testnet/modules/SepoliaTestnetBorrowHub.sol`
- `contracts/v3/testnet/sepolia-testnet/modules/SepoliaTestnetMockBorrowAdapter.sol`

## Existing Contracts Updated
- `contracts/v3/mainnet/vault/IndexSwapV3.sol`
  - Added `IBorrowModule` interface.
  - Appended `ModuleCommand` entries:
    - `BORROW_OPEN`
    - `BORROW_REPAY`
    - `BORROW_REPAY_ALL`
  - Added corresponding branches in `executeModuleAction`.

## Scripts Updated
- `scripts/testnet/sepolia-testnet/deploy-protocol.ts`
  - Deploys and configures `BorrowHub` + `MockBorrowAdapter`.
  - Registers borrow module via `ModuleRegistry.setBorrowModule`.
  - Seeds curated borrow token set for simulation.
  - Persists `borrowHub`, `mockBorrowAdapter`, `adapterIds.mockBorrow`.
- `scripts/testnet/sepolia-testnet/upgrade-indexswap-vault.ts`
  - Reads/writes deployment state from `deployments/testnet/<network>.json`.

## Tests Added
- `test/BorrowModuleV1.ts`
- helper mocks:
  - `contracts/v3/test/MockProtocolCoreOwner.sol`
  - `contracts/v3/test/MockBorrowVault.sol`

## Local Validation
- `npx hardhat compile` passed.
- `npx hardhat test test/BorrowModuleV1.ts` passed (3/3).

## Live Wiring Status (Base Sepolia)
Live deploy command used:
- `npx hardhat run scripts/testnet/sepolia-testnet/deploy-protocol.ts --network base-sepolia`

### Deployed Addresses (from `deployments/testnet/base-sepolia.json`)
- `dxpToken`: `0xc781cb6e756b4Fc4db9f94770EA5700BcE12513f`
- `protocolCore`: `0x43F386993828b8431CB4a78FF8A5acefd8F7dB48`
- `oracle`: `0x9591c08BcDB82200218eAFe733476A0Bc295701F`
- `feeCollector`: `0x18b4f760504BeF827010db84Ee995a14694e369e`
- `moduleRegistry`: `0x79550E55BaabF6cb689d6b6D4F607B51F7748DB7`
- `swapHub`: `0x8bC40898D10512A6578b308eea14639C7123F863`
- `mockSwapRouter`: `0x24D3ba24c687348a8b3C1FA1fa5dBCC215931e1C`
- `mockSwapAdapter`: `0xDEe8d2DAB32114c86776ACfF1bDb8DC6CBecA4Fa`
- `lendingHub`: `0x2343d74FB279ccA7a38CF82f035Eb5af660FCc99`
- `mockLendingAdapter`: `0x3Ad6e8808c63C88bb4bBa257B2Dc7F28F124C1F8`
- `borrowHub`: `0xBb335dd6fD946B3FE01e8887F1ff3029Cc2848D1`
- `mockBorrowAdapter`: `0x1eD0e23861138b979bF53824cC9FFAf03eeB3455`

### Adapter IDs
- `mockSwap`: `0x0d74f745abd815b5feef2f2c654afa7af5b9f01715ff108616c30c54a29f3795`
- `mockLending`: `0xe4e47c0e9e61fba434e6417b61311a8dabe6df0e65a46a4608a506448c0bd5e8`
- `mockBorrow`: `0x9ba1264cee0f76efce827b6bb11c7fe001994980bec259855145c5de02fdae25`

### On-Chain Module Registry Verification
- `getSwapModule()` -> `0x8bC40898D10512A6578b308eea14639C7123F863`
- `getLendModule()` -> `0x2343d74FB279ccA7a38CF82f035Eb5af660FCc99`
- `getBorrowModule()` -> `0xBb335dd6fD946B3FE01e8887F1ff3029Cc2848D1`

## Bytecode Fix
- Root cause:
  - `IndexSwapV3` base artifact was under the limit, but the wrapper `SepoliaTestnetIndexSwapV3` was compiling without the same size-optimized override and produced `25498` deployed bytes.
- Fix applied:
  - Added explicit Hardhat overrides for:
    - `contracts/v3/testnet/sepolia-testnet/vault/SepoliaTestnetIndexSwapV3.sol`
    - `contracts/v3/testnet/hoodi-testnet/vault/HoodiTestnetIndexSwapV3.sol`
- Result after rebuild:
  - wrapper deployed bytecode dropped to `22896` bytes
  - implementation deployment succeeded on Base Sepolia

## Final Live Status
- Borrow module wiring is live.
- New `IndexSwapV3` implementation is live:
  - `0xd4cE655450CfC7B53FfF9e31353E91455D1E611F`
- New `IndexSwapFactory` is live and registered in `ProtocolCore`:
  - `0x29bd45469579Ab4a86004bd5083306962A4c3C75`
- New test vault created successfully:
  - `0xeD7490abe98F6ee7b97564bD865023dE0a889Ba3`

## Remaining Optional Work
- If desired, existing previously deployed vault proxies can still be upgraded separately through the UUPS upgrade flow.
- For the agreed scope of **new vaults only**, the live Base Sepolia rollout is complete.
