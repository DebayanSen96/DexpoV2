import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
};

async function main() {
  const [signer] = await ethers.getSigners();
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap,
    signer
  );
  
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const weth = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.WETH);
  const wbtc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.WBTC);
  
  console.log("\n" + "=".repeat(60));
  console.log("VAULT STATE CHECK");
  console.log("=".repeat(60));
  
  console.log("\n📦 Vault:", state.testVault.indexSwap);
  
  console.log("\n--- Token Balances in Vault ---");
  const vaultUsdc = await usdc.balanceOf(state.testVault.indexSwap);
  const vaultWeth = await weth.balanceOf(state.testVault.indexSwap);
  const vaultWbtc = await wbtc.balanceOf(state.testVault.indexSwap);
  
  console.log("  USDC:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  WETH:", ethers.formatEther(vaultWeth));
  console.log("  WBTC:", ethers.formatUnits(vaultWbtc, 8));
  
  console.log("\n--- Vault Metrics ---");
  const tvl = await vault.getTotalValueUsd();
  console.log("  TVL:", ethers.formatEther(tvl), "USD");
  
  const hwm = await vault.highWaterMarkUsd();
  console.log("  High Water Mark:", ethers.formatEther(hwm), "USD");
  
  const totalDeposits = await vault.totalDepositsUsd();
  console.log("  Total Deposits:", ethers.formatEther(totalDeposits), "USD");
  
  const totalWithdrawals = await vault.totalWithdrawalsUsd();
  console.log("  Total Withdrawals:", ethers.formatEther(totalWithdrawals), "USD");
  
  const profit = await vault.getProfitUsd();
  console.log("  Current Profit:", ethers.formatEther(profit), "USD");
  
  console.log("\n--- Share Info ---");
  const totalSupply = await vault.totalSupply();
  console.log("  Total Supply:", ethers.formatEther(totalSupply), "shares");
  
  const userShares = await vault.balanceOf(signer.address);
  console.log("  Your Shares:", ethers.formatEther(userShares));
  
  const sharePrice = await vault.getSharePrice();
  console.log("  Share Price:", ethers.formatEther(sharePrice), "USD");
  
  console.log("\n--- Fee Config ---");
  const performanceFee = await vault.performanceFeeBps();
  console.log("  Performance Fee:", Number(performanceFee) / 100, "%");
  
  const vaultOwner = await vault.vaultOwner();
  console.log("  Vault Owner:", vaultOwner);
  
  const feeCollector = await vault.feeCollector();
  console.log("  Fee Collector:", feeCollector);
  
  console.log("\n" + "=".repeat(60) + "\n");
}

main().catch(console.error);
