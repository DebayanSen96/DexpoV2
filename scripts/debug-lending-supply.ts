import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AAVE_AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const aaveAdapter = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter",
    state.aaveV3Adapter
  );
  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );

  console.log("AaveV3Adapter:", state.aaveV3Adapter);
  console.log("LendingHub:", state.lendingHub);

  const aToken = await aaveAdapter.tokenToAToken(BASE_MAINNET.USDC);
  console.log("\naToken for USDC:", aToken);
  console.log("Expected aUSDC:", BASE_MAINNET.AAVE_AUSDC);
  console.log("Match:", aToken.toLowerCase() === BASE_MAINNET.AAVE_AUSDC.toLowerCase());

  const isSupported = await aaveAdapter.isTokenSupported(BASE_MAINNET.USDC);
  console.log("\nUSDC supported:", isSupported);

  const hubAddress = await aaveAdapter.lendingHub();
  console.log("\nAdapter's lendingHub:", hubAddress);
  console.log("Expected:", state.lendingHub);
  console.log("Match:", hubAddress.toLowerCase() === state.lendingHub.toLowerCase());

  const adapterInfo = await lendingHub.adapters(state.adapterIds.aaveV3);
  console.log("\nAdapter info in hub:");
  console.log("  Address:", adapterInfo.adapterAddress);
  console.log("  Active:", adapterInfo.active);
  console.log("  Name:", adapterInfo.name);

  console.log("\nTrying static call to supply...");
  const vault = state.testVault.indexSwap;
  const amount = ethers.parseUnits("1", 6);
  
  try {
    const result = await lendingHub.supply.staticCall(vault, BASE_MAINNET.USDC, amount, state.adapterIds.aaveV3);
    console.log("Static call result:", result.toString());
  } catch (e: any) {
    console.log("Static call error:", e.reason || e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
