import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  console.log("Deployer:", deployer.address);
  
  const protocolCore = await ethers.getContractAt("contracts/ProtocolCore.sol:ProtocolCore", state.protocolCore);
  const protocolOwner = await protocolCore.owner();
  console.log("Protocol Owner:", protocolOwner);
  console.log("Is deployer protocol owner?", deployer.address === protocolOwner);

  const vault = await ethers.getContractAt("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3", state.testVault.indexSwap);
  const safeAddress = await vault.safe();
  console.log("Vault Safe:", safeAddress);

  const safe = await ethers.getContractAt("contracts/v3/mainnet/vault/VaultSafe.sol:VaultSafe", safeAddress);
  const isSafeOwner = await safe.isOwner(deployer.address);
  console.log("Is deployer safe owner?", isSafeOwner);

  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );

  console.log("\nTrying to call withdraw with 0.5 USDC...");
  const withdrawAmount = ethers.parseUnits("0.5", 6);
  
  try {
    const tx = await lendingHub.withdraw.staticCall(state.testVault.indexSwap, BASE_MAINNET.USDC, withdrawAmount);
    console.log("Static call succeeded, would withdraw:", tx.toString());
  } catch (e: any) {
    console.log("Static call failed:", e.reason || e.message);
    if (e.data) {
      console.log("Error data:", e.data);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
