import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("REDEPLOYING LENDING VAULT WITH PERFORMANCE FEE FIX");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const statePath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

  console.log("\nDeployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  console.log("\n[1/4] Deploying new VaultSafe...");
  const VaultSafe = await ethers.getContractFactory("contracts/v3/mainnet/vault/VaultSafe.sol:VaultSafe");
  const vaultSafe = await VaultSafe.deploy(
    state.protocolCore,
    [deployer.address],
    1
  );
  await vaultSafe.waitForDeployment();
  const safeAddress = await vaultSafe.getAddress();
  console.log("  ✅ VaultSafe:", safeAddress);

  console.log("\n[2/4] Deploying new IndexSwapV3 (with fee fix)...");
  const IndexSwapV3 = await ethers.getContractFactory("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3");
  const vault = await IndexSwapV3.deploy(
    state.protocolCore,
    safeAddress,
    state.moduleRegistry,
    "Lending Test Vault V2",
    "LTV2",
    [{ token: BASE_MAINNET.USDC, weightBps: 10000 }],
    0
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("  ✅ IndexSwapV3:", vaultAddress);

  console.log("\n[3/4] Configuring vault...");
  
  await (await vault.setModules(state.lendModuleV3, ethers.ZeroAddress)).wait();
  console.log("  ✓ Lend module set");
  
  await (await vault.setFeeCollector(state.feeCollector)).wait();
  console.log("  ✓ Fee collector set");
  
  await (await vault.setPerformanceFee(1000)).wait();
  console.log("  ✓ Performance fee set to 10%");
  
  await (await vault.setVaultOwner(deployer.address)).wait();
  console.log("  ✓ Vault owner set");

  console.log("\n[4/4] Saving state...");
  state.lendingVaultV2 = {
    indexSwap: vaultAddress,
    safe: safeAddress,
    name: "Lending Test Vault V2",
    symbol: "LTV2",
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log("  ✅ State saved");

  console.log("\n" + "=".repeat(70));
  console.log("✅ LENDING VAULT V2 DEPLOYED");
  console.log("=".repeat(70));
  console.log("Vault:", vaultAddress);
  console.log("Safe:", safeAddress);
  console.log("\nThis vault has the performance fee fix:");
  console.log("- Tracks user cost basis on deposit");
  console.log("- Deducts performance fee on profit at withdrawal");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
