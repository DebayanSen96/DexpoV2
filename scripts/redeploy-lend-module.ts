import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  AAVE_POOL_ADDRESSES_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
};

function getDeploymentPath(): string {
  return path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
}

function loadState(): any {
  return JSON.parse(fs.readFileSync(getDeploymentPath(), "utf8"));
}

function saveState(state: any): void {
  fs.writeFileSync(getDeploymentPath(), JSON.stringify(state, null, 2));
  console.log("💾 State saved");
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("REDEPLOYING LENDMODULEV3 (Fixed)");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  console.log("\nDeployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const state = loadState();

  console.log("\n[1/4] Deploying new LendModuleV3...");
  const LendModuleV3 = await ethers.getContractFactory("contracts/v3/mainnet/modules/LendModuleV3.sol:LendModuleV3");
  const lendModule = await LendModuleV3.deploy(
    state.protocolCore,
    BASE_MAINNET.AAVE_POOL_ADDRESSES_PROVIDER,
    state.chainlinkOracle
  );
  await lendModule.waitForDeployment();
  const newLendModuleAddress = await lendModule.getAddress();
  console.log("  ✅ New LendModuleV3:", newLendModuleAddress);

  console.log("\n[2/4] Adding supported tokens...");
  await (await lendModule.addSupportedToken(BASE_MAINNET.USDC)).wait();
  console.log("  ✓ USDC added");
  await (await lendModule.addSupportedToken(BASE_MAINNET.WETH)).wait();
  console.log("  ✓ WETH added");

  console.log("\n[3/4] Updating ModuleRegistry...");
  const registry = await ethers.getContractAt(
    "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
    state.moduleRegistry
  );
  await (await registry.setLendModule(newLendModuleAddress)).wait();
  console.log("  ✅ Registry updated");

  console.log("\n[4/4] Updating lending vault...");
  if (state.lendingVault) {
    const vault = await ethers.getContractAt(
      "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
      state.lendingVault.indexSwap
    );
    await (await vault.setModules(newLendModuleAddress, ethers.ZeroAddress)).wait();
    console.log("  ✅ Vault updated");
  }

  state.lendModuleV3 = newLendModuleAddress;
  saveState(state);

  console.log("\n" + "=".repeat(70));
  console.log("✅ LENDMODULEV3 REDEPLOYED");
  console.log("=".repeat(70));
  console.log("\nNew address:", newLendModuleAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
