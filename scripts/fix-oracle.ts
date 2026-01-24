import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  CHAINLINK_USDC_USD: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  CHAINLINK_ETH_USD: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  console.log("Oracle:", state.chainlinkOracle);

  const oracle = await ethers.getContractAt(
    "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    state.chainlinkOracle
  );

  console.log("\nChecking current stale thresholds...");
  const defaultThreshold = await oracle.defaultStaleThreshold();
  console.log("Default stale threshold:", defaultThreshold.toString(), "seconds");

  console.log("\nSetting longer stale threshold (24 hours) for stablecoins...");
  const ONE_DAY = 24 * 60 * 60;
  await (await oracle.setStaleThreshold(BASE_MAINNET.USDC, ONE_DAY)).wait();
  console.log("✅ USDC stale threshold set to 24 hours");

  const usdcThreshold = await oracle.stalePriceThreshold(BASE_MAINNET.USDC);
  console.log("Verified USDC threshold:", usdcThreshold.toString(), "seconds");

  console.log("\nTesting prices...");
  try {
    const usdcPrice = await oracle.priceUsdE18(BASE_MAINNET.USDC);
    console.log("USDC Price:", ethers.formatUnits(usdcPrice, 18), "USD");
  } catch (e: any) {
    console.log("USDC Price Error:", e.reason || e.message);
  }
  try {
    const wethPrice = await oracle.priceUsdE18(BASE_MAINNET.WETH);
    console.log("WETH Price:", ethers.formatUnits(wethPrice, 18), "USD");
  } catch (e: any) {
    console.log("WETH Price Error:", e.reason || e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
