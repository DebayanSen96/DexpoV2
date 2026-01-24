import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AAVE_POOL_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
};

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("REDEPLOYING LENDING HUB AND AAVE ADAPTER");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  console.log("\nDeployer:", deployer.address);

  const statePath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

  console.log("\n[1] Deploying new LendingHub...");
  const LendingHub = await ethers.getContractFactory("contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub");
  const lendingHub = await LendingHub.deploy(state.protocolCore, state.chainlinkOracle);
  await lendingHub.waitForDeployment();
  const lendingHubAddress = await lendingHub.getAddress();
  console.log("  LendingHub:", lendingHubAddress);
  await delay(2000);

  console.log("\n[2] Deploying new AaveV3Adapter...");
  const AaveV3Adapter = await ethers.getContractFactory("contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter");
  const aaveAdapter = await AaveV3Adapter.deploy(BASE_MAINNET.AAVE_POOL_PROVIDER);
  await aaveAdapter.waitForDeployment();
  const aaveAdapterAddress = await aaveAdapter.getAddress();
  console.log("  AaveV3Adapter:", aaveAdapterAddress);
  await delay(2000);

  console.log("\n[3] Configuring AaveV3Adapter...");
  await (await aaveAdapter.setLendingHub(lendingHubAddress)).wait();
  console.log("  ✅ Set LendingHub");
  await delay(1500);
  
  await (await aaveAdapter.addSupportedToken(BASE_MAINNET.USDC)).wait();
  console.log("  ✅ Added USDC support");
  await delay(1500);

  console.log("\n[4] Adding adapter to LendingHub...");
  const adapterId = ethers.keccak256(ethers.toUtf8Bytes("aave-v3-base"));
  await (await lendingHub.addAdapter(adapterId, aaveAdapterAddress)).wait();
  console.log("  ✅ Added adapter with ID:", adapterId);
  await delay(1500);

  console.log("\n[5] Updating ModuleRegistry...");
  const registry = await ethers.getContractAt(
    "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
    state.moduleRegistry
  );
  await (await registry.setLendModule(lendingHubAddress)).wait();
  console.log("  ✅ Updated LendModule in registry");
  await delay(1500);

  state.lendingHub = lendingHubAddress;
  state.aaveV3Adapter = aaveAdapterAddress;
  state.adapterIds.aaveV3 = adapterId;

  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log("\n✅ Deployment state updated");

  console.log("\n" + "=".repeat(70));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(70));
  console.log("LendingHub:", lendingHubAddress);
  console.log("AaveV3Adapter:", aaveAdapterAddress);
  console.log("Adapter ID:", adapterId);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
