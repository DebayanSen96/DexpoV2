import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  AAVE_AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
};

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("WITHDRAW ALL FROM VAULT");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const weth = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.WETH);
  const aUsdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.AAVE_AUSDC);

  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/base-mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap
  );
  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/base-mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );

  console.log("\nDeployer:", deployer.address);
  console.log("Vault:", state.testVault.indexSwap);

  console.log("\n--- Current State ---");
  const walletUsdc = await usdc.balanceOf(deployer.address);
  const vaultUsdc = await usdc.balanceOf(state.testVault.indexSwap);
  const vaultWeth = await weth.balanceOf(state.testVault.indexSwap);
  const hubAUsdc = await aUsdc.balanceOf(state.lendingHub);
  const userShares = await vault.balanceOf(deployer.address);

  console.log("Wallet USDC:", ethers.formatUnits(walletUsdc, 6));
  console.log("Vault USDC:", ethers.formatUnits(vaultUsdc, 6));
  console.log("Vault WETH:", ethers.formatUnits(vaultWeth, 18));
  console.log("Hub aUSDC:", ethers.formatUnits(hubAUsdc, 6));
  console.log("User Shares:", ethers.formatUnits(userShares, 18));

  const position = await lendingHub.getPosition(state.testVault.indexSwap, BASE_MAINNET.USDC);
  console.log("\nLending Position:");
  console.log("  Shares:", position.shares.toString());
  console.log("  Supplied:", ethers.formatUnits(position.suppliedAmount, 6));
  console.log("  Current:", ethers.formatUnits(position.currentBalance, 6));

  if (position.shares > 0n) {
    console.log("\n--- Withdrawing from Lending ---");
    try {
      const withdrawTx = await lendingHub.withdrawAll(state.testVault.indexSwap, BASE_MAINNET.USDC, { gasLimit: 500000 });
      await withdrawTx.wait();
      console.log("✅ Lending withdrawal complete");
    } catch (e: any) {
      console.log("⚠️ Lending withdrawal failed:", e.reason || e.message);
    }
    await delay(2000);
  }

  const updatedVaultUsdc = await usdc.balanceOf(state.testVault.indexSwap);
  const updatedUserShares = await vault.balanceOf(deployer.address);
  console.log("\nUpdated Vault USDC:", ethers.formatUnits(updatedVaultUsdc, 6));
  console.log("Updated User Shares:", ethers.formatUnits(updatedUserShares, 18));

  if (updatedUserShares > 0n) {
    console.log("\n--- Withdrawing from Vault ---");
    try {
      const withdrawTx = await vault.withdraw(updatedUserShares, { gasLimit: 500000 });
      await withdrawTx.wait();
      console.log("✅ Vault withdrawal complete");
    } catch (e: any) {
      console.log("⚠️ Vault withdrawal failed:", e.reason || e.message);
    }
    await delay(2000);
  }

  console.log("\n--- Final State ---");
  const finalWalletUsdc = await usdc.balanceOf(deployer.address);
  const finalWalletWeth = await weth.balanceOf(deployer.address);
  const finalVaultUsdc = await usdc.balanceOf(state.testVault.indexSwap);
  const finalVaultWeth = await weth.balanceOf(state.testVault.indexSwap);

  console.log("Wallet USDC:", ethers.formatUnits(finalWalletUsdc, 6));
  console.log("Wallet WETH:", ethers.formatUnits(finalWalletWeth, 18));
  console.log("Vault USDC:", ethers.formatUnits(finalVaultUsdc, 6));
  console.log("Vault WETH:", ethers.formatUnits(finalVaultWeth, 18));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });


