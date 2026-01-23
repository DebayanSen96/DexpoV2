import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AAVE_AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
};

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("LENDING PROFIT CHECK - AFTER 1 DAY");
  console.log("=".repeat(70));
  console.log("Timestamp:", new Date().toISOString());

  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const vaultAddress = state.lendingVault.indexSwap;
  const lendModuleAddress = state.lendModuleV3;

  console.log("\n📦 Contracts:");
  console.log("  Vault:", vaultAddress);
  console.log("  LendModule:", lendModuleAddress);

  const lendModule = await ethers.getContractAt("contracts/v3/mainnet/modules/LendModuleV3.sol:LendModuleV3", lendModuleAddress);
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const aUsdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.AAVE_AUSDC);
  const vault = await ethers.getContractAt("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3", vaultAddress);

  console.log("\n" + "=".repeat(70));
  console.log("CURRENT BALANCES");
  console.log("=".repeat(70));

  const vaultUsdc = await usdc.balanceOf(vaultAddress);
  const moduleAUsdc = await aUsdc.balanceOf(lendModuleAddress);
  
  console.log("Vault USDC balance:", ethers.formatUnits(vaultUsdc, 6), "USDC");
  console.log("LendModule aUSDC balance:", ethers.formatUnits(moduleAUsdc, 6), "aUSDC");

  console.log("\n" + "=".repeat(70));
  console.log("LENDING POSITION DETAILS");
  console.log("=".repeat(70));

  const position = await lendModule.getPosition(vaultAddress, BASE_MAINNET.USDC);
  
  const suppliedAmount = position.suppliedAmount;
  const currentBalance = position.currentBalance;
  const earnedInterest = position.earnedInterest;
  const aTokenShares = position.aTokenShares;

  console.log("Originally Supplied:", ethers.formatUnits(suppliedAmount, 6), "USDC");
  console.log("Current Balance:", ethers.formatUnits(currentBalance, 6), "USDC");
  console.log("Earned Interest:", ethers.formatUnits(earnedInterest, 6), "USDC");
  console.log("aToken Shares:", aTokenShares.toString());

  const profitUsd = Number(ethers.formatUnits(earnedInterest, 6));
  const suppliedUsd = Number(ethers.formatUnits(suppliedAmount, 6));
  const profitPercentage = suppliedUsd > 0 ? (profitUsd / suppliedUsd) * 100 : 0;

  console.log("\n" + "=".repeat(70));
  console.log("PROFIT ANALYSIS");
  console.log("=".repeat(70));
  console.log("Profit (USDC):", profitUsd.toFixed(8), "USDC");
  console.log("Profit (%):", profitPercentage.toFixed(6), "%");
  
  if (profitUsd > 0) {
    console.log("\n✅ PROOF OF CONCEPT: Interest is accruing!");
    const annualizedRate = profitPercentage * 365;
    console.log("Estimated APY:", annualizedRate.toFixed(4), "%");
  } else {
    console.log("\n⚠️ No measurable interest yet (may need more time or larger position)");
  }

  console.log("\n" + "=".repeat(70));
  console.log("VAULT TVL");
  console.log("=".repeat(70));
  
  const tvl = await vault.getTotalValueUsd();
  console.log("Total Vault TVL:", ethers.formatEther(tvl), "USD");

  const positionValue = await lendModule.getPositionValue(vaultAddress, BASE_MAINNET.USDC);
  console.log("Lending Position Value:", ethers.formatEther(positionValue), "USD");

  return {
    suppliedAmount: ethers.formatUnits(suppliedAmount, 6),
    currentBalance: ethers.formatUnits(currentBalance, 6),
    earnedInterest: ethers.formatUnits(earnedInterest, 6),
    profitPercentage: profitPercentage.toFixed(6),
    vaultUsdc: ethers.formatUnits(vaultUsdc, 6),
    tvl: ethers.formatEther(tvl),
  };
}

main()
  .then((result) => {
    console.log("\n📊 Results object:", JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
