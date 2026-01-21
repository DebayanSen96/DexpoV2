import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  SWAP_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
  POOL_FEE_LOW: 500,
  POOL_FEE_MEDIUM: 3000,
};

async function main() {
  const [deployer] = await ethers.getSigners();
  
  console.log("\n" + "=".repeat(60));
  console.log("REDEPLOY SWAP MODULE V3");
  console.log("=".repeat(60));
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  console.log("\nDeployer:", deployer.address);
  console.log("ProtocolCore:", state.protocolCore);
  console.log("Oracle:", state.chainlinkOracle);
  
  console.log("\n--- Deploying new SwapModuleV3 ---");
  const SwapModuleV3 = await ethers.getContractFactory("contracts/v3/mainnet/modules/SwapModuleV3.sol:SwapModuleV3");
  const swapModule = await SwapModuleV3.deploy(state.protocolCore, BASE_MAINNET.SWAP_ROUTER, state.chainlinkOracle);
  await swapModule.waitForDeployment();
  const swapModuleAddress = await swapModule.getAddress();
  console.log("✅ SwapModuleV3:", swapModuleAddress);
  
  console.log("\n--- Configuring pool fees ---");
  await (await swapModule.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW)).wait();
  console.log("  Set WETH/USDC fee");
  await (await swapModule.setPoolFee(BASE_MAINNET.USDC, BASE_MAINNET.DAI, BASE_MAINNET.POOL_FEE_LOW)).wait();
  console.log("  Set USDC/DAI fee");
  await (await swapModule.setPoolFee(BASE_MAINNET.WBTC, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW)).wait();
  console.log("  Set WBTC/USDC fee");
  
  console.log("\n--- Updating ModuleRegistry ---");
  const registry = await ethers.getContractAt(
    "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
    state.moduleRegistry,
    deployer
  );
  await (await registry.setSwapModule(swapModuleAddress)).wait();
  console.log("✅ SwapModule updated in registry");
  
  state.swapModuleV3 = swapModuleAddress;
  fs.writeFileSync(deploymentPath, JSON.stringify(state, null, 2));
  console.log("\n💾 Deployment state updated");
  
  console.log("\n--- Verifying ---");
  const newSwapModule = await registry.getSwapModule();
  console.log("SwapModule in registry:", newSwapModule);
  
  console.log("\n" + "=".repeat(60) + "\n");
}

main().catch(console.error);
