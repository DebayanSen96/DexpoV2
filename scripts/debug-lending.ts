import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AAVE_AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
};

async function main() {
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );
  const aUsdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.AAVE_AUSDC);

  const vaultAddress = state.testVault.indexSwap;
  const AAVE_ADAPTER_ID = state.adapterIds.aaveV3;

  console.log("Vault:", vaultAddress);
  console.log("LendingHub:", state.lendingHub);
  console.log("Adapter ID:", AAVE_ADAPTER_ID);

  const position = await lendingHub.getPosition(vaultAddress, BASE_MAINNET.USDC);
  console.log("\nPosition:");
  console.log("  Supplied:", position.suppliedAmount.toString());
  console.log("  Current:", position.currentBalance.toString());
  console.log("  Shares:", position.shares.toString());
  console.log("  Adapter ID:", position.adapterId);

  const totalShares = await lendingHub.totalShares(AAVE_ADAPTER_ID, BASE_MAINNET.USDC);
  console.log("\nTotal Shares (hub tracking):", totalShares.toString());

  const hubAUsdc = await aUsdc.balanceOf(state.lendingHub);
  console.log("Hub aUSDC balance:", hubAUsdc.toString());

  console.log("\nComparison:");
  console.log("  Position shares:", position.shares.toString());
  console.log("  Total shares:", totalShares.toString());
  console.log("  Hub aUSDC:", hubAUsdc.toString());
  
  if (position.shares > totalShares) {
    console.log("\n⚠️ ISSUE: Position shares > Total shares - will cause underflow!");
  }

  const aaveAdapter = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter",
    state.aaveV3Adapter
  );
  
  const aToken = await aaveAdapter.getShareToken(BASE_MAINNET.USDC);
  console.log("\naToken address:", aToken);
  
  const allowance = await aUsdc.allowance(state.lendingHub, state.aaveV3Adapter);
  console.log("Hub allowance to adapter:", allowance.toString());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
