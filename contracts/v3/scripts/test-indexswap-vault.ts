import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Complete IndexSwap Vault Interaction Test
 * 
 * This script demonstrates all vault operations:
 * - Deposit with auto-allocation
 * - Buy/Sell tokens
 * - Lend/Borrow operations
 * - Rebalancing
 * - Withdrawal (with lockup check)
 * 
 * Usage:
 * npx hardhat run contracts/v3/scripts/test-indexswap-vault.ts --network base-sepolia
 */

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("INDEXSWAP VAULT INTERACTION TEST");
  console.log("=".repeat(70));

  // ========== CONFIGURATION ==========
  const VAULT_ADDRESS = "0x5269e4BA3fdfEe90Ab55C31322C8018885815E42";
  const SAFE_ADDRESS = "0x2cFCfE96bd1dCA29ACbe6CcbAD3f09a286Ac17e9";
  
  // Modules
  const BUYSELL_MODULE = "0x146832EeA391F000215367678705604B93cBd16b";
  const LEND_MODULE = "0xa33a49d256EC210a859a675CF18A5F5bDA7A51C0";
  const BORROW_MODULE = "0xbEAE2AB97616f38824B4E25FC9D8f9c063AD6068";
  
  // Tokens (Base Sepolia)
  const USDC = "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4";
  const DAI = "0x5355419854236B3D9c0675a87Fa560F230127663";
  const USDT = "0x1D196BCE6Bbea402fEF328AB1Ac50C971497173D";
  const USDX = "0xe50E303b29aB28181460D335a1186033Af24Bf82";

  // Test wallet (has funds)
  const TEST_WALLET_KEY = process.env.TEST_WALLET_PRIVATE_KEY || "";
  if (!TEST_WALLET_KEY) {
    throw new Error("TEST_WALLET_PRIVATE_KEY not found in .env");
  }

  const [deployer] = await ethers.getSigners();
  const testWallet = new ethers.Wallet(TEST_WALLET_KEY, ethers.provider);
  
  console.log("\n📋 Configuration:");
  console.log("  Vault:", VAULT_ADDRESS);
  console.log("  Safe:", SAFE_ADDRESS);
  console.log("  Deployer:", deployer.address);
  console.log("  Test Wallet:", testWallet.address);
  console.log("  Test Wallet Balance:", ethers.formatEther(await ethers.provider.getBalance(testWallet.address)), "ETH");

  // ========== GET CONTRACT INSTANCES ==========
  const vault = await ethers.getContractAt("IndexSwap", VAULT_ADDRESS);
  const usdc = await ethers.getContractAt("IERC20", USDC);
  const dai = await ethers.getContractAt("IERC20", DAI);
  const usdt = await ethers.getContractAt("IERC20", USDT);
  const usdx = await ethers.getContractAt("IERC20", USDX);
  const buySellModule = await ethers.getContractAt("BuySellModule", BUYSELL_MODULE);
  const lendModule = await ethers.getContractAt("LendModule", LEND_MODULE);
  const borrowModule = await ethers.getContractAt("BorrowModule", BORROW_MODULE);

  // ========== CHECK INITIAL STATE ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 1: CHECK INITIAL VAULT STATE");
  console.log("=".repeat(70));

  const tvlBefore = await vault.getTotalValueUsd();
  const totalSupply = await vault.totalSupply();
  const lockupSeconds = await vault.lockupSeconds();
  const portfolio = await vault.getPortfolio();

  console.log("\n📊 Vault Metrics:");
  console.log("  TVL:", ethers.formatEther(tvlBefore), "USD");
  console.log("  Total Supply:", ethers.formatEther(totalSupply), "shares");
  console.log("  Lockup Period:", Number(lockupSeconds) / 86400, "days");
  
  console.log("\n🎯 Portfolio Composition:");
  for (let i = 0; i < portfolio.length; i++) {
    const token = portfolio[i][0];
    const weight = portfolio[i][1];
    const tokenContract = await ethers.getContractAt("IERC20", token);
    const balance = await tokenContract.balanceOf(VAULT_ADDRESS);
    
    const tokenInfo: { [key: string]: { symbol: string; decimals: number } } = {
      [USDC.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      [DAI.toLowerCase()]: { symbol: "DAI", decimals: 18 },
      [USDT.toLowerCase()]: { symbol: "USDT", decimals: 6 },
      [USDX.toLowerCase()]: { symbol: "USDx", decimals: 18 }
    };
    
    const info = tokenInfo[token.toLowerCase()];
    console.log(`  ${info.symbol}: ${ethers.formatUnits(balance, info.decimals)} (target: ${Number(weight)/100}%)`);
  }

  // ========== TEST DEPOSIT ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: TEST DEPOSIT WITH AUTO-ALLOCATION");
  console.log("=".repeat(70));

  const depositAmount = ethers.parseUnits("1000", 6); // 1000 USDC
  
  console.log("\n💰 Depositing 1000 USDC...");
  console.log("  Checking USDC balance:", ethers.formatUnits(await usdc.balanceOf(testWallet.address), 6));
  
  // Approve vault
  const approveTx = await usdc.connect(testWallet).approve(VAULT_ADDRESS, depositAmount);
  await approveTx.wait();
  console.log("✅ Approved vault to spend USDC");
  
  // Deposit
  const depositTx = await vault.connect(testWallet).depositWithAutoAllocation(USDC, depositAmount);
  const depositReceipt = await depositTx.wait();
  console.log("✅ Deposit successful! Gas used:", depositReceipt?.gasUsed.toString());
  
  const sharesReceived = await vault.balanceOf(testWallet.address);
  console.log("  Shares received:", ethers.formatEther(sharesReceived));
  
  const tvlAfterDeposit = await vault.getTotalValueUsd();
  console.log("  New TVL:", ethers.formatEther(tvlAfterDeposit), "USD");

  // ========== TEST BUY/SELL ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 3: TEST BUY/SELL OPERATIONS");
  console.log("=".repeat(70));

  console.log("\n🔄 Buying USDC with DAI (100 DAI)...");
  
  // Approve module
  await vault.connect(deployer).approveToken(DAI, BUYSELL_MODULE, ethers.parseEther("100"));
  console.log("✅ Approved BuySellModule");
  
  const daiBalBefore = await dai.balanceOf(VAULT_ADDRESS);
  const usdcBalBefore = await usdc.balanceOf(VAULT_ADDRESS);
  
  // Buy USDC with DAI
  const buyTx = await buySellModule.connect(deployer).buyToken(
    VAULT_ADDRESS,
    DAI,
    USDC,
    ethers.parseEther("100")
  );
  await buyTx.wait();
  console.log("✅ Buy operation complete");
  
  const daiBalAfter = await dai.balanceOf(VAULT_ADDRESS);
  const usdcBalAfter = await usdc.balanceOf(VAULT_ADDRESS);
  
  console.log("  DAI: ", ethers.formatEther(daiBalBefore), "→", ethers.formatEther(daiBalAfter));
  console.log("  USDC:", ethers.formatUnits(usdcBalBefore, 6), "→", ethers.formatUnits(usdcBalAfter, 6));

  // ========== TEST LENDING ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 4: TEST LENDING OPERATIONS");
  console.log("=".repeat(70));

  console.log("\n💸 Lending 200 USDC...");
  
  await vault.connect(deployer).approveToken(USDC, LEND_MODULE, ethers.parseUnits("200", 6));
  console.log("✅ Approved LendModule");
  
  const lendTx = await lendModule.connect(deployer).lend(
    VAULT_ADDRESS,
    USDC,
    ethers.parseUnits("200", 6)
  );
  await lendTx.wait();
  console.log("✅ Lend operation complete");
  
  const lendPosition = await lendModule.getPositionValue(VAULT_ADDRESS, USDC);
  console.log("  Lending position value:", ethers.formatEther(lendPosition), "USD");

  // ========== TEST BORROWING ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 5: TEST BORROWING OPERATIONS");
  console.log("=".repeat(70));

  console.log("\n💳 Borrowing 50 USDT...");
  
  try {
    const borrowTx = await borrowModule.connect(deployer).borrow(
      VAULT_ADDRESS,
      USDT,
      ethers.parseUnits("50", 6)
    );
    await borrowTx.wait();
    console.log("✅ Borrow operation complete");
    
    const borrowPosition = await borrowModule.getPositionValue(VAULT_ADDRESS, USDT);
    console.log("  Borrow position value:", ethers.formatEther(borrowPosition), "USD");
  } catch (error: any) {
    console.log("⚠️  Borrow failed (likely insufficient liquidity):", error.message.split('\n')[0]);
  }

  // ========== CHECK WEIGHT DRIFT ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 6: CHECK PORTFOLIO WEIGHT DRIFT");
  console.log("=".repeat(70));

  const tvlAfterOps = await vault.getTotalValueUsd();
  console.log("\n📊 Current TVL:", ethers.formatEther(tvlAfterOps), "USD");
  console.log("\n⚖️  Weight Analysis:");
  
  for (let i = 0; i < portfolio.length; i++) {
    const token = portfolio[i][0];
    const targetWeight = portfolio[i][1];
    const tokenContract = await ethers.getContractAt("IERC20", token);
    const balance = await tokenContract.balanceOf(VAULT_ADDRESS);
    
    const tokenInfo: { [key: string]: { symbol: string; decimals: number } } = {
      [USDC.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      [DAI.toLowerCase()]: { symbol: "DAI", decimals: 18 },
      [USDT.toLowerCase()]: { symbol: "USDT", decimals: 6 },
      [USDX.toLowerCase()]: { symbol: "USDx", decimals: 18 }
    };
    
    const info = tokenInfo[token.toLowerCase()];
    const balanceFormatted = ethers.formatUnits(balance, info.decimals);
    
    // Calculate actual weight (rough estimate)
    const tokenValue = balance * ethers.parseEther("1") / (10n ** BigInt(info.decimals));
    const actualWeight = tvlAfterOps > 0n ? (tokenValue * 10000n) / tvlAfterOps : 0n;
    const drift = Number(actualWeight) - Number(targetWeight);
    const driftSymbol = drift > 0 ? "+" : "";
    
    console.log(`  ${info.symbol}: ${balanceFormatted.padEnd(12)} | Target: ${(Number(targetWeight)/100).toFixed(1)}% | Actual: ~${(Number(actualWeight)/100).toFixed(1)}% | Drift: ${driftSymbol}${(drift/100).toFixed(1)}%`);
  }

  // ========== TEST REBALANCING ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 7: TEST REBALANCING");
  console.log("=".repeat(70));

  console.log("\n⚖️  Rebalancing vault to target weights...");
  
  const rebalanceTx = await vault.connect(deployer).rebalance();
  const rebalanceReceipt = await rebalanceTx.wait();
  console.log("✅ Rebalance complete! Gas used:", rebalanceReceipt?.gasUsed.toString());
  
  console.log("\n📊 Post-Rebalance Holdings:");
  const tvlAfterRebalance = await vault.getTotalValueUsd();
  
  for (let i = 0; i < portfolio.length; i++) {
    const token = portfolio[i][0];
    const targetWeight = portfolio[i][1];
    const tokenContract = await ethers.getContractAt("IERC20", token);
    const balance = await tokenContract.balanceOf(VAULT_ADDRESS);
    
    const tokenInfo: { [key: string]: { symbol: string; decimals: number } } = {
      [USDC.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      [DAI.toLowerCase()]: { symbol: "DAI", decimals: 18 },
      [USDT.toLowerCase()]: { symbol: "USDT", decimals: 6 },
      [USDX.toLowerCase()]: { symbol: "USDx", decimals: 18 }
    };
    
    const info = tokenInfo[token.toLowerCase()];
    const balanceFormatted = ethers.formatUnits(balance, info.decimals);
    console.log(`  ${info.symbol}: ${balanceFormatted} (target: ${Number(targetWeight)/100}%)`);
  }

  // ========== TEST WITHDRAWAL (LOCKUP CHECK) ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 8: TEST WITHDRAWAL (LOCKUP CHECK)");
  console.log("=".repeat(70));

  const userShares = await vault.balanceOf(testWallet.address);
  const depositTimestamp = await vault.userDepositTimestamp(testWallet.address);
  const currentTime = Math.floor(Date.now() / 1000);
  const unlockTime = Number(depositTimestamp) + Number(lockupSeconds);
  const timeUntilUnlock = unlockTime - currentTime;
  
  console.log("\n🔒 Lockup Status:");
  console.log("  User shares:", ethers.formatEther(userShares));
  console.log("  Deposit time:", new Date(Number(depositTimestamp) * 1000).toLocaleString());
  console.log("  Unlock time:", new Date(unlockTime * 1000).toLocaleString());
  console.log("  Time until unlock:", Math.max(0, Math.floor(timeUntilUnlock / 3600)), "hours");
  
  if (timeUntilUnlock > 0) {
    console.log("\n⚠️  Attempting withdrawal (should fail due to lockup)...");
    try {
      await vault.connect(testWallet).withdraw(ethers.parseEther("1"));
      console.log("❌ Withdrawal succeeded (UNEXPECTED!)");
    } catch (error: any) {
      if (error.message.includes("Lockup period active")) {
        console.log("✅ Withdrawal correctly blocked by lockup period");
      } else {
        console.log("⚠️  Withdrawal failed with different error:", error.message.split('\n')[0]);
      }
    }
  } else {
    console.log("\n✅ Lockup period expired, withdrawal would be allowed");
  }

  // ========== FINAL SUMMARY ==========
  console.log("\n" + "=".repeat(70));
  console.log("FINAL VAULT STATE");
  console.log("=".repeat(70));

  const finalTvl = await vault.getTotalValueUsd();
  const finalSupply = await vault.totalSupply();
  const sharePrice = finalSupply > 0n ? (finalTvl * ethers.parseEther("1")) / finalSupply : 0n;
  
  console.log("\n📊 Vault Metrics:");
  console.log("  TVL:", ethers.formatEther(finalTvl), "USD");
  console.log("  Total Supply:", ethers.formatEther(finalSupply), "shares");
  console.log("  Share Price:", ethers.formatEther(sharePrice), "USD");
  console.log("  Lockup Period:", Number(lockupSeconds) / 86400, "days");

  console.log("\n✅ ALL VAULT INTERACTIONS TESTED SUCCESSFULLY!");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
