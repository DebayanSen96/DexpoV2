import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("PROFIT HARVEST & FEE DISTRIBUTION TEST");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const vaultAddress = state.lendingVault.indexSwap;
  const feeCollectorAddress = state.feeCollector;

  console.log("\n📦 Contracts:");
  console.log("  Vault:", vaultAddress);
  console.log("  FeeCollector:", feeCollectorAddress);
  console.log("  Deployer:", deployer.address);

  const vault = await ethers.getContractAt("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3", vaultAddress);
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);

  console.log("\n" + "=".repeat(70));
  console.log("VAULT CONFIGURATION");
  console.log("=".repeat(70));

  const performanceFeeBps = await vault.performanceFeeBps();
  const vaultOwner = await vault.vaultOwner();
  const feeCollector = await vault.feeCollector();
  const highWaterMark = await vault.highWaterMarkUsd();
  const currentTvl = await vault.getTotalValueUsd();

  console.log("Performance Fee:", Number(performanceFeeBps) / 100, "%");
  console.log("Vault Owner:", vaultOwner);
  console.log("Fee Collector:", feeCollector);
  console.log("High Water Mark:", ethers.formatEther(highWaterMark), "USD");
  console.log("Current TVL:", ethers.formatEther(currentTvl), "USD");

  const profitUsd = currentTvl > highWaterMark ? currentTvl - highWaterMark : 0n;
  console.log("\n📈 Unrealized Profit:", ethers.formatEther(profitUsd), "USD");

  if (profitUsd === 0n) {
    console.log("\n⚠️ No profit above high water mark to harvest.");
    console.log("   High water mark may have been set after the lending profit was realized.");
    console.log("   The profit from lending (0.000097 USDC) is already in the vault balance.");
    return;
  }

  console.log("\n" + "=".repeat(70));
  console.log("BALANCES BEFORE HARVEST");
  console.log("=".repeat(70));

  const vaultUsdcBefore = await usdc.balanceOf(vaultAddress);
  const deployerUsdcBefore = await usdc.balanceOf(deployer.address);
  const feeCollectorUsdcBefore = await usdc.balanceOf(feeCollectorAddress);

  console.log("Vault USDC:", ethers.formatUnits(vaultUsdcBefore, 6));
  console.log("Deployer USDC:", ethers.formatUnits(deployerUsdcBefore, 6));
  console.log("FeeCollector USDC:", ethers.formatUnits(feeCollectorUsdcBefore, 6));

  console.log("\n" + "=".repeat(70));
  console.log("HARVESTING PROFIT");
  console.log("=".repeat(70));

  console.log("Calling harvestProfitUsd(USDC)...");
  const tx = await vault.harvestProfitUsd(BASE_MAINNET.USDC);
  console.log("Tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ Harvest confirmed! Gas:", receipt?.gasUsed.toString());

  console.log("\n" + "=".repeat(70));
  console.log("BALANCES AFTER HARVEST");
  console.log("=".repeat(70));

  const vaultUsdcAfter = await usdc.balanceOf(vaultAddress);
  const deployerUsdcAfter = await usdc.balanceOf(deployer.address);
  const feeCollectorUsdcAfter = await usdc.balanceOf(feeCollectorAddress);
  const newHighWaterMark = await vault.highWaterMarkUsd();

  console.log("Vault USDC:", ethers.formatUnits(vaultUsdcAfter, 6));
  console.log("Deployer USDC:", ethers.formatUnits(deployerUsdcAfter, 6));
  console.log("FeeCollector USDC:", ethers.formatUnits(feeCollectorUsdcAfter, 6));
  console.log("New High Water Mark:", ethers.formatEther(newHighWaterMark), "USD");

  console.log("\n" + "=".repeat(70));
  console.log("FEE DISTRIBUTION SUMMARY");
  console.log("=".repeat(70));

  const vaultUsdcChange = BigInt(vaultUsdcAfter) - BigInt(vaultUsdcBefore);
  const deployerUsdcChange = BigInt(deployerUsdcAfter) - BigInt(deployerUsdcBefore);

  console.log("Vault USDC change:", ethers.formatUnits(vaultUsdcChange, 6));
  console.log("Deployer USDC change:", ethers.formatUnits(deployerUsdcChange, 6));
  console.log("\nNote: Since you are both vault owner and protocol owner,");
  console.log("      all fees flow back to your wallet.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
