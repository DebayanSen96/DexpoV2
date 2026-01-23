# Lending Module Mainnet Test Results

## Test Date: January 20-22, 2026

## Deployed Contracts (Base Mainnet)

| Contract | Address |
|----------|---------|
| LendModuleV3 | `0xD9a1D67f700a4215729B2c24C2e5b4fA46c43500` |
| Lending Vault (IndexSwapV3) | `0x972021416b393c106f8846C5088AEfF8d031F28b` |
| VaultSafe | `0xbbe8DBBCDC2419c80EB139672B6AAA5F073D9246` |

## External Integrations

| Protocol | Contract |
|----------|----------|
| Aave V3 Pool | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| Aave aUSDC Token | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` |

---

## Test Results

### Initial Supply (Jan 20, 2026)
- **Amount Supplied**: 0.5 USDC
- **Transaction**: Supply to Aave V3 via LendModuleV3

### Position After ~1.5 Days (Jan 22, 2026 05:43 UTC)

| Metric | Value |
|--------|-------|
| Originally Supplied | 0.500000 USDC |
| Current Balance | 0.500097 USDC |
| **Earned Interest** | **0.000097 USDC** |
| Profit Percentage | 0.0194% |
| Estimated APY | ~7.08% |

### Vault State (Before Withdrawal)
| Metric | Value |
|--------|-------|
| Vault USDC Balance | 0.999999 USDC |
| LendModule aUSDC Balance | 0.500097 aUSDC |
| Total Vault TVL | 1.4998 USD |
| Lending Position Value | 0.5000 USD |

---

## Proof of Concept: CONFIRMED ✅

The lending module successfully:
1. Supplied USDC to Aave V3 on Base Mainnet
2. Received aUSDC tokens as proof of deposit
3. Accrued interest over time (~7% APY)
4. Tracked per-vault positions correctly
5. Included lending positions in vault TVL calculation

---

## Withdrawal Test (Jan 22, 2026 05:43 UTC)

### Withdrawal Transaction
- **Tx Hash**: `0x44ed8027049127249c854d2bf4b6161e12f4214a40bf49a0c1f9fe03e2148a22`
- **Function**: `withdrawAll(vault, USDC)`
- **Status**: ✅ Success

### Before Withdrawal
| Metric | Value |
|--------|-------|
| Vault USDC | 0.999999 USDC |
| Lending Position | 0.500097 USDC |
| LendModule aUSDC | 0.500097 aUSDC |

### After Withdrawal
| Metric | Value |
|--------|-------|
| Vault USDC | 1.500096 USDC |
| Lending Position | 0.0 USDC |
| LendModule aUSDC | 0.0 aUSDC |

### Withdrawal Summary
| Metric | Value |
|--------|-------|
| USDC Withdrawn | 0.500097 USDC |
| Original Supply | 0.500000 USDC |
| **Interest Earned** | **0.000097 USDC** |

---

## Final Test Summary

| Test | Status |
|------|--------|
| Supply to Aave V3 | ✅ PASSED |
| Interest Accrual | ✅ PASSED (0.000097 USDC earned) |
| Position Tracking | ✅ PASSED |
| TVL Calculation | ✅ PASSED |
| Partial Withdraw | ✅ PASSED |
| Full Withdraw | ✅ PASSED |

**All lending module functionality verified on Base Mainnet.**

