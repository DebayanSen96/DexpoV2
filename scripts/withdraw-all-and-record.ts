import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("FULL WITHDRAWAL TEST");
  console.log("=".repeat(70));
  console.log("Timestamp:", new Date().toISOString());

  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const vaultAddress = state.lendingVault.indexSwap;
  const lendModuleAddress = state.lendModuleV3;

  const lendModule = await ethers.getContractAt("contracts/v3/mainnet/modules/LendModuleV3.sol:LendModuleV3", lendModuleAddress);
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const vault = await ethers.getContractAt("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3", vaultAddress);

  console.log("\n--- BEFORE WITHDRAWAL ---");
  
  const positionBefore = await lendModule.getPosition(vaultAddress, BASE_MAINNET.USDC);
  const vaultUsdcBefore = await usdc.balanceOf(vaultAddress);
  const tvlBefore = await vault.getTotalValueUsd();

  console.log("Lending Position:", ethers.formatUnits(positionBefore.currentBalance, 6), "USDC");
  console.log("Vault USDC:", ethers.formatUnits(vaultUsdcBefore, 6), "USDC");
  console.log("Vault TVL:", ethers.formatEther(tvlBefore), "USD");

  console.log("\n--- WITHDRAWING ALL FROM AAVE ---");
  
  const withdrawTx = await lendModule.withdrawAll(vaultAddress, BASE_MAINNET.USDC);
  console.log("Tx hash:", withdrawTx.hash);
  const receipt = await withdrawTx.wait();
  console.log("✅ Withdrawal confirmed! Gas used:", receipt?.gasUsed.toString());

  console.log("\n--- AFTER WITHDRAWAL ---");

  const positionAfter = await lendModule.getPosition(vaultAddress, BASE_MAINNET.USDC);
  const vaultUsdcAfter = await usdc.balanceOf(vaultAddress);
  const tvlAfter = await vault.getTotalValueUsd();

  console.log("Lending Position:", ethers.formatUnits(positionAfter.currentBalance, 6), "USDC");
  console.log("Vault USDC:", ethers.formatUnits(vaultUsdcAfter, 6), "USDC");
  console.log("Vault TVL:", ethers.formatEther(tvlAfter), "USD");

  const usdcReceived = BigInt(vaultUsdcAfter) - BigInt(vaultUsdcBefore);
  console.log("\n--- SUMMARY ---");
  console.log("USDC Received from Aave:", ethers.formatUnits(usdcReceived, 6), "USDC");
  console.log("Original Supply:", ethers.formatUnits(positionBefore.suppliedAmount, 6), "USDC");
  console.log("Profit Earned:", ethers.formatUnits(usdcReceived - positionBefore.suppliedAmount, 6), "USDC");

  return {
    txHash: withdrawTx.hash,
    positionBefore: ethers.formatUnits(positionBefore.currentBalance, 6),
    positionAfter: ethers.formatUnits(positionAfter.currentBalance, 6),
    vaultUsdcBefore: ethers.formatUnits(vaultUsdcBefore, 6),
    vaultUsdcAfter: ethers.formatUnits(vaultUsdcAfter, 6),
    usdcReceived: ethers.formatUnits(usdcReceived, 6),
    profitEarned: ethers.formatUnits(usdcReceived - positionBefore.suppliedAmount, 6),
  };
}

main()
  .then((result) => {
    console.log("\n📊 Results:", JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
