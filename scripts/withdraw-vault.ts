import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
};

async function main() {
  const [signer] = await ethers.getSigners();
  
  console.log("\n" + "=".repeat(60));
  console.log("WITHDRAW FROM VAULT");
  console.log("=".repeat(60));
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap,
    signer
  );
  
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const weth = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.WETH);
  
  console.log("\n--- Before Withdrawal ---");
  const sharesBefore = await vault.balanceOf(signer.address);
  console.log("Your shares:", ethers.formatEther(sharesBefore));
  
  const vaultUsdcBefore = await usdc.balanceOf(state.testVault.indexSwap);
  const vaultWethBefore = await weth.balanceOf(state.testVault.indexSwap);
  console.log("Vault USDC:", ethers.formatUnits(vaultUsdcBefore, 6));
  console.log("Vault WETH:", ethers.formatEther(vaultWethBefore));
  
  const userUsdcBefore = await usdc.balanceOf(signer.address);
  const userWethBefore = await weth.balanceOf(signer.address);
  console.log("Your USDC:", ethers.formatUnits(userUsdcBefore, 6));
  console.log("Your WETH:", ethers.formatEther(userWethBefore));
  
  if (sharesBefore === 0n) {
    console.log("\n❌ No shares to withdraw");
    return;
  }
  
  console.log("\n--- Withdrawing all shares ---");
  const tx = await vault.withdraw(sharesBefore);
  await tx.wait();
  console.log("✅ Withdrawal complete");
  
  console.log("\n--- After Withdrawal ---");
  const sharesAfter = await vault.balanceOf(signer.address);
  console.log("Your shares:", ethers.formatEther(sharesAfter));
  
  const vaultUsdcAfter = await usdc.balanceOf(state.testVault.indexSwap);
  const vaultWethAfter = await weth.balanceOf(state.testVault.indexSwap);
  console.log("Vault USDC:", ethers.formatUnits(vaultUsdcAfter, 6));
  console.log("Vault WETH:", ethers.formatEther(vaultWethAfter));
  
  const userUsdcAfter = await usdc.balanceOf(signer.address);
  const userWethAfter = await weth.balanceOf(signer.address);
  console.log("Your USDC:", ethers.formatUnits(userUsdcAfter, 6));
  console.log("Your WETH:", ethers.formatEther(userWethAfter));
  
  console.log("\n--- Received ---");
  console.log("USDC:", ethers.formatUnits(userUsdcAfter - userUsdcBefore, 6));
  console.log("WETH:", ethers.formatEther(userWethAfter - userWethBefore));
  
  console.log("\n" + "=".repeat(60) + "\n");
}

main().catch(console.error);
