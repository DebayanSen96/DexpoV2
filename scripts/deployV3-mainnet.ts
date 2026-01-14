import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  chainId: 8453,
  
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
  
  POOL_FEE_LOWEST: 100,
  POOL_FEE_LOW: 500,
  POOL_FEE_MEDIUM: 3000,
  POOL_FEE_HIGH: 10000,
};

interface DeploymentState {
  network: string;
  chainId: number;
  deployer: string;
  timestamp: number;
  lastStep: string;
  
  dxpToken?: string;
  protocolCore?: string;
  chainlinkOracle?: string;
  moduleRegistry?: string;
  feeCollector?: string;
  protocolMetrics?: string;
  swapModuleV3?: string;
  buySellModuleV3?: string;
  
  testVault?: {
    safe: string;
    indexSwap: string;
  };
}

function getDeploymentPath(): string {
  const deploymentsDir = path.join(__dirname, "..", "deployments", "v3-latest");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  return path.join(deploymentsDir, "base-mainnet.json");
}

function loadState(): DeploymentState | null {
  const p = getDeploymentPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state: DeploymentState): void {
  fs.writeFileSync(getDeploymentPath(), JSON.stringify(state, null, 2));
  console.log("💾 State saved");
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("DEXPO V3 - BASE MAINNET DEPLOYMENT");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  
  console.log("\n📋 Deployment Info:");
  console.log("  Network:", network.name);
  console.log("  ChainId:", chainId);
  console.log("  Deployer:", deployer.address);
  console.log("  Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  if (chainId !== BASE_MAINNET.chainId) {
    console.log("\n⚠️  WARNING: Not on Base Mainnet (expected chainId 8453, got", chainId, ")");
    if (process.env.FORCE_DEPLOY !== "true") {
      console.log("  Set FORCE_DEPLOY=true to proceed anyway");
      return;
    }
  }

  let state = loadState();
  if (state && state.deployer === deployer.address) {
    console.log("\n📂 Resuming from:", state.lastStep);
  } else {
    state = {
      network: "base-mainnet",
      chainId,
      deployer: deployer.address,
      timestamp: Date.now(),
      lastStep: "init",
    };
  }

  // ========== STEP 1: DXPToken ==========
  if (!state.dxpToken) {
    console.log("\n[1/7] Deploying DXPToken...");
    const DXPToken = await ethers.getContractFactory("DXPToken");
    const dxp = await DXPToken.deploy();
    await dxp.waitForDeployment();
    state.dxpToken = await dxp.getAddress();
    state.lastStep = "dxpToken";
    saveState(state);
    console.log("✅ DXPToken:", state.dxpToken);
  } else {
    console.log("\n[1/7] ✅ DXPToken:", state.dxpToken);
  }

  // ========== STEP 2: ProtocolCore ==========
  if (!state.protocolCore) {
    console.log("\n[2/7] Deploying ProtocolCore...");
    const ProtocolCore = await ethers.getContractFactory("ProtocolCore");
    const core = await ProtocolCore.deploy(state.dxpToken, 70, 10, 30);
    await core.waitForDeployment();
    state.protocolCore = await core.getAddress();
    state.lastStep = "protocolCore";
    saveState(state);
    console.log("✅ ProtocolCore:", state.protocolCore);
  } else {
    console.log("\n[2/7] ✅ ProtocolCore:", state.protocolCore);
  }

  // ========== STEP 3: ChainlinkOracle ==========
  if (!state.chainlinkOracle) {
    console.log("\n[3/7] Deploying ChainlinkOracle...");
    const ChainlinkOracle = await ethers.getContractFactory("contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle");
    const oracle = await ChainlinkOracle.deploy();
    await oracle.waitForDeployment();
    state.chainlinkOracle = await oracle.getAddress();
    
    console.log("  Setting price feeds...");
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
    await (await oracle.setPriceFeeds(tokens, feeds)).wait();
    
    state.lastStep = "chainlinkOracle";
    saveState(state);
    console.log("✅ ChainlinkOracle:", state.chainlinkOracle);
  } else {
    console.log("\n[3/7] ✅ ChainlinkOracle:", state.chainlinkOracle);
  }

  // ========== STEP 4: ModuleRegistry ==========
  if (!state.moduleRegistry) {
    console.log("\n[4/7] Deploying ModuleRegistry...");
    const ModuleRegistry = await ethers.getContractFactory("contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry");
    const registry = await ModuleRegistry.deploy();
    await registry.waitForDeployment();
    state.moduleRegistry = await registry.getAddress();
    
    await (await registry.setOracle(state.chainlinkOracle)).wait();
    
    state.lastStep = "moduleRegistry";
    saveState(state);
    console.log("✅ ModuleRegistry:", state.moduleRegistry);
  } else {
    console.log("\n[4/7] ✅ ModuleRegistry:", state.moduleRegistry);
  }

  // ========== STEP 5: SwapModuleV3 ==========
  if (!state.swapModuleV3) {
    console.log("\n[5/7] Deploying SwapModuleV3...");
    const SwapModuleV3 = await ethers.getContractFactory("contracts/v3/mainnet/modules/SwapModuleV3.sol:SwapModuleV3");
    const swapModule = await SwapModuleV3.deploy(
      state.protocolCore,
      BASE_MAINNET.SWAP_ROUTER,
      state.chainlinkOracle
    );
    await swapModule.waitForDeployment();
    state.swapModuleV3 = await swapModule.getAddress();
    
    await (await swapModule.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW)).wait();
    await (await swapModule.setPoolFee(BASE_MAINNET.USDC, BASE_MAINNET.DAI, BASE_MAINNET.POOL_FEE_LOWEST)).wait();
    await (await swapModule.setPoolFee(BASE_MAINNET.WBTC, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW)).wait();
    
    const registry = await ethers.getContractAt("contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry", state.moduleRegistry);
    await (await registry.setSwapModule(state.swapModuleV3)).wait();
    
    state.lastStep = "swapModuleV3";
    saveState(state);
    console.log("✅ SwapModuleV3:", state.swapModuleV3);
  } else {
    console.log("\n[5/7] ✅ SwapModuleV3:", state.swapModuleV3);
  }

  // ========== STEP 6: BuySellModuleV3 ==========
  if (!state.buySellModuleV3) {
    console.log("\n[6/9] Deploying BuySellModuleV3...");
    const BuySellModuleV3 = await ethers.getContractFactory("contracts/v3/mainnet/modules/BuySellModuleV3.sol:BuySellModuleV3");
    const buySellModule = await BuySellModuleV3.deploy(
      state.protocolCore,
      BASE_MAINNET.SWAP_ROUTER,
      state.chainlinkOracle
    );
    await buySellModule.waitForDeployment();
    state.buySellModuleV3 = await buySellModule.getAddress();
    
    await (await buySellModule.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW)).wait();
    await (await buySellModule.setPoolFee(BASE_MAINNET.USDC, BASE_MAINNET.DAI, BASE_MAINNET.POOL_FEE_LOWEST)).wait();
    await (await buySellModule.setPoolFee(BASE_MAINNET.WBTC, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW)).wait();
    
    const registry = await ethers.getContractAt("contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry", state.moduleRegistry);
    await (await registry.setBuySellModule(state.buySellModuleV3)).wait();
    
    state.lastStep = "buySellModuleV3";
    saveState(state);
    console.log("✅ BuySellModuleV3:", state.buySellModuleV3);
  } else {
    console.log("\n[6/9] ✅ BuySellModuleV3:", state.buySellModuleV3);
  }

  // ========== STEP 7: FeeCollector ==========
  if (!state.feeCollector) {
    console.log("\n[7/9] Deploying FeeCollector...");
    const FeeCollector = await ethers.getContractFactory("contracts/v3/mainnet/core/FeeCollector.sol:FeeCollector");
    const feeCollector = await FeeCollector.deploy(state.protocolCore, deployer.address);
    await feeCollector.waitForDeployment();
    state.feeCollector = await feeCollector.getAddress();
    
    state.lastStep = "feeCollector";
    saveState(state);
    console.log("✅ FeeCollector:", state.feeCollector);
  } else {
    console.log("\n[7/9] ✅ FeeCollector:", state.feeCollector);
  }

  // ========== STEP 8: ProtocolMetrics (DeFi Llama) ==========
  if (!state.protocolMetrics) {
    console.log("\n[8/9] Deploying ProtocolMetrics (DeFi Llama compatible)...");
    const ProtocolMetrics = await ethers.getContractFactory("contracts/v3/mainnet/core/ProtocolMetrics.sol:ProtocolMetrics");
    const metrics = await ProtocolMetrics.deploy(state.chainlinkOracle, state.feeCollector);
    await metrics.waitForDeployment();
    state.protocolMetrics = await metrics.getAddress();
    
    await (await metrics.trackToken(BASE_MAINNET.USDC)).wait();
    await (await metrics.trackToken(BASE_MAINNET.WETH)).wait();
    await (await metrics.trackToken(BASE_MAINNET.WBTC)).wait();
    await (await metrics.trackToken(BASE_MAINNET.DAI)).wait();
    
    state.lastStep = "protocolMetrics";
    saveState(state);
    console.log("✅ ProtocolMetrics:", state.protocolMetrics);
  } else {
    console.log("\n[8/9] ✅ ProtocolMetrics:", state.protocolMetrics);
  }

  // ========== STEP 9: Test Vault ==========
  if (!state.testVault) {
    console.log("\n[9/9] Creating Test Vault (IndexSwapV3)...");
    
    const VaultSafe = await ethers.getContractFactory("contracts/v3/mainnet/vault/VaultSafe.sol:VaultSafe");
    const safe = await VaultSafe.deploy(state.protocolCore, [deployer.address], 1);
    await safe.waitForDeployment();
    const safeAddress = await safe.getAddress();
    console.log("  VaultSafe:", safeAddress);
    
    const portfolio = [
      { token: BASE_MAINNET.USDC, weightBps: 5000 },
      { token: BASE_MAINNET.WETH, weightBps: 3000 },
      { token: BASE_MAINNET.WBTC, weightBps: 2000 },
    ];
    
    const IndexSwapV3 = await ethers.getContractFactory("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3");
    const vault = await IndexSwapV3.deploy(
      state.protocolCore,
      safeAddress,
      state.chainlinkOracle,
      BASE_MAINNET.SWAP_ROUTER,
      "Test Index Vault",
      "TIV",
      portfolio,
      0
    );
    await vault.waitForDeployment();
    const vaultAddress = await vault.getAddress();
    
    await (await vault.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.POOL_FEE_LOW)).wait();
    await (await vault.setPoolFee(BASE_MAINNET.WBTC, BASE_MAINNET.POOL_FEE_LOW)).wait();
    await (await vault.setPoolFee(BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOWEST)).wait();
    
    if (state.feeCollector) {
      await (await vault.setFeeCollector(state.feeCollector)).wait();
      console.log("  FeeCollector set on vault");
    }
    
    const metrics = await ethers.getContractAt("contracts/v3/mainnet/core/ProtocolMetrics.sol:ProtocolMetrics", state.protocolMetrics!);
    await (await metrics.registerVault(vaultAddress)).wait();
    console.log("  Vault registered in ProtocolMetrics");
    
    state.testVault = { safe: safeAddress, indexSwap: vaultAddress };
    state.lastStep = "testVault";
    saveState(state);
    console.log("✅ IndexSwapV3:", vaultAddress);
  } else {
    console.log("\n[9/9] ✅ Test Vault already created");
    console.log("  VaultSafe:", state.testVault.safe);
    console.log("  IndexSwapV3:", state.testVault.indexSwap);
  }

  // ========== SUMMARY ==========
  console.log("\n" + "=".repeat(70));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(70));
  
  console.log("\n📦 Core Infrastructure:");
  console.log("  DXPToken:", state.dxpToken);
  console.log("  ProtocolCore:", state.protocolCore);
  console.log("  ChainlinkOracle:", state.chainlinkOracle);
  console.log("  ModuleRegistry:", state.moduleRegistry);
  
  console.log("\n📦 Fee & Metrics (DeFi Llama):");
  console.log("  FeeCollector:", state.feeCollector);
  console.log("  ProtocolMetrics:", state.protocolMetrics);
  
  console.log("\n📦 Modules (V3 - Mainnet Ready):");
  console.log("  SwapModuleV3:", state.swapModuleV3);
  console.log("  BuySellModuleV3:", state.buySellModuleV3);
  
  console.log("\n📦 Test Vault:");
  console.log("  VaultSafe:", state.testVault?.safe);
  console.log("  IndexSwapV3:", state.testVault?.indexSwap);
  
  console.log("\n🔗 External Dependencies (Base Mainnet):");
  console.log("  Uniswap V3 Router:", BASE_MAINNET.SWAP_ROUTER);
  console.log("  Chainlink ETH/USD:", BASE_MAINNET.CHAINLINK_ETH_USD);
  
  console.log("\n📝 DeFi Llama Integration:");
  console.log("  - Call protocolMetrics.getTotalTVL() for total TVL");
  console.log("  - Call protocolMetrics.getTotalFeesCollectedUsd() for total fees");
  console.log("  - Call protocolMetrics.getProtocolStats() for full stats");
  
  console.log("\n💾 Deployment saved to:", getDeploymentPath());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
