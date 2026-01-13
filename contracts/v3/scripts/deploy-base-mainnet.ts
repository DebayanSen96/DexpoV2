import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  SWAP_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
  QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  
  CHAINLINK_ETH_USD: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  CHAINLINK_WBTC_USD: "0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E",
  CHAINLINK_USDC_USD: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  CHAINLINK_DAI_USD: "0x591e79239a7d679378eC8c847e5038150364C78F",
  CHAINLINK_CBETH_USD: "0xd7818272B9e248357d13057AAb0B417aF31E817d",
  
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDBC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  CBETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
};

interface DeploymentResult {
  chainId: number;
  network: string;
  deployer: string;
  timestamp: string;
  contracts: Record<string, string>;
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("DEXPO V3 - BASE MAINNET DEPLOYMENT");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  
  console.log("\n📋 Deployment Info:");
  console.log("  Network:", network.name, `(chainId: ${network.chainId})`);
  console.log("  Deployer:", deployer.address);
  console.log("  Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  if (network.chainId !== 8453n) {
    console.log("\n⚠️  WARNING: Not on Base Mainnet (chainId 8453)");
    console.log("  Current chainId:", network.chainId.toString());
    const proceed = process.env.FORCE_DEPLOY === "true";
    if (!proceed) {
      console.log("  Set FORCE_DEPLOY=true to proceed anyway");
      return;
    }
  }

  const deployment: DeploymentResult = {
    chainId: Number(network.chainId),
    network: "base-mainnet",
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {},
  };

  console.log("\n" + "=".repeat(70));
  console.log("STEP 1: Deploy ChainlinkOracle");
  console.log("=".repeat(70));

  const ChainlinkOracle = await ethers.getContractFactory("ChainlinkOracle");
  const oracle = await ChainlinkOracle.deploy();
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  deployment.contracts.ChainlinkOracle = oracleAddress;
  console.log("✅ ChainlinkOracle deployed:", oracleAddress);

  console.log("\n  Setting price feeds...");
  const tokens = [
    BASE_MAINNET.WETH,
    BASE_MAINNET.WBTC,
    BASE_MAINNET.USDC,
    BASE_MAINNET.DAI,
    BASE_MAINNET.CBETH,
  ];
  const feeds = [
    BASE_MAINNET.CHAINLINK_ETH_USD,
    BASE_MAINNET.CHAINLINK_WBTC_USD,
    BASE_MAINNET.CHAINLINK_USDC_USD,
    BASE_MAINNET.CHAINLINK_DAI_USD,
    BASE_MAINNET.CHAINLINK_CBETH_USD,
  ];
  
  const tx1 = await oracle.setPriceFeeds(tokens, feeds);
  await tx1.wait();
  console.log("✅ Price feeds configured");

  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: Deploy ModuleRegistry");
  console.log("=".repeat(70));

  const ModuleRegistry = await ethers.getContractFactory("ModuleRegistry");
  const registry = await ModuleRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  deployment.contracts.ModuleRegistry = registryAddress;
  console.log("✅ ModuleRegistry deployed:", registryAddress);

  const tx2 = await registry.setOracle(oracleAddress);
  await tx2.wait();
  console.log("✅ Oracle registered in ModuleRegistry");

  console.log("\n" + "=".repeat(70));
  console.log("STEP 3: Deploy SwapModuleV3");
  console.log("=".repeat(70));

  const SwapModuleV3 = await ethers.getContractFactory("SwapModuleV3");
  const swapModule = await SwapModuleV3.deploy(
    registryAddress,
    BASE_MAINNET.SWAP_ROUTER,
    oracleAddress
  );
  await swapModule.waitForDeployment();
  const swapModuleAddress = await swapModule.getAddress();
  deployment.contracts.SwapModuleV3 = swapModuleAddress;
  console.log("✅ SwapModuleV3 deployed:", swapModuleAddress);

  const tx3 = await registry.setSwapModule(swapModuleAddress);
  await tx3.wait();
  console.log("✅ SwapModuleV3 registered");

  console.log("\n" + "=".repeat(70));
  console.log("STEP 4: Deploy BuySellModuleV3");
  console.log("=".repeat(70));

  const BuySellModuleV3 = await ethers.getContractFactory("BuySellModuleV3");
  const buySellModule = await BuySellModuleV3.deploy(
    registryAddress,
    BASE_MAINNET.SWAP_ROUTER,
    oracleAddress
  );
  await buySellModule.waitForDeployment();
  const buySellModuleAddress = await buySellModule.getAddress();
  deployment.contracts.BuySellModuleV3 = buySellModuleAddress;
  console.log("✅ BuySellModuleV3 deployed:", buySellModuleAddress);

  const tx4 = await registry.setBuySellModule(buySellModuleAddress);
  await tx4.wait();
  console.log("✅ BuySellModuleV3 registered");

  console.log("\n" + "=".repeat(70));
  console.log("STEP 5: Configure Pool Fees");
  console.log("=".repeat(70));

  const FEE_LOW = 500;
  const FEE_MEDIUM = 3000;

  await (await swapModule.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.USDC, FEE_LOW)).wait();
  await (await swapModule.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.DAI, FEE_MEDIUM)).wait();
  await (await swapModule.setPoolFee(BASE_MAINNET.USDC, BASE_MAINNET.DAI, FEE_LOW)).wait();
  console.log("✅ Pool fees configured for SwapModuleV3");

  await (await buySellModule.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.USDC, FEE_LOW)).wait();
  await (await buySellModule.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.DAI, FEE_MEDIUM)).wait();
  await (await buySellModule.setPoolFee(BASE_MAINNET.USDC, BASE_MAINNET.DAI, FEE_LOW)).wait();
  console.log("✅ Pool fees configured for BuySellModuleV3");

  console.log("\n" + "=".repeat(70));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(70));

  console.log("\n📦 Deployed Contracts:");
  for (const [name, address] of Object.entries(deployment.contracts)) {
    console.log(`  ${name}: ${address}`);
  }

  console.log("\n🔗 External Dependencies:");
  console.log("  Uniswap V3 Router:", BASE_MAINNET.SWAP_ROUTER);
  console.log("  Chainlink ETH/USD:", BASE_MAINNET.CHAINLINK_ETH_USD);

  const outputDir = path.join(__dirname, "../../deployments/v3-latest");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const outputPath = path.join(outputDir, "base-mainnet.json");
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));
  console.log("\n💾 Deployment saved to:", outputPath);

  console.log("\n✅ BASE MAINNET DEPLOYMENT COMPLETE!");
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
