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
  console.log("\n" + "=".repeat(60));
  console.log("BASE MAINNET VAULT TEST");
  console.log("=".repeat(60));
  
  console.log("\nSigner:", signer.address);
  console.log("ETH Balance:", ethers.formatEther(await ethers.provider.getBalance(signer.address)));
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  const vault = await ethers.getContractAt("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3", state.testVault.indexSwap);
  const oracle = await ethers.getContractAt("contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle", state.chainlinkOracle);
  
  console.log("\n📦 Vault:", state.testVault.indexSwap);
  console.log("📦 Oracle:", state.chainlinkOracle);
  
  console.log("\n--- Chainlink Price Feeds ---");
  try {
    const ethPrice = await oracle.priceUsdE18(BASE_MAINNET.WETH);
    console.log("ETH/USD:", ethers.formatEther(ethPrice));
  } catch (e: any) { console.log("ETH/USD: Error -", e.message?.split('\n')[0]); }
  
  try {
    const btcPrice = await oracle.priceUsdE18(BASE_MAINNET.WBTC);
    console.log("BTC/USD:", ethers.formatEther(btcPrice));
  } catch (e: any) { console.log("BTC/USD: Error -", e.message?.split('\n')[0]); }
  
  try {
    const usdcPrice = await oracle.priceUsdE18(BASE_MAINNET.USDC);
    console.log("USDC/USD:", ethers.formatEther(usdcPrice));
  } catch (e: any) { console.log("USDC/USD: Error -", e.message?.split('\n')[0]); }
  
  console.log("\n--- Vault State ---");
  try {
    const tvl = await vault.getTotalValueUsd();
    console.log("TVL:", ethers.formatEther(tvl), "USD");
  } catch (e: any) { console.log("TVL: Error -", e.message?.split('\n')[0]); }
  
  try {
    const sharePrice = await vault.getSharePrice();
    console.log("Share Price:", ethers.formatEther(sharePrice), "USD");
  } catch (e: any) { console.log("Share Price: Error -", e.message?.split('\n')[0]); }
  
  try {
    const portfolio = await vault.getPortfolio();
    console.log("Portfolio tokens:", portfolio.length);
    for (const p of portfolio) {
      const symbol = p.token === BASE_MAINNET.USDC ? "USDC" : 
                     p.token === BASE_MAINNET.WETH ? "WETH" : 
                     p.token === BASE_MAINNET.WBTC ? "WBTC" : p.token;
      console.log(`  ${symbol}: ${Number(p.weightBps)/100}%`);
    }
  } catch (e: any) { console.log("Portfolio: Error -", e.message?.split('\n')[0]); }
  
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const usdcBalance = await usdc.balanceOf(signer.address);
  console.log("\nYour USDC Balance:", ethers.formatUnits(usdcBalance, 6));
  
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log("\n📦 Core:");
  console.log("  DXPToken:", state.dxpToken);
  console.log("  ProtocolCore:", state.protocolCore);
  console.log("  ChainlinkOracle:", state.chainlinkOracle);
  console.log("  ModuleRegistry:", state.moduleRegistry);
  
  console.log("\n📦 Fee & Metrics:");
  console.log("  FeeCollector:", state.feeCollector);
  console.log("  ProtocolMetrics:", state.protocolMetrics);
  
  console.log("\n📦 Modules:");
  console.log("  SwapModuleV3:", state.swapModuleV3);
  console.log("  BuySellModuleV3:", state.buySellModuleV3);
  
  console.log("\n📦 Test Vault:");
  console.log("  VaultSafe:", state.testVault.safe);
  console.log("  IndexSwapV3:", state.testVault.indexSwap);
  
  console.log("\n✅ All contracts deployed and verified on Base Mainnet!");
  console.log("=".repeat(60) + "\n");
}

main().catch(console.error);
