import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  AAVE_POOL_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
};

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("REDEPLOYING AAVE V3 ADAPTER (Fixed)");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const statePath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

  console.log("\nDeployer:", deployer.address);
  console.log("Old AaveV3Adapter:", state.aaveV3Adapter);

  console.log("\n[1/4] Deploying new AaveV3Adapter...");
  const AaveV3Adapter = await ethers.getContractFactory(
    "contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter"
  );
  const newAdapter = await AaveV3Adapter.deploy(BASE_MAINNET.AAVE_POOL_PROVIDER);
  await newAdapter.waitForDeployment();
  const newAdapterAddress = await newAdapter.getAddress();
  console.log("  ✅ New AaveV3Adapter:", newAdapterAddress);
  await delay(2000);

  console.log("\n[2/4] Configuring new adapter...");
  let nonce = await deployer.getNonce();
  await (await newAdapter.setLendingHub(state.lendingHub)).wait();
  console.log("  ✅ LendingHub set");
  await delay(2000);

  nonce = await deployer.getNonce();
  await (await newAdapter.addSupportedToken(BASE_MAINNET.USDC)).wait();
  console.log("  ✅ USDC added");
  await delay(2000);

  nonce = await deployer.getNonce();
  await (await newAdapter.addSupportedToken(BASE_MAINNET.WETH)).wait();
  console.log("  ✅ WETH added");
  await delay(2000);

  console.log("\n[3/4] Updating LendingHub to use new adapter...");
  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );

  const AAVE_ADAPTER_ID = state.adapterIds.aaveV3;
  nonce = await deployer.getNonce();
  await (await lendingHub.updateAdapter(AAVE_ADAPTER_ID, newAdapterAddress)).wait();
  console.log("  ✅ Adapter updated in LendingHub");
  await delay(2000);

  console.log("\n[4/4] Saving state...");
  state.aaveV3Adapter = newAdapterAddress;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log("  ✅ State saved");

  console.log("\n" + "=".repeat(70));
  console.log("REDEPLOY COMPLETE");
  console.log("=".repeat(70));
  console.log("New AaveV3Adapter:", newAdapterAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
