# Correct Withdrawl Flow

This folder contains the working flow for claiming Lido CSM rewards on Hoodi with a Merkle proof.

## What this solves

There are two separate steps in the CSM rewards flow:

1. `pullFeeRewards(...)`
   This realizes rewards into the node operator bond inside `CSAccounting`.
   This is why you may see bond move from `2.4` to `2.40007...`.

2. `claimRewardsStETH(...)`
   This is the actual payout step.
   This sends `stETH` to the node operator `rewardAddress`.

If you only do step 1, rewards are not withdrawn to your wallet. They stay reflected in bond accounting.

## Script

Use [claim-csm-rewards.mjs](C:\Work\DexpoV2\scripts\csm\correct-withdrawl-flow\claim-csm-rewards.mjs).

## Commands

Dry run for a node operator:

```bash
node scripts/csm/correct-withdrawl-flow/claim-csm-rewards.mjs --no-id 410
```

Actually send the claim:

```bash
node scripts/csm/correct-withdrawl-flow/claim-csm-rewards.mjs --no-id 410 --send
```

Only realize rewards into bond, without payout:

```bash
node scripts/csm/correct-withdrawl-flow/claim-csm-rewards.mjs --no-id 410 --pull-only --send
```

If the reward address is zero and your wallet is the manager, set reward address to your wallet first:

```bash
node scripts/csm/correct-withdrawl-flow/claim-csm-rewards.mjs --no-id 410 --set-reward-address --send
```

## What the script does

1. Fetches the latest Hoodi rewards tree from Lido.
2. Finds the entry for the given node operator id.
3. Builds and verifies the Merkle proof locally.
4. Checks manager and reward permissions.
5. Calls `CSAccounting.getClaimableRewardsAndBondShares(...)`.
6. Calls `CSAccounting.claimRewardsStETH(...)` for the actual payout.

## Important result from our testing

`410` worked.

- Direct reward payout succeeded.
- Reward recipient wallet: `0xF9D676bec8210Ba4F5c080Fabd13ADD8c9d407F7`
- Received asset: `stETH`
- Received amount: about `0.003269853043250102 stETH`

`411` did not directly payout through this wallet.

- Manager is the vault: `0x53dd05bF4F393bFef9a095974b0A627FaeBE81f2`
- Reward address is also vault-controlled in that setup
- So this wallet cannot directly call the payout step for `411`

## Vault adapter bug and fix

The original vault-side design bug was:

- the node operator was being created with `managerAddress = vault`
- the node operator was being created with `rewardAddress = vault`
- but the actual claim call was being made by `LidoCSMAdapter`

That means the caller reaching `CSAccounting.claimRewardsStETH(...)` was the adapter, not the vault, so the claim permission model did not line up.

The contract-side fix in this repo now does the following for new vault-created node operators:

- creates the node operator with the adapter as the CSM manager
- creates the node operator with the adapter as the CSM reward address
- lets the vault pass Merkle proof data into `executeModuleAction(STAKE_CLAIM, params)`
- makes the adapter call `CSAccounting.claimRewardsStETH(...)`
- transfers claimed `stETH` from adapter back into the vault

Important: this fixes the design for new deployments or upgraded vault staking deployments. It does not magically change the already-created Hoodi node operator `411`, because its on-chain role addresses were already set when it was registered.

`408` was not present in the current rewards tree when checked.

## Why older attempts failed

The main confusion point is that a node operator can show more than `2.4 ETH` bonded, but that does not automatically mean payout was claimed to a wallet.

The real payout call is:

```text
CSAccounting.claimRewardsStETH(nodeOperatorId, stETHAmount, cumulativeFeeShares, rewardsProof)
```

If you call the wrong contract or only do `pullFeeRewards`, you only realize rewards into accounting and bond state.

## Notes

- This flow pays out `stETH`, not native ETH.
- If you want ETH after claim, you need an extra unwrap / swap step after receiving `stETH`.
- This script is written around Hoodi addresses and your current test wallet.
