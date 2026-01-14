import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  const oracle = await ethers.getContractAt(
    "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    state.chainlinkOracle
  );
  
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  
  console.log("Testing priceUsdE18 for USDC...");
  const price = await oracle.priceUsdE18(USDC);
  console.log("USDC Price:", ethers.formatEther(price), "USD");
}

main().catch(console.error);
