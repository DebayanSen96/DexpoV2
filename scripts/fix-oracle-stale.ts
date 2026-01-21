import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  CHAINLINK_USDC_USD: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
};

async function main() {
  const [signer] = await ethers.getSigners();
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  console.log("Using oracle:", state.chainlinkOracle);
  
  const oracle = await ethers.getContractAt(
    "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    state.chainlinkOracle,
    signer
  );
  
  console.log("\n--- Checking Chainlink Feed Staleness ---");
  
  const usdcFeed = await oracle.priceFeeds(BASE_MAINNET.USDC);
  console.log("USDC Feed Address:", usdcFeed);
  
  const feedContract = await ethers.getContractAt(
    ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"],
    usdcFeed,
    signer
  );
  
  const [, answer, , updatedAt, ] = await feedContract.latestRoundData();
  const decimals = await feedContract.decimals();
  
  console.log("USDC Price:", Number(answer.toString()) / (10 ** Number(decimals)), "USD");
  console.log("Last Updated:", new Date(Number(updatedAt.toString()) * 1000).toISOString());
  console.log("Seconds since update:", Math.floor(Date.now() / 1000) - Number(updatedAt.toString()));
  
  const currentThreshold = await oracle.defaultStaleThreshold();
  console.log("Current stale threshold:", Number(currentThreshold), "seconds (", Number(currentThreshold) / 3600, "hours)");
  
  console.log("\n--- Setting longer stale threshold (24 hours) ---");
  const tx = await oracle.setDefaultStaleThreshold(86400);
  await tx.wait();
  console.log("✅ Stale threshold updated to 24 hours");
  
  console.log("\n--- Testing USDC price again ---");
  try {
    const usdcPrice = await oracle.priceUsdE18(BASE_MAINNET.USDC);
    console.log("✅ USDC Price:", ethers.formatEther(usdcPrice), "USD");
  } catch (e: any) {
    console.log("❌ Still failing:", e.message?.split('\n')[0]);
  }
  
  console.log("\n--- Testing all prices ---");
  try {
    const ethPrice = await oracle.priceUsdE18(BASE_MAINNET.WETH);
    console.log("✅ ETH Price:", ethers.formatEther(ethPrice), "USD");
  } catch (e: any) {
    console.log("❌ ETH Price Error:", e.message?.split('\n')[0]);
  }
  
  try {
    const btcPrice = await oracle.priceUsdE18(BASE_MAINNET.WBTC);
    console.log("✅ BTC Price:", ethers.formatEther(btcPrice), "USD");
  } catch (e: any) {
    console.log("❌ BTC Price Error:", e.message?.split('\n')[0]);
  }
}

main().catch(console.error);
