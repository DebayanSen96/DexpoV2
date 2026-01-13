import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
};

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("MAINNET VAULT TEST - Small Amount Swaps");
  console.log("=".repeat(70));

  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  if (!fs.existsSync(deploymentPath)) {
    console.log("❌ No deployment found. Run deployV3-mainnet.ts first.");
    return;
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const [signer] = await ethers.getSigners();

  console.log("\n📋 Test Info:");
  console.log("  Signer:", signer.address);
  console.log("  Balance:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
  console.log("  Vault:", deployment.testVault?.indexSwap);

  if (!deployment.testVault?.indexSwap) {
    console.log("❌ No test vault found in deployment.");
    return;
  }

  const vault = await ethers.getContractAt("IndexSwapV3", deployment.testVault.indexSwap);
  const usdc = await ethers.getContractAt("IERC20", BASE_MAINNET.USDC);

  const usdcBalance = await usdc.balanceOf(signer.address);
  console.log("  USDC Balance:", ethers.formatUnits(usdcBalance, 6));

  if (usdcBalance === 0n) {
    console.log("\n⚠️  You need USDC to test. Get some from:");
    console.log("  - Bridge from another chain");
    console.log("  - Buy on Coinbase and send to Base");
    return;
  }

  const TEST_AMOUNT = ethers.parseUnits("0.1", 6);
  
  if (usdcBalance < TEST_AMOUNT) {
    console.log("\n⚠️  Need at least 0.1 USDC for test");
    return;
  }

  console.log("\n" + "=".repeat(70));
  console.log("TEST 1: Deposit 0.1 USDC");
  console.log("=".repeat(70));

  const currentAllowance = await usdc.allowance(signer.address, deployment.testVault.indexSwap);
  if (currentAllowance < TEST_AMOUNT) {
    console.log("  Approving USDC...");
    const approveTx = await usdc.approve(deployment.testVault.indexSwap, TEST_AMOUNT);
    await approveTx.wait();
    console.log("  ✅ Approved");
  }

  console.log("  Depositing...");
  const depositTx = await vault.depositSingle(BASE_MAINNET.USDC, TEST_AMOUNT);
  const depositReceipt = await depositTx.wait();
  console.log("  ✅ Deposit successful!");
  console.log("  Gas used:", depositReceipt?.gasUsed.toString());

  const shares = await vault.balanceOf(signer.address);
  console.log("  Shares received:", ethers.formatEther(shares));

  console.log("\n" + "=".repeat(70));
  console.log("TEST 2: Check Vault State");
  console.log("=".repeat(70));

  const tvl = await vault.getTotalValueUsd();
  const sharePrice = await vault.getSharePrice();
  const portfolio = await vault.getPortfolio();

  console.log("  TVL:", ethers.formatEther(tvl), "USD");
  console.log("  Share Price:", ethers.formatEther(sharePrice), "USD");
  console.log("  Portfolio tokens:", portfolio.length);

  for (const p of portfolio) {
    const token = await ethers.getContractAt("IERC20", p.token);
    const balance = await token.balanceOf(deployment.testVault.indexSwap);
    const symbol = p.token === BASE_MAINNET.USDC ? "USDC" : 
                   p.token === BASE_MAINNET.WETH ? "WETH" : 
                   p.token === BASE_MAINNET.WBTC ? "WBTC" : "???";
    const decimals = p.token === BASE_MAINNET.USDC ? 6 : 
                     p.token === BASE_MAINNET.WBTC ? 8 : 18;
    console.log(`    ${symbol}: ${ethers.formatUnits(balance, decimals)} (target: ${Number(p.weightBps)/100}%)`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("TEST 3: Buy WETH with USDC (via vault.buyToken)");
  console.log("=".repeat(70));

  const vaultUsdcBalance = await usdc.balanceOf(deployment.testVault.indexSwap);
  const buyAmount = vaultUsdcBalance / 10n;
  
  if (buyAmount > 0n) {
    console.log("  Buying WETH with", ethers.formatUnits(buyAmount, 6), "USDC...");
    
    try {
      const buyTx = await vault.buyToken(BASE_MAINNET.USDC, BASE_MAINNET.WETH, buyAmount);
      const buyReceipt = await buyTx.wait();
      console.log("  ✅ Buy successful!");
      console.log("  Gas used:", buyReceipt?.gasUsed.toString());
      
      const weth = await ethers.getContractAt("IERC20", BASE_MAINNET.WETH);
      const wethBalance = await weth.balanceOf(deployment.testVault.indexSwap);
      console.log("  WETH in vault:", ethers.formatEther(wethBalance));
    } catch (error: any) {
      console.log("  ❌ Buy failed:", error.message?.split('\n')[0]);
      console.log("  This might be due to low liquidity or slippage. Try increasing maxSlippage.");
    }
  } else {
    console.log("  ⚠️  No USDC in vault to buy with");
  }

  console.log("\n" + "=".repeat(70));
  console.log("TEST 4: Check Final State");
  console.log("=".repeat(70));

  const finalTvl = await vault.getTotalValueUsd();
  const finalSharePrice = await vault.getSharePrice();

  console.log("  Final TVL:", ethers.formatEther(finalTvl), "USD");
  console.log("  Final Share Price:", ethers.formatEther(finalSharePrice), "USD");

  console.log("\n✅ ALL TESTS COMPLETE!");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
