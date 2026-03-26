# Hoodi Testnet Staking API Integration

This document explains how a backend API can automate the Hoodi testnet staking flow for the Dexponent staking vault.

Scope of this doc:
- Network: Hoodi testnet
- Starting point: the vault has already accumulated enough LP capital for one validator bond
- Actor: backend API acting as `protocolOwner`
- Goal: execute the staking action on behalf of the vault owner

## 1. Main Idea

The vault does not stake by calling Lido directly from the backend wallet.

The backend calls the Dexponent vault contract, and the vault calls the staking module.

Current live flow:
1. LP capital enters the vault
2. Vault holds wrapped native ETH internally as WETH
3. `protocolOwner` approves the staking module to pull WETH from the vault
4. `protocolOwner` calls the staking action on the vault
5. The vault calls `LidoCSMAdapter.depositBond(...)`
6. The adapter unwraps WETH to native ETH
7. The adapter calls Hoodi CSM to create the node operator and submit the first validator key

Important:
- LPs can now deposit native Hoodi ETH into the vault through `depositNative(...)`
- Internally the vault still holds WETH
- The adapter unwraps only at the final CSM boundary

## 2. Relevant Contracts

Current Hoodi deployment addresses are stored in [hoodi-testnet.json](/C:/Work/DexpoV2/deployments/testnet/hoodi-testnet.json).

As of the fresh deployment on March 26, 2026:
- `ProtocolCore`: `0x435F641F3456dB459BCAC043bbA06fe14C98011c`
- `ModuleRegistry`: `0x0c914cc97D118Bf1fe26dfcCF0C0DD13f04A824B`
- `LidoCSMAdapter`: `0xFF98698007149d7075e7bE64a2b7C70CCD400b35`
- `CSM Vault`: `0xE5B685D469d2C15402f4f81b45d1F080e5b389de`
- `MockWETH`: `0xef7E35164ec2648BAE01D332f18a2a0FA103124c`

External Hoodi CSM contracts used by the adapter:
- `CSModule`: `0x79CEf36D84743222f37765204Bec41E92a93E59d`
- `CSAccounting`: `0xA54b90BA34C5f326BC1485054080994e38FB4C60`
- `PermissionlessGate`: `0x5553077102322689876A6AdFd48D75014c28acfb`
- `StakingRouter`: `0xCc820558B39ee15C7C45B59390B503b83fb499A8`

## 3. Who Is Allowed To Call

