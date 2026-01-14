import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
  POOL_FEE_LOWEST: 100,
  POOL_FEE_LOW: 500,
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  const vault = await ethers.getContractAt("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3", state.testVault.indexSwap);
  
  console.log("\n1. Setting pool fees...");
  try {
    await (await vault.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.POOL_FEE_LOW)).wait();
    console.log("  WETH fee set");
  } catch (e: any) { console.log("  WETH fee:", e.message?.split('\n')[0]); }
  
  try {
    await (await vault.setPoolFee(BASE_MAINNET.WBTC, BASE_MAINNET.POOL_FEE_LOW)).wait();
    console.log("  WBTC fee set");
  } catch (e: any) { console.log("  WBTC fee:", e.message?.split('\n')[0]); }
  
  try {
    await (await vault.setPoolFee(BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOWEST)).wait();
    console.log("  USDC fee set");
  } catch (e: any) { console.log("  USDC fee:", e.message?.split('\n')[0]); }
  
  console.log("\n2. Setting fee collector...");
  try {
    await (await vault.setFeeCollector(state.feeCollector)).wait();
    console.log("  Fee collector set");
  } catch (e: any) { console.log("  Fee collector:", e.message?.split('\n')[0]); }
  
  console.log("\n3. Registering vault in ProtocolMetrics...");
  try {
    const metrics = await ethers.getContractAt("contracts/v3/mainnet/core/ProtocolMetrics.sol:ProtocolMetrics", state.protocolMetrics);
    await (await metrics.registerVault(state.testVault.indexSwap)).wait();
    console.log("  Vault registered");
  } catch (e: any) { console.log("  Vault registration:", e.message?.split('\n')[0]); }
  
  console.log("\n✅ Configuration complete!");
}

main().catch(console.error);
