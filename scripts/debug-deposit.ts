import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
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
  
  const oracle = await ethers.getContractAt(
    "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    state.chainlinkOracle,
    signer
  );
  
  console.log("\n--- Debug Info ---");
  
  console.log("\n1. Check USDC price from oracle:");
  try {
    const usdcPrice = await oracle.priceUsdE18(BASE_MAINNET.USDC);
    console.log("  USDC Price:", ethers.formatEther(usdcPrice), "USD");
  } catch (e: any) {
    console.log("  ❌ USDC Price Error:", e.message?.split('\n')[0]);
  }
  
  console.log("\n2. Check if protocol is paused:");
  const protocolCore = await ethers.getContractAt("IProtocolCoreOwnable", state.protocolCore, signer);
  try {
    const globalPaused = await protocolCore.isGlobalPaused();
    console.log("  Global Paused:", globalPaused);
  } catch (e: any) {
    console.log("  ❌ Error checking pause:", e.message?.split('\n')[0]);
  }
  
  console.log("\n3. Check vault portfolio:");
  try {
    const portfolio = await vault.getPortfolio();
    console.log("  Portfolio tokens:", portfolio.length);
    for (const p of portfolio) {
      console.log(`    - ${p.token}: ${Number(p.weightBps)/100}%`);
    }
  } catch (e: any) {
    console.log("  ❌ Error:", e.message?.split('\n')[0]);
  }
  
  console.log("\n4. Check USDC allowance:");
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const allowance = await usdc.allowance(signer.address, state.testVault.indexSwap);
  console.log("  Allowance:", ethers.formatUnits(allowance, 6), "USDC");
  
  console.log("\n5. Try to estimate gas for depositSingle:");
  try {
    const testAmount = ethers.parseUnits("1", 6);
    const gasEstimate = await vault.depositSingle.estimateGas(BASE_MAINNET.USDC, testAmount);
    console.log("  Gas estimate:", gasEstimate.toString());
  } catch (e: any) {
    console.log("  ❌ Gas estimation failed:", e.message?.split('\n')[0]);
    
    if (e.data) {
      console.log("  Error data:", e.data);
    }
  }
  
  console.log("\n6. Check if USDC is in portfolio:");
  const isPortfolioToken = await vault.isPortfolioToken(BASE_MAINNET.USDC);
  console.log("  USDC in portfolio:", isPortfolioToken);
}

main().catch(console.error);
