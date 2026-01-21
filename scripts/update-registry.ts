import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  const registry = await ethers.getContractAt(
    "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
    state.moduleRegistry,
    deployer
  );
  
  const newSwapModule = "0xF7F79F58AdfabDC0D653eE555fBD1350293E20bf";
  
  console.log("Updating SwapModule in registry...");
  const tx = await registry.setSwapModule(newSwapModule);
  await tx.wait();
  console.log("Done!");
  
  state.swapModuleV3 = newSwapModule;
  fs.writeFileSync(deploymentPath, JSON.stringify(state, null, 2));
  console.log("State saved");
}

main().catch(console.error);
