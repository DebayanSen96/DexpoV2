import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
};

async function main() {
  const [signer] = await ethers.getSigners();
  
  console.log("\n" + "=".repeat(70));
  console.log("IRL TEST - BASE MAINNET");
  console.log("=".repeat(70));
  
  console.log("\n📋 Signer Info:");
  console.log("  Address:", signer.address);
  console.log("  ETH Balance:", ethers.formatEther(await ethers.provider.getBalance(signer.address)));
  
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const usdcBalance = await usdc.balanceOf(signer.address);
  console.log("  USDC Balance:", ethers.formatUnits(usdcBalance, 6));
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  console.log("\n📦 Deployed Contracts:");
  console.log("  IndexSwapV3:", state.testVault.indexSwap);
  console.log("  FeeCollector:", state.feeCollector);
  console.log("  ChainlinkOracle:", state.chainlinkOracle);
  
  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap,
    signer
  );
  
  const oracle = await ethers.getContractAt(
    "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    state.chainlinkOracle,
    signer
  );
  
  console.log("\n--- Current Prices ---");
  const ethPrice = await oracle.priceUsdE18(BASE_MAINNET.WETH);
  console.log("  ETH/USD:", ethers.formatEther(ethPrice));
  
  console.log("\n--- Vault State Before ---");
  const tvlBefore = await vault.getTotalValueUsd();
  console.log("  TVL:", ethers.formatEther(tvlBefore), "USD");
  const hwmBefore = await vault.highWaterMarkUsd();
  console.log("  High Water Mark:", ethers.formatEther(hwmBefore), "USD");
  const totalDepositsBefore = await vault.totalDepositsUsd();
  console.log("  Total Deposits:", ethers.formatEther(totalDepositsBefore), "USD");
  
  const vaultUsdcBefore = await usdc.balanceOf(state.testVault.indexSwap);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdcBefore, 6));
  
  const weth = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.WETH);
  const vaultWethBefore = await weth.balanceOf(state.testVault.indexSwap);
  console.log("  Vault WETH:", ethers.formatEther(vaultWethBefore));
  
  const testAmount = ethers.parseUnits("1", 6);
  
  if (usdcBalance < testAmount) {
    console.log("\n❌ Insufficient USDC balance for test. Need at least 1 USDC.");
    return;
  }
  
  console.log("\n" + "=".repeat(70));
  console.log("STEP 1: Deposit 1 USDC to Vault");
  console.log("=".repeat(70));
  
  console.log("  Approving USDC...");
  const approveTx = await usdc.approve(state.testVault.indexSwap, testAmount);
  await approveTx.wait();
  console.log("  ✅ Approved");
  
  console.log("  Depositing 1 USDC...");
  const depositTx = await vault.depositSingle(BASE_MAINNET.USDC, testAmount);
  await depositTx.wait();
  console.log("  ✅ Deposited");
  
  const sharesAfterDeposit = await vault.balanceOf(signer.address);
  console.log("  Shares received:", ethers.formatEther(sharesAfterDeposit));
  
  const tvlAfterDeposit = await vault.getTotalValueUsd();
  console.log("  TVL after deposit:", ethers.formatEther(tvlAfterDeposit), "USD");
  
  const hwmAfterDeposit = await vault.highWaterMarkUsd();
  console.log("  High Water Mark:", ethers.formatEther(hwmAfterDeposit), "USD");
  
  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: Swap 0.5 USDC to WETH (Vault Owner Action)");
  console.log("=".repeat(70));
  
  const swapAmount = ethers.parseUnits("0.5", 6);
  console.log("  Swapping 0.5 USDC to WETH...");
  
  try {
    const buyTx = await vault.buyToken(BASE_MAINNET.USDC, BASE_MAINNET.WETH, swapAmount);
    const receipt = await buyTx.wait();
    console.log("  ✅ Swap successful! Gas used:", receipt?.gasUsed.toString());
    
    const vaultUsdcAfterSwap = await usdc.balanceOf(state.testVault.indexSwap);
    console.log("  Vault USDC after swap:", ethers.formatUnits(vaultUsdcAfterSwap, 6));
    
    const vaultWethAfterSwap = await weth.balanceOf(state.testVault.indexSwap);
    console.log("  Vault WETH after swap:", ethers.formatEther(vaultWethAfterSwap));
    
    const tvlAfterSwap = await vault.getTotalValueUsd();
    console.log("  TVL after swap:", ethers.formatEther(tvlAfterSwap), "USD");
    
    console.log("\n" + "=".repeat(70));
    console.log("STEP 3: Check Profit Tracking");
    console.log("=".repeat(70));
    
    const profitUsd = await vault.getProfitUsd();
    console.log("  Current Profit (USD):", ethers.formatEther(profitUsd));
    
    const hwmNow = await vault.highWaterMarkUsd();
    console.log("  High Water Mark:", ethers.formatEther(hwmNow), "USD");
    console.log("  Current TVL:", ethers.formatEther(tvlAfterSwap), "USD");
    
    if (tvlAfterSwap > hwmNow) {
      console.log("  📈 TVL > HWM = Profit exists!");
    } else {
      console.log("  📉 TVL <= HWM = No profit yet (swap fees may have caused slight loss)");
    }
    
    console.log("\n" + "=".repeat(70));
    console.log("SUMMARY");
    console.log("=".repeat(70));
    console.log("\n✅ Test completed successfully!");
    console.log("\nWhat happened:");
    console.log("  1. Deposited 1 USDC to vault");
    console.log("  2. Swapped 0.5 USDC to WETH via Uniswap V3");
    console.log("  3. Vault now holds USDC + WETH");
    console.log("\nProfit tracking:");
    console.log("  - High Water Mark set at deposit time");
    console.log("  - If ETH price goes up, TVL increases");
    console.log("  - Profit = TVL - High Water Mark");
    console.log("  - When harvestProfitUsd() is called, fees are distributed");
    console.log("\nTo test fee distribution later:");
    console.log("  - Wait for ETH price to increase");
    console.log("  - Call vault.harvestProfitUsd(USDC_ADDRESS)");
    console.log("  - This will distribute 10% of profit to vault owner");
    console.log("  - Protocol takes 10% of vault owner's fee");
    
  } catch (error: any) {
    console.log("  ❌ Swap failed:", error.message?.split('\n')[0]);
    console.log("\nPossible reasons:");
    console.log("  - Insufficient liquidity in pool");
    console.log("  - Pool fee mismatch");
    console.log("  - Slippage too high");
  }
  
  console.log("\n" + "=".repeat(70) + "\n");
}

main().catch(console.error);
