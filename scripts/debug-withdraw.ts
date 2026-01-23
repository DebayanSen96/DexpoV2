import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AAVE_AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
};

async function main() {
  console.log("\n=== DEBUG WITHDRAW ===\n");

  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const vaultAddress = state.lendingVault.indexSwap;
  const lendModuleAddress = state.lendModuleV3;

  const lendModule = await ethers.getContractAt("contracts/v3/mainnet/modules/LendModuleV3.sol:LendModuleV3", lendModuleAddress);
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const aUsdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.AAVE_AUSDC);

  console.log("Vault:", vaultAddress);
  console.log("LendModule:", lendModuleAddress);

  console.log("\n--- Current State ---");
  
  const moduleAUsdc = await aUsdc.balanceOf(lendModuleAddress);
  console.log("LendModule aUSDC balance:", ethers.formatUnits(moduleAUsdc, 6));

  const totalShares = await lendModule.totalATokenShares(BASE_MAINNET.USDC);
  console.log("Total aToken shares:", totalShares.toString());

  const position = await lendModule.getPosition(vaultAddress, BASE_MAINNET.USDC);
  console.log("Vault position shares:", position.aTokenShares.toString());
  console.log("Vault supplied amount:", ethers.formatUnits(position.suppliedAmount, 6));
  console.log("Vault current balance:", ethers.formatUnits(position.currentBalance, 6));

  if (position.aTokenShares > 0n && totalShares > 0n) {
    const vaultATokenBalance = (position.aTokenShares * moduleAUsdc) / totalShares;
    console.log("\nCalculated vault aToken balance:", ethers.formatUnits(vaultATokenBalance, 6));
  }

  console.log("\n--- Vault USDC ---");
  const vaultUsdc = await usdc.balanceOf(vaultAddress);
  console.log("Vault USDC:", ethers.formatUnits(vaultUsdc, 6));

  if (position.aTokenShares > 0n) {
    console.log("\n--- Attempting withdraw with regular withdraw() ---");
    const withdrawAmount = position.currentBalance;
    console.log("Withdraw amount:", ethers.formatUnits(withdrawAmount, 6));
    
    try {
      const tx = await lendModule.withdraw(vaultAddress, BASE_MAINNET.USDC, withdrawAmount);
      console.log("Tx hash:", tx.hash);
      const receipt = await tx.wait();
      console.log("✅ Success! Gas:", receipt?.gasUsed.toString());

      const positionAfter = await lendModule.getPosition(vaultAddress, BASE_MAINNET.USDC);
      console.log("Position after:", ethers.formatUnits(positionAfter.currentBalance, 6));
      
      const vaultUsdcAfter = await usdc.balanceOf(vaultAddress);
      console.log("Vault USDC after:", ethers.formatUnits(vaultUsdcAfter, 6));
    } catch (e: any) {
      console.log("❌ Failed:", e.reason || e.message);
    }
  } else {
    console.log("\n⚠️ No position to withdraw");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
