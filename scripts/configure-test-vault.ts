import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("\n=== CONFIGURING TEST VAULT ===\n");

  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap
  );

  console.log("Vault:", state.testVault.indexSwap);
  console.log("LendingHub:", state.lendingHub);
  console.log("FeeCollector:", state.feeCollector);

  console.log("\nConfiguring vault...");
  
  try {
    await (await vault.setModules(state.lendingHub, ethers.ZeroAddress)).wait();
    console.log("✓ Modules set");
  } catch (e: any) {
    console.log("Modules already set or error:", e.reason || e.message);
  }

  try {
    await (await vault.setFeeCollector(state.feeCollector)).wait();
    console.log("✓ Fee collector set");
  } catch (e: any) {
    console.log("Fee collector already set or error:", e.reason || e.message);
  }

  try {
    await (await vault.setPerformanceFee(1000)).wait();
    console.log("✓ Performance fee set to 10%");
  } catch (e: any) {
    console.log("Performance fee already set or error:", e.reason || e.message);
  }

  try {
    await (await vault.setVaultOwner(deployer.address)).wait();
    console.log("✓ Vault owner set");
  } catch (e: any) {
    console.log("Vault owner already set or error:", e.reason || e.message);
  }

  console.log("\n✅ Vault configuration complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