The vault functions are protected by `onlySafeOrProtocolOwner` in [IndexSwapV3.sol](/C:/Work/DexpoV2/contracts/v3/mainnet/vault/IndexSwapV3.sol#L129).

That means any of these can call:
- `safe`
- `vaultOwner`
- `ProtocolCore.owner()`

For API automation, the intended actor is:
- `protocolOwner = owner()` of `ProtocolCore`

This is why the backend can execute the staking flow on behalf of the vault owner.

## 4. Starting State Assumption

Your requested starting state is:
- the vault has already accumulated `2.4 ETH` from LP deposits

Operationally, that means:
- if LPs used `depositNative(...)`, the vault now holds WETH internally
- the staking backend should treat the vault asset as WETH, not raw ETH

So by the time the backend triggers staking, the vault should already hold:
- `2.4 WETH` of internal balance

The native ETH unwrap happens later inside the adapter.

## 5. Contracts And Functions The Backend Must Use

### 5.1 Optional LP Deposit Entry Point

If the backend itself also needs to deposit native Hoodi ETH into the vault, use:

Contract:
- `IndexSwapV3`

Function:
```solidity
function depositNative(address wrappedToken) external payable returns (uint256 shares)
```

Source:
- [IndexSwapV3.sol](/C:/Work/DexpoV2/contracts/v3/mainnet/vault/IndexSwapV3.sol#L295)

Arguments:
- `wrappedToken`: the WETH token configured in the vault portfolio

On Hoodi now:
- `wrappedToken = 0xef7E35164ec2648BAE01D332f18a2a0FA103124c`

Call behavior:
- sends native ETH to the vault
- vault wraps it into WETH internally
- vault mints shares to the caller

### 5.2 Approve The Staking Module

Before staking, the vault must approve the staking module to pull WETH.

Contract:
- `IndexSwapV3`

Function:
```solidity
function approveToken(address token, address spender, uint256 amount) external
```

Source:
- [IndexSwapV3.sol](/C:/Work/DexpoV2/contracts/v3/mainnet/vault/IndexSwapV3.sol#L591)

Arguments:
- `token`: WETH token address
- `spender`: staking module address from `ModuleRegistry`
- `amount`: bond amount, for example `2.4 ETH`

Current Hoodi values:
- `token = 0xef7E35164ec2648BAE01D332f18a2a0FA103124c`
- `spender = 0xFF98698007149d7075e7bE64a2b7C70CCD400b35`

Can `protocolOwner` do this?
- Yes

Why:
- `approveToken` is guarded by `onlySafeOrProtocolOwner`
- the staking module is a registered spender in the vault logic

### 5.3 Execute The Staking Action

This is the main backend action.

Contract:
- `IndexSwapV3`

Function:
```solidity
function executeModuleAction(uint8 command, bytes calldata params) external returns (bytes memory)
```

Source:
- [IndexSwapV3.sol](/C:/Work/DexpoV2/contracts/v3/mainnet/vault/IndexSwapV3.sol#L616)

Relevant enum:
```solidity
STAKE_BOND = 5
```

Source:
- [IndexSwapV3.sol](/C:/Work/DexpoV2/contracts/v3/mainnet/vault/IndexSwapV3.sol#L119)

For staking, the backend must call:
- `executeModuleAction(5, params)`

The vault internally decodes:
```solidity
(address token, uint256 amount, bytes memory validatorData)
```

Source:
- [IndexSwapV3.sol](/C:/Work/DexpoV2/contracts/v3/mainnet/vault/IndexSwapV3.sol#L651)

So the backend must encode:
```solidity
abi.encode(address token, uint256 amount, bytes validatorData)
```

Where:
- `token` = WETH token address
- `amount` = bond amount in wei, typically `2.4 ether`
- `validatorData` = `abi.encode(bytes pubkey, bytes signature)`

### 5.4 What The Adapter Expects

The vault calls:
```solidity
function depositBond(address vault, uint256 amount, bytes calldata validatorData) external
```

Source:
- [LidoCSMAdapter.sol](/C:/Work/DexpoV2/contracts/v3/modules/LidoCSMAdapter.sol#L113)

Inside the adapter:
- `validatorData` is decoded as `(bytes pubkey, bytes signature)`
- `pubkey.length` must be `48`
- `signature.length` must be `96`

If this is the first stake for the vault:
- the adapter creates a new node operator via `PermissionlessGate.addNodeOperatorETH(...)`
- the adapter passes exactly one validator key

If the vault already has a registered node operator:
- the adapter only tops up bond if needed
- it does not currently upload an additional validator key

This is an important limitation.

## 6. Backend Input Data Needed

For the first validator registration flow, the backend must have:
- `vaultAddress`
- `wrappedTokenAddress`
- `stakingModuleAddress`
- `bondAmountWei`
- `validatorPubkey`
- `validatorSignature`

Expected validator payload:
- `pubkey`: 48-byte BLS validator pubkey
- `signature`: 96-byte deposit signature

Strongly recommended backend validation before broadcasting:
- verify `pubkey` length is 48 bytes
- verify `signature` length is 96 bytes
- verify `withdrawal_credentials` in your source JSON matches `StakingRouter.getWithdrawalCredentials()`

Note:
- the current adapter does not validate `withdrawal_credentials`
- the deployment script already does this off-chain check before staking

Reference implementation:
- [deploy-staking-stack.mjs](/C:/Work/DexpoV2/scripts/testnet/hoodi-testnet/deploy-staking-stack.mjs#L243)

## 7. Exact Backend Sequence

### Step 1: Load Current Addresses

Read current Hoodi deployment addresses from:
- [hoodi-testnet.json](/C:/Work/DexpoV2/deployments/testnet/hoodi-testnet.json)

The backend should not hardcode Dexponent contract addresses if it can avoid it.

### Step 2: Check Vault Balance

Confirm the vault already holds enough WETH balance for one bond:
- `IERC20(weth).balanceOf(vault)`

If LPs are still depositing native ETH into the vault:
- that deposit should already have been converted to WETH through `depositNative(...)`

### Step 3: Approve Adapter To Pull WETH

Call on vault:
```solidity
approveToken(weth, stakingModule, bondAmount)
```

Caller:
- `protocolOwner`

### Step 4: Build Validator Payload

Encode validator payload:
```solidity
validatorData = abi.encode(pubkeyBytes, signatureBytes)
```

Then encode module params:
```solidity
params = abi.encode(weth, bondAmount, validatorData)
```

### Step 5: Execute Staking Action

Call on vault:
```solidity
executeModuleAction(5, params)
```

Caller:
- `protocolOwner`

What happens next:
1. Vault checks caller authorization
2. Vault approves the adapter to spend the token amount
3. Vault calls `LidoCSMAdapter.depositBond(...)`
4. Adapter pulls WETH from vault
5. Adapter unwraps WETH to ETH
6. Adapter calls `addNodeOperatorETH(...)`
7. Hoodi CSM creates the node operator and registers the validator key

## 8. Example ABI Surface For Backend

### Vault ABI Fragments

```json
[
  "function depositNative(address wrappedToken) payable returns (uint256 shares)",
  "function approveToken(address token, address spender, uint256 amount)",
  "function executeModuleAction(uint8 command, bytes params) returns (bytes)",
  "function getTotalValueUsd() view returns (uint256)",
  "function getSharePrice() view returns (uint256)"
]
```

### Adapter ABI Fragments

```json
[
  "function vaultNodeOperatorId(address vault) view returns (uint256)",
  "function vaultBondedEth(address vault) view returns (uint256)",
  "function getNodeOperatorId(address vault) view returns (uint256)",
  "function getBondedEth(address vault) view returns (uint256)"
]
```

### Hoodi CSM Read ABIs

```json
[
  "function getNodeOperator(uint256) view returns (tuple(uint32 totalAddedKeys,uint32 totalExitedKeys,uint32 totalDepositedKeys,uint32 totalVettedKeys,uint32 stuckValidatorsCount,uint32 depositableValidatorsCount,uint32 targetValidatorsCount,uint8 status,uint32 enqueuedCount,uint32 totalWithdrawnKeys,address managerAddress,address rewardAddress,address proposedManagerAddress,address proposedRewardAddress,bool extendedManagerPermissions,bool isActive))"
]
```

```json
[
  "function getBondSummary(uint256 nodeOperatorId) view returns (uint256 current, uint256 required)"
]
```

## 9. Ethers.js Encoding Example

```ts
import { ethers } from "ethers";

const STAKE_BOND = 5;

const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes", "bytes"],
  [pubkeyBytes, signatureBytes]
);

const params = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "uint256", "bytes"],
  [wethAddress, bondAmountWei, validatorData]
);

await vault.approveToken(wethAddress, stakingModuleAddress, bondAmountWei);
await vault.executeModuleAction(STAKE_BOND, params);
```

Reference implementation:
- [deploy-staking-stack.mjs](/C:/Work/DexpoV2/scripts/testnet/hoodi-testnet/deploy-staking-stack.mjs#L285)

## 10. What To Verify After Broadcast

Read from adapter:
- `vaultNodeOperatorId(vault)`
- `vaultBondedEth(vault)`

Read from CSM:
- `getNodeOperator(noId)`
- `getBondSummary(noId)`

Healthy first-stage result on Hoodi:
- `totalAddedKeys = 1`
- `totalVettedKeys = 1`
- `depositableValidatorsCount = 1`
- `totalDepositedKeys = 0`

This means:
- Lido accepted the key
- the key is waiting for the deposit bot
- the validator is not yet deposited on beacon chain

Later, after Lido processes it:
- `totalDepositedKeys` should become `1`
- `depositableValidatorsCount` usually drops back to `0`

## 11. Important Current Limitation

The current adapter handles the first validator registration path well:
- create node operator
- upload first key
- post first bond

But for an already-registered vault node operator, the adapter currently only tops up bond:
- it does not call `addValidatorKeysETH(...)` for additional keys

So this API flow currently supports:
- first validator for a vault

It does not yet fully support:
- adding second, third, or later validator keys to the same node operator through the same automated staking action

That would need an adapter extension.

## 12. Operational Notes

- The backend signer must be the `ProtocolCore.owner()` wallet if it wants to act as `protocolOwner`
- The validator key material must come from Tennova or your validator provisioning system
- The backend should persist the resulting `nodeOperatorId`
- The backend should poll CSM until `totalDepositedKeys` moves from `0` to `1`
- Reward claiming is a separate flow and should be documented separately

## 13. Recommended API Shape

Suggested backend endpoint:

```http
POST /staking/hoodi/vaults/:vaultAddress/bond-first-validator
```

Suggested request payload:

```json
{
  "bondAmountWei": "2400000000000000000",
  "wrappedToken": "0xef7E35164ec2648BAE01D332f18a2a0FA103124c",
  "validatorPubkey": "0x...",
  "validatorSignature": "0x..."
}
```

Suggested backend actions:
1. validate signer is protocol owner
2. validate pubkey and signature lengths
3. validate vault WETH balance
4. fetch staking module from module registry
5. call `approveToken(...)`
6. call `executeModuleAction(STAKE_BOND, params)`
7. read back `nodeOperatorId`
8. return `nodeOperatorId`, tx hashes, and current CSM status

## 14. Reference Files

- [IndexSwapV3.sol](/C:/Work/DexpoV2/contracts/v3/mainnet/vault/IndexSwapV3.sol)
- [LidoCSMAdapter.sol](/C:/Work/DexpoV2/contracts/v3/modules/LidoCSMAdapter.sol)
- [IStakingModule.sol](/C:/Work/DexpoV2/contracts/v3/interfaces/IStakingModule.sol)
- [ProtocolCore.sol](/C:/Work/DexpoV2/contracts/ProtocolCore.sol)
- [deploy-staking-stack.mjs](/C:/Work/DexpoV2/scripts/testnet/hoodi-testnet/deploy-staking-stack.mjs)
- [hoodi-testnet.json](/C:/Work/DexpoV2/deployments/testnet/hoodi-testnet.json)
