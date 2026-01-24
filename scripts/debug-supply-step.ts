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

  console.log("Debug supply step by step...\n");

  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );
  const aaveAdapter = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter",
    state.aaveV3Adapter
  );
  const vault = state.testVault.indexSwap;

  console.log("LendingHub:", state.lendingHub);
  console.log("AaveAdapter:", state.aaveV3Adapter);
  console.log("Vault:", vault);
  console.log("Adapter ID:", state.adapterIds.aaveV3);

  const adapterInfo = await lendingHub.adapters(state.adapterIds.aaveV3);
  console.log("\nAdapter in hub:");
  console.log("  Address:", adapterInfo.adapterAddress);
  console.log("  Active:", adapterInfo.active);
  console.log("  Name:", adapterInfo.name);

  const hubInAdapter = await aaveAdapter.lendingHub();
  console.log("\nHub in adapter:", hubInAdapter);
  console.log("Match:", hubInAdapter.toLowerCase() === state.lendingHub.toLowerCase());

  const isSupported = await aaveAdapter.isTokenSupported(BASE_MAINNET.USDC);
  console.log("\nUSDC supported in adapter:", isSupported);

  const vaultUsdc = await usdc.balanceOf(vault);
  console.log("\nVault USDC:", ethers.formatUnits(vaultUsdc, 6));

  const amount = ethers.parseUnits("0.1", 6);

  console.log("\nChecking vault allowance to hub...");
  const allowance = await usdc.allowance(vault, state.lendingHub);
  console.log("Allowance:", ethers.formatUnits(allowance, 6));

  if (allowance < amount) {
    console.log("Need to approve...");
    const vaultContract = await ethers.getContractAt(
      "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
      vault
    );
    await (await vaultContract.approveToken(BASE_MAINNET.USDC, state.lendingHub, amount)).wait();
    console.log("✅ Approved");
  }

  console.log("\nTrying static call...");
  try {
    const result = await lendingHub.supply.staticCall(vault, BASE_MAINNET.USDC, amount, state.adapterIds.aaveV3);
    console.log("Static call result:", result.toString());
  } catch (e: any) {
    console.log("Static call error:", e.reason || e.message);
    return;
  }

  console.log("\nManually simulating the flow:");
  console.log("1. Hub will transfer USDC from vault to adapter");
  console.log("2. Hub will call adapter.supply()");
  console.log("3. Adapter will approve Aave pool and supply");

  console.log("\nStep 1: Check if hub can transfer from vault...");
  const hubContract = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  
  console.log("\nActual supply call with very high gas...");
  try {
    const tx = await lendingHub.supply(vault, BASE_MAINNET.USDC, amount, state.adapterIds.aaveV3, { gasLimit: 1000000 });
    console.log("TX hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Status:", receipt?.status === 1 ? "SUCCESS" : "FAILED");
    console.log("Gas used:", receipt?.gasUsed.toString());
  } catch (e: any) {
    console.log("Failed:", e.reason || e.shortMessage || e.message);
    
    if (e.receipt) {
      console.log("\nReceipt gas used:", e.receipt.gasUsed.toString());
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
