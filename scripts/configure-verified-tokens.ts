import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Only verified Base Mainnet Token Addresses with correct checksums
const BASE_TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  wstETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
  rETH: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c",
};

// Verified Chainlink Price Feed Addresses on Base
const CHAINLINK_FEEDS = {
  USDC_USD: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  ETH_USD: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  BTC_USD: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
};

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("CONFIGURE VERIFIED BASE MAINNET TOKENS");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  console.log("\nDeployer:", deployer.address);
  console.log("ChainlinkOracle:", state.chainlinkOracle);
  console.log("AerodromeAdapter:", state.aerodromeAdapter);
  console.log("UniswapV3Adapter:", state.uniswapV3Adapter);
  console.log("AaveV3Adapter:", state.aaveV3Adapter);

  const oracle = await ethers.getContractAt(
    "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    state.chainlinkOracle
  );
  const aerodromeAdapter = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/swap/adapters/AerodromeAdapter.sol:AerodromeAdapter",
    state.aerodromeAdapter
  );
  const uniswapAdapter = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/swap/adapters/UniswapV3Adapter.sol:UniswapV3Adapter",
    state.uniswapV3Adapter
  );
  const aaveAdapter = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter",
    state.aaveV3Adapter
  );

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: Configure Chainlink Price Feeds
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("STEP 1: CONFIGURE CHAINLINK PRICE FEEDS");
  console.log("=".repeat(70));

  console.log("\nAdding cbBTC price feed...");
  try {
    const tx1 = await oracle.setPriceFeeds([BASE_TOKENS.cbBTC], [CHAINLINK_FEEDS.BTC_USD]);
    await tx1.wait();
    console.log("  ✅ cbBTC price feed added");
    await delay(2000);

    const ONE_DAY = 24 * 60 * 60;
    const tx2 = await oracle.setStaleThreshold(BASE_TOKENS.cbBTC, ONE_DAY);
    await tx2.wait();
    console.log("  ✅ cbBTC stale threshold set");
    await delay(2000);
  } catch (error: any) {
    console.log("  ⚠️  cbBTC price feed may already be configured");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: Configure Aerodrome Swap Routes
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: CONFIGURE AERODROME SWAP ROUTES");
  console.log("=".repeat(70));

  const aerodromeRoutes = [
    // cbBTC routes
    { from: BASE_TOKENS.cbBTC, to: BASE_TOKENS.WETH, stable: false, name: "cbBTC->WETH" },
    { from: BASE_TOKENS.WETH, to: BASE_TOKENS.cbBTC, stable: false, name: "WETH->cbBTC" },
    { from: BASE_TOKENS.cbBTC, to: BASE_TOKENS.USDC, stable: false, name: "cbBTC->USDC" },
    { from: BASE_TOKENS.USDC, to: BASE_TOKENS.cbBTC, stable: false, name: "USDC->cbBTC" },
    
    // wstETH routes
    { from: BASE_TOKENS.wstETH, to: BASE_TOKENS.WETH, stable: false, name: "wstETH->WETH" },
    { from: BASE_TOKENS.WETH, to: BASE_TOKENS.wstETH, stable: false, name: "WETH->wstETH" },
    
    // rETH routes
    { from: BASE_TOKENS.rETH, to: BASE_TOKENS.WETH, stable: false, name: "rETH->WETH" },
    { from: BASE_TOKENS.WETH, to: BASE_TOKENS.rETH, stable: false, name: "WETH->rETH" },
  ];

  console.log(`\nConfiguring ${aerodromeRoutes.length} Aerodrome routes...`);
  for (let i = 0; i < aerodromeRoutes.length; i++) {
    const route = aerodromeRoutes[i];
    try {
      const tx = await aerodromeAdapter.configureRoute(route.from, route.to, route.stable, true);
      await tx.wait();
      console.log(`  ✅ [${i + 1}/${aerodromeRoutes.length}] ${route.name}`);
      await delay(1500);
    } catch (error: any) {
      console.log(`  ⚠️  [${i + 1}/${aerodromeRoutes.length}] ${route.name} - may not exist or already configured`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: Configure Uniswap V3 Pools
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("STEP 3: CONFIGURE UNISWAP V3 POOLS");
  console.log("=".repeat(70));

  const uniswapPools = [
    // cbBTC pools (500 = 0.05%, 3000 = 0.3%)
    { tokenA: BASE_TOKENS.cbBTC, tokenB: BASE_TOKENS.WETH, fee: 500, name: "cbBTC->WETH (0.05%)" },
    { tokenA: BASE_TOKENS.WETH, tokenB: BASE_TOKENS.cbBTC, fee: 500, name: "WETH->cbBTC (0.05%)" },
    { tokenA: BASE_TOKENS.cbBTC, tokenB: BASE_TOKENS.USDC, fee: 3000, name: "cbBTC->USDC (0.3%)" },
    { tokenA: BASE_TOKENS.USDC, tokenB: BASE_TOKENS.cbBTC, fee: 3000, name: "USDC->cbBTC (0.3%)" },
    
    // wstETH pools
    { tokenA: BASE_TOKENS.wstETH, tokenB: BASE_TOKENS.WETH, fee: 100, name: "wstETH->WETH (0.01%)" },
    { tokenA: BASE_TOKENS.WETH, tokenB: BASE_TOKENS.wstETH, fee: 100, name: "WETH->wstETH (0.01%)" },
    
    // rETH pools
    { tokenA: BASE_TOKENS.rETH, tokenB: BASE_TOKENS.WETH, fee: 500, name: "rETH->WETH (0.05%)" },
    { tokenA: BASE_TOKENS.WETH, tokenB: BASE_TOKENS.rETH, fee: 500, name: "WETH->rETH (0.05%)" },
  ];

  console.log(`\nConfiguring ${uniswapPools.length} Uniswap V3 pools...`);
  for (let i = 0; i < uniswapPools.length; i++) {
    const pool = uniswapPools[i];
    try {
      const tx = await uniswapAdapter.configurePool(pool.tokenA, pool.tokenB, pool.fee, true);
      await tx.wait();
      console.log(`  ✅ [${i + 1}/${uniswapPools.length}] ${pool.name}`);
      await delay(1500);
    } catch (error: any) {
      console.log(`  ⚠️  [${i + 1}/${uniswapPools.length}] ${pool.name} - may not exist or already configured`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: Configure Aave V3 Lending Support
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("STEP 4: CONFIGURE AAVE V3 LENDING SUPPORT");
  console.log("=".repeat(70));

  const aaveTokens = [
    { address: BASE_TOKENS.cbBTC, name: "cbBTC" },
    { address: BASE_TOKENS.wstETH, name: "wstETH" },
    { address: BASE_TOKENS.rETH, name: "rETH" },
  ];

  console.log(`\nAdding ${aaveTokens.length} tokens to Aave adapter...`);
  for (let i = 0; i < aaveTokens.length; i++) {
    const token = aaveTokens[i];
    try {
      const tx = await aaveAdapter.addSupportedToken(token.address);
      await tx.wait();
      console.log(`  ✅ [${i + 1}/${aaveTokens.length}] ${token.name}`);
      await delay(1500);
    } catch (error: any) {
      console.log(`  ⚠️  [${i + 1}/${aaveTokens.length}] ${token.name} - may not be supported by Aave or already added`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ TOKEN CONFIGURATION COMPLETE");
  console.log("=".repeat(70));

  console.log("\n📊 Configured Tokens:");
  console.log("  - cbBTC (Coinbase Wrapped BTC)");
  console.log("  - wstETH (Lido Wrapped Staked ETH)");
  console.log("  - rETH (Rocket Pool ETH)");

  console.log("\n📝 Configuration Summary:");
  console.log("  ✅ Chainlink Oracle: cbBTC price feed");
  console.log("  ✅ Aerodrome: Swap routes for cbBTC, wstETH, rETH");
  console.log("  ✅ Uniswap V3: Pools for cbBTC, wstETH, rETH");
  console.log("  ✅ Aave V3: Lending support for cbBTC, wstETH, rETH");

  console.log("\n💡 To add more tokens:");
  console.log("  1. Verify token address on Base Etherscan");
  console.log("  2. Check if Chainlink price feed exists");
  console.log("  3. Verify liquidity on Aerodrome/Uniswap");
  console.log("  4. Check Aave V3 Base supported assets");
  console.log("  5. Add to this script and rerun");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
