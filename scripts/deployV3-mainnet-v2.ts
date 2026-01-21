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
};

interface DeploymentState {
  network: string;
  chainId: number;
  deployer: string;
  timestamp: number;
  dxpToken?: string;
  protocolCore?: string;
  chainlinkOracle?: string;
  moduleRegistry?: string;
  swapModuleV3?: string;
  buySellModuleV3?: string;
  feeCollector?: string;
  protocolMetrics?: string;
  testVault?: { safe: string; indexSwap: string };
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
}

async function waitForNonce(signer: any, expectedNonce: number, maxWait = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const currentNonce = await signer.getNonce();
    if (currentNonce >= expectedNonce) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for nonce ${expectedNonce}`);
}

async function deployContract(
  signer: any,
  name: string,
  factoryName: string,
  args: any[] = []
): Promise<string> {
  console.log(`  Deploying ${name}...`);
  
  const nonceBefore = await signer.getNonce();
  const Factory = await ethers.getContractFactory(factoryName, signer);
  const contract = await Factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  
  await waitForNonce(signer, nonceBefore + 1);
  console.log(`  ✅ ${name}: ${address}`);
  return address;
}

async function sendTx(contract: any, method: string, args: any[], signer: any, description: string): Promise<void> {
  const nonceBefore = await signer.getNonce();
  console.log(`    ${description}...`);
  const tx = await contract[method](...args);
  await tx.wait();
  await waitForNonce(signer, nonceBefore + 1);
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("DEXPO V3 - BASE MAINNET DEPLOYMENT (Robust Version)");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  
  console.log("\n📋 Deployment Info:");
  console.log("  Network:", network.name);
  console.log("  ChainId:", chainId);
  console.log("  Deployer:", deployer.address);
  console.log("  Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("  Current Nonce:", await deployer.getNonce());

  if (chainId !== BASE_MAINNET.chainId && process.env.FORCE_DEPLOY !== "true") {
    console.log("\n⚠️  Not on Base Mainnet. Set FORCE_DEPLOY=true to proceed.");
    return;
  }

  let state: DeploymentState = loadState() || {
    network: "base-mainnet",
    chainId,
    deployer: deployer.address,
    timestamp: Date.now(),
  };
  
  if (state.dxpToken) {
    console.log("\n📂 Resuming previous deployment...");
  }

  // ========== STEP 1: DXPToken ==========
  console.log("\n[1/9] DXPToken");
  if (!state.dxpToken) {
    state.dxpToken = await deployContract(deployer, "DXPToken", "DXPToken", []);
    saveState(state);
  } else {
    console.log(`  ✅ Already deployed: ${state.dxpToken}`);
  }

  // ========== STEP 2: ProtocolCore ==========
  console.log("\n[2/9] ProtocolCore");
  if (!state.protocolCore) {
    state.protocolCore = await deployContract(
      deployer,
      "ProtocolCore",
      "ProtocolCore",
      [state.dxpToken, 70, 5, 20]
    );
    saveState(state);
  } else {
    console.log(`  ✅ Already deployed: ${state.protocolCore}`);
  }

  // ========== STEP 3: ChainlinkOracle ==========
  console.log("\n[3/9] ChainlinkOracle");
  if (!state.chainlinkOracle) {
    state.chainlinkOracle = await deployContract(
      deployer,
      "ChainlinkOracle",
      "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
      []
    );
    saveState(state);
    
    const oracle = await ethers.getContractAt(
      "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
      state.chainlinkOracle,
      deployer
    );
    
    const tokens = [BASE_MAINNET.WETH, BASE_MAINNET.WBTC, BASE_MAINNET.USDC, BASE_MAINNET.DAI, BASE_MAINNET.CBETH];
    const feeds = [
      BASE_MAINNET.CHAINLINK_ETH_USD,
      BASE_MAINNET.CHAINLINK_WBTC_USD,
      BASE_MAINNET.CHAINLINK_USDC_USD,
      BASE_MAINNET.CHAINLINK_DAI_USD,
      BASE_MAINNET.CHAINLINK_CBETH_USD,
    ];
    await sendTx(oracle, "setPriceFeeds", [tokens, feeds], deployer, "Setting price feeds");
    saveState(state);
  } else {
    console.log(`  ✅ Already deployed: ${state.chainlinkOracle}`);
  }

  // ========== STEP 4: ModuleRegistry ==========
  console.log("\n[4/9] ModuleRegistry");
  if (!state.moduleRegistry) {
    state.moduleRegistry = await deployContract(
      deployer,
      "ModuleRegistry",
      "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
      []
    );
    saveState(state);
    
    const registry = await ethers.getContractAt(
      "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
      state.moduleRegistry,
      deployer
    );
    await sendTx(registry, "setOracle", [state.chainlinkOracle], deployer, "Setting oracle");
    saveState(state);
  } else {
    console.log(`  ✅ Already deployed: ${state.moduleRegistry}`);
  }

  // ========== STEP 5: SwapModuleV3 ==========
  console.log("\n[5/9] SwapModuleV3");
  if (!state.swapModuleV3) {
    state.swapModuleV3 = await deployContract(
      deployer,
      "SwapModuleV3",
      "contracts/v3/mainnet/modules/SwapModuleV3.sol:SwapModuleV3",
      [state.protocolCore, BASE_MAINNET.SWAP_ROUTER, state.chainlinkOracle]
    );
    saveState(state);
    
    const swapModule = await ethers.getContractAt(
      "contracts/v3/mainnet/modules/SwapModuleV3.sol:SwapModuleV3",
      state.swapModuleV3,
      deployer
    );
    await sendTx(swapModule, "setPoolFee", [BASE_MAINNET.WETH, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW], deployer, "Setting WETH/USDC fee");
    await sendTx(swapModule, "setPoolFee", [BASE_MAINNET.USDC, BASE_MAINNET.DAI, BASE_MAINNET.POOL_FEE_LOWEST], deployer, "Setting USDC/DAI fee");
    await sendTx(swapModule, "setPoolFee", [BASE_MAINNET.WBTC, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW], deployer, "Setting WBTC/USDC fee");
    
    const registry = await ethers.getContractAt(
      "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
      state.moduleRegistry,
      deployer
    );
    await sendTx(registry, "setSwapModule", [state.swapModuleV3], deployer, "Registering in ModuleRegistry");
    saveState(state);
  } else {
    console.log(`  ✅ Already deployed: ${state.swapModuleV3}`);
  }

  // ========== STEP 6: BuySellModuleV3 ==========
  console.log("\n[6/9] BuySellModuleV3");
  if (!state.buySellModuleV3) {
    state.buySellModuleV3 = await deployContract(
      deployer,
      "BuySellModuleV3",
      "contracts/v3/mainnet/modules/BuySellModuleV3.sol:BuySellModuleV3",
      [state.protocolCore, BASE_MAINNET.SWAP_ROUTER, state.chainlinkOracle]
    );
    saveState(state);
    
    const buySellModule = await ethers.getContractAt(
      "contracts/v3/mainnet/modules/BuySellModuleV3.sol:BuySellModuleV3",
      state.buySellModuleV3,
      deployer
    );
    await sendTx(buySellModule, "setPoolFee", [BASE_MAINNET.WETH, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW], deployer, "Setting WETH/USDC fee");
    await sendTx(buySellModule, "setPoolFee", [BASE_MAINNET.USDC, BASE_MAINNET.DAI, BASE_MAINNET.POOL_FEE_LOWEST], deployer, "Setting USDC/DAI fee");
    await sendTx(buySellModule, "setPoolFee", [BASE_MAINNET.WBTC, BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOW], deployer, "Setting WBTC/USDC fee");
    
    const registry = await ethers.getContractAt(
      "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
      state.moduleRegistry,
      deployer
    );
    await sendTx(registry, "setBuySellModule", [state.buySellModuleV3], deployer, "Registering in ModuleRegistry");
    saveState(state);
  } else {
    console.log(`  ✅ Already deployed: ${state.buySellModuleV3}`);
  }

  // ========== STEP 7: FeeCollector ==========
  console.log("\n[7/9] FeeCollector");
  if (!state.feeCollector) {
    state.feeCollector = await deployContract(
      deployer,
      "FeeCollector",
      "contracts/v3/mainnet/core/FeeCollector.sol:FeeCollector",
      [state.protocolCore, deployer.address]
    );
    saveState(state);
  } else {
    console.log(`  ✅ Already deployed: ${state.feeCollector}`);
  }

  // ========== STEP 8: ProtocolMetrics ==========
  console.log("\n[8/9] ProtocolMetrics");
  if (!state.protocolMetrics) {
    state.protocolMetrics = await deployContract(
      deployer,
      "ProtocolMetrics",
      "contracts/v3/mainnet/core/ProtocolMetrics.sol:ProtocolMetrics",
      [state.chainlinkOracle, state.feeCollector]
    );
    saveState(state);
    
    const metrics = await ethers.getContractAt(
      "contracts/v3/mainnet/core/ProtocolMetrics.sol:ProtocolMetrics",
      state.protocolMetrics,
      deployer
    );
    await sendTx(metrics, "trackToken", [BASE_MAINNET.USDC], deployer, "Tracking USDC");
    await sendTx(metrics, "trackToken", [BASE_MAINNET.WETH], deployer, "Tracking WETH");
    await sendTx(metrics, "trackToken", [BASE_MAINNET.WBTC], deployer, "Tracking WBTC");
    await sendTx(metrics, "trackToken", [BASE_MAINNET.DAI], deployer, "Tracking DAI");
    saveState(state);
  } else {
    console.log(`  ✅ Already deployed: ${state.protocolMetrics}`);
  }

  // ========== STEP 9: Test Vault ==========
  console.log("\n[9/9] Test Vault (IndexSwapV3)");
  if (!state.testVault) {
    const safeAddress = await deployContract(
      deployer,
      "VaultSafe",
      "contracts/v3/mainnet/vault/VaultSafe.sol:VaultSafe",
      [state.protocolCore, [deployer.address], 1]
    );
    
    const portfolio = [
      { token: BASE_MAINNET.USDC, weightBps: 5000 },
      { token: BASE_MAINNET.WETH, weightBps: 3000 },
      { token: BASE_MAINNET.WBTC, weightBps: 2000 },
    ];
    
    const vaultAddress = await deployContract(
      deployer,
      "IndexSwapV3",
      "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
      [state.protocolCore, safeAddress, state.moduleRegistry, "Test Index Vault", "TIV", portfolio, 0]
    );
    
    state.testVault = { safe: safeAddress, indexSwap: vaultAddress };
    saveState(state);
    
    const vault = await ethers.getContractAt(
      "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
      vaultAddress,
      deployer
    );
    await sendTx(vault, "setFeeCollector", [state.feeCollector], deployer, "Setting fee collector");
    await sendTx(vault, "setPerformanceFee", [1000], deployer, "Setting 10% performance fee");
    await sendTx(vault, "setVaultOwner", [deployer.address], deployer, "Setting vault owner");
    
    const feeCollector = await ethers.getContractAt(
      "contracts/v3/mainnet/core/FeeCollector.sol:FeeCollector",
      state.feeCollector,
      deployer
    );
    await sendTx(feeCollector, "setAuthorizedVault", [vaultAddress, true], deployer, "Authorizing vault in FeeCollector");
    
    const metrics = await ethers.getContractAt(
      "contracts/v3/mainnet/core/ProtocolMetrics.sol:ProtocolMetrics",
      state.protocolMetrics,
      deployer
    );
    await sendTx(metrics, "registerVault", [vaultAddress], deployer, "Registering vault in ProtocolMetrics");
    saveState(state);
  } else {
    console.log(`  ✅ Already deployed:`);
    console.log(`     VaultSafe: ${state.testVault.safe}`);
    console.log(`     IndexSwapV3: ${state.testVault.indexSwap}`);
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
  
  console.log("\n📦 Modules:");
  console.log("  SwapModuleV3:", state.swapModuleV3);
  console.log("  BuySellModuleV3:", state.buySellModuleV3);
  
  console.log("\n📦 Test Vault:");
  console.log("  VaultSafe:", state.testVault?.safe);
  console.log("  IndexSwapV3:", state.testVault?.indexSwap);
  
  console.log("\n📊 DeFi Llama Integration:");
  console.log("  getTotalTVL() -> Total protocol TVL in USD");
  console.log("  getTotalFeesCollectedUsd() -> Total fees in USD");
  console.log("  getProtocolStats() -> (tvl, fees, vaultCount, tokenCount)");
  
  console.log("\n💾 Deployment saved to:", getDeploymentPath());
  console.log("=".repeat(70) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error.message || error);
    process.exit(1);
  });
