import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
};

async function main() {
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const swapHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub",
    state.swapHub
  );
  const aeroAdapter = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/swap/adapters/AerodromeAdapter.sol:AerodromeAdapter",
    state.aerodromeAdapter
  );

  console.log("SwapHub:", state.swapHub);
  console.log("Aerodrome Adapter:", state.aerodromeAdapter);
  console.log("Aerodrome ID:", state.adapterIds.aerodrome);

  const defaultAdapter = await swapHub.defaultAdapterId();
  console.log("\nDefault Adapter ID:", defaultAdapter);

  const adapterInfo = await swapHub.adapters(state.adapterIds.aerodrome);
  console.log("\nAdapter Info:");
  console.log("  Address:", adapterInfo.adapterAddress);
  console.log("  Active:", adapterInfo.active);
  console.log("  Name:", adapterInfo.name);

  console.log("\nRoute Configuration:");
  const routeUsdcWeth = await aeroAdapter.routes(BASE_MAINNET.USDC, BASE_MAINNET.WETH);
  console.log("  USDC->WETH:", routeUsdcWeth);
  const routeWethUsdc = await aeroAdapter.routes(BASE_MAINNET.WETH, BASE_MAINNET.USDC);
  console.log("  WETH->USDC:", routeWethUsdc);

  console.log("\nRoute Supported Check:");
  const supported1 = await aeroAdapter.isRouteSupported(BASE_MAINNET.USDC, BASE_MAINNET.WETH);
  console.log("  USDC->WETH supported:", supported1);
  const supported2 = await aeroAdapter.isRouteSupported(BASE_MAINNET.WETH, BASE_MAINNET.USDC);
  console.log("  WETH->USDC supported:", supported2);

  console.log("\nQuotes:");
  const amount = ethers.parseUnits("0.5", 6);
  try {
    const quote1 = await aeroAdapter.getQuote(BASE_MAINNET.USDC, BASE_MAINNET.WETH, amount);
    console.log("  USDC->WETH quote:", ethers.formatUnits(quote1, 18), "WETH");
  } catch (e: any) {
    console.log("  USDC->WETH quote error:", e.reason || e.message);
  }

  try {
    const quote2 = await swapHub.getQuote(BASE_MAINNET.USDC, BASE_MAINNET.WETH, amount, state.adapterIds.aerodrome);
    console.log("  SwapHub quote:", ethers.formatUnits(quote2, 18), "WETH");
  } catch (e: any) {
    console.log("  SwapHub quote error:", e.reason || e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
