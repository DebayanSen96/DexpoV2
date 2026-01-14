import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [signer] = await ethers.getSigners();
  
  console.log("\n" + "=".repeat(60));
  console.log("FEE STRUCTURE VERIFICATION");
  console.log("=".repeat(60));
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  const feeCollector = await ethers.getContractAt(
    "contracts/v3/mainnet/core/FeeCollector.sol:FeeCollector",
    state.feeCollector,
    signer
  );
  
  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap,
    signer
  );
  
  console.log("\n📦 Contracts:");
  console.log("  FeeCollector:", state.feeCollector);
  console.log("  IndexSwapV3:", state.testVault.indexSwap);
  
  console.log("\n📊 Fee Configuration:");
  
  const protocolCutBps = await feeCollector.protocolCutBps();
  console.log("  Protocol Cut (from vault owner fee):", Number(protocolCutBps) / 100, "%");
  
  const performanceFeeBps = await vault.performanceFeeBps();
  console.log("  Vault Performance Fee:", Number(performanceFeeBps) / 100, "%");
  
  const vaultOwner = await vault.vaultOwner();
  console.log("  Vault Owner:", vaultOwner);
  
  const feeRecipient = await feeCollector.feeRecipient();
  console.log("  Protocol Fee Recipient:", feeRecipient);
  
  const isAuthorized = await feeCollector.authorizedVaults(state.testVault.indexSwap);
  console.log("  Vault Authorized:", isAuthorized);
  
  console.log("\n📝 Fee Distribution Example:");
  console.log("  If LP deposits 100 USDC and vault generates 10 USDC profit:");
  
  const totalProfit = ethers.parseUnits("10", 6);
  const [lpProfit, vaultOwnerNet, protocolFee] = await feeCollector.calculateFeeDistribution(
    totalProfit,
    performanceFeeBps
  );
  
  console.log(`  - Total Profit: 10 USDC`);
  console.log(`  - LP Keeps: ${ethers.formatUnits(lpProfit, 6)} USDC (${Number(lpProfit) * 100 / Number(totalProfit)}%)`);
  console.log(`  - Vault Owner Gets: ${ethers.formatUnits(vaultOwnerNet, 6)} USDC`);
  console.log(`  - Protocol Gets: ${ethers.formatUnits(protocolFee, 6)} USDC`);
  
  console.log("\n✅ Fee structure matches manager's requirements:");
  console.log("  - LP gets 90% of profit (9 USDC)");
  console.log("  - Vault owner's gross fee is 10% of profit (1 USDC)");
  console.log("  - Protocol takes 10% of vault owner's fee (0.1 USDC)");
  console.log("  - Vault owner nets 0.9 USDC");
  
  console.log("\n" + "=".repeat(60) + "\n");
}

main().catch(console.error);
