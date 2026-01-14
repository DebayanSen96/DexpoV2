import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);
  console.log("Nonce:", await ethers.provider.getTransactionCount(signer.address));
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  if (fs.existsSync(deploymentPath)) {
    const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    console.log("\nDeployment State:");
    console.log(JSON.stringify(state, null, 2));
  }
}

main().catch(console.error);
