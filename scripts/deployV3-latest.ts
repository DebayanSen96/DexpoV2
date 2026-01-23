import { ethers, network } from "hardhat";
import type { ContractTransactionResponse } from "ethers";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  AAVE_POOL_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  AERODROME_FACTORY: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  CHAINLINK_ETH_USD: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  CHAINLINK_USDC_USD: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
};

interface DeploymentState {
  network: string;
  deployer: string;
  timestamp: number;
  lastStep: string;
  dxpToken?: string;
  protocolCore?: string;
  oracle?: string;
  feeCollector?: string;
  moduleRegistry?: string;
  swapHub?: string;
  lendingHub?: string;
  aerodromeAdapter?: string;
  aaveV3Adapter?: string;
  buySellModule?: string;
  borrowModule?: string;
  stakingModule?: string;
  indexSwapFactory?: string;
  testVault?: {
    safe: string;
    indexSwap: string;
  };
  adapterIds?: {
    aerodrome?: string;
    aaveV3?: string;
  };
}

function getDeploymentPath(networkName: string): string {
  const deploymentsDir = path.join(__dirname, "..", "deployments", "v3-latest");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  return path.join(deploymentsDir, `${networkName}.json`);
}

function loadDeploymentState(networkName: string): DeploymentState | null {
  const deploymentPath = getDeploymentPath(networkName);
  if (!fs.existsSync(deploymentPath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(deploymentPath, "utf8").trim();
    if (!data) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveDeploymentState(networkName: string, state: DeploymentState): void {
  const deploymentPath = getDeploymentPath(networkName);
  fs.writeFileSync(deploymentPath, JSON.stringify(state, null, 2));
  console.log(`💾 State saved`);
}

async function waitForTx<T extends ContractTransactionResponse>(txPromise: Promise<T>): Promise<T> {
  const tx = await txPromise;
  await tx.wait();
  return tx;
}

async function main() {
  const isMainnet = network.name === "base-mainnet";
  const isLocalhost = network.name === "hardhat" || network.name === "localhost";

  const [deployer] = await ethers.getSigners();
  
  console.log("\n" + "=".repeat(70));
  console.log("DEXPO V3 PROTOCOL DEPLOYMENT - HUB + ADAPTER ARCHITECTURE");
  console.log("=".repeat(70));
  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  let state = loadDeploymentState(network.name);
  if (state) {
    console.log("📂 Found existing deployment, last step:", state.lastStep);
    console.log("   To start fresh, delete:", getDeploymentPath(network.name), "\n");
  } else {
    console.log("🆕 Starting fresh deployment...\n");
    state = {
      network: network.name,
      deployer: deployer.address,
      timestamp: Date.now(),
      lastStep: "init"
    };
  }

  // ========== STEP 1: CORE INFRASTRUCTURE ==========
  console.log("=".repeat(70));
  console.log("STEP 1: CORE INFRASTRUCTURE");
  console.log("=".repeat(70));

  // DXPToken
  if (!state.dxpToken) {
    console.log("\n[1.1] Deploying DXPToken...");
    const DXPToken = await ethers.getContractFactory("DXPToken");
    const dxpToken = await DXPToken.deploy();
    await dxpToken.waitForDeployment();
    state.dxpToken = await dxpToken.getAddress();
    console.log("  ✅ DXPToken:", state.dxpToken);
    state.lastStep = "dxpToken";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[1.1] ✅ DXPToken:", state.dxpToken);
  }

  // ProtocolCore
  if (!state.protocolCore) {
    console.log("\n[1.2] Deploying ProtocolCore...");
    const ProtocolCore = await ethers.getContractFactory("ProtocolCore");
    const protocolCore = await ProtocolCore.deploy(state.dxpToken, 70, 10, 30);
    await protocolCore.waitForDeployment();
    state.protocolCore = await protocolCore.getAddress();
    console.log("  ✅ ProtocolCore:", state.protocolCore);
    state.lastStep = "protocolCore";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[1.2] ✅ ProtocolCore:", state.protocolCore);
  }

  // Oracle (ChainlinkOracle for mainnet, MockOracle for testnet)
  if (!state.oracle) {
    console.log("\n[1.3] Deploying Oracle...");
    if (isMainnet) {
      const ChainlinkOracle = await ethers.getContractFactory("contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle");
      const oracle = await ChainlinkOracle.deploy();
      await oracle.waitForDeployment();
      state.oracle = await oracle.getAddress();
      
      console.log("  Setting price feeds...");
      await waitForTx(oracle.setPriceFeed(BASE_MAINNET.USDC, BASE_MAINNET.CHAINLINK_USDC_USD));
      await waitForTx(oracle.setPriceFeed(BASE_MAINNET.WETH, BASE_MAINNET.CHAINLINK_ETH_USD));
      console.log("  ✅ ChainlinkOracle:", state.oracle);
    } else {
      const MockOracle = await ethers.getContractFactory("MockOracle");
      const oracle = await MockOracle.deploy();
      await oracle.waitForDeployment();
      state.oracle = await oracle.getAddress();
      console.log("  ✅ MockOracle:", state.oracle);
    }
    state.lastStep = "oracle";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[1.3] ✅ Oracle:", state.oracle);
  }

  // FeeCollector
  if (!state.feeCollector) {
    console.log("\n[1.4] Deploying FeeCollector...");
    const FeeCollector = await ethers.getContractFactory("contracts/v3/mainnet/core/FeeCollector.sol:FeeCollector");
    const feeCollector = await FeeCollector.deploy(state.protocolCore, deployer.address);
    await feeCollector.waitForDeployment();
    state.feeCollector = await feeCollector.getAddress();
    console.log("  ✅ FeeCollector:", state.feeCollector);
    state.lastStep = "feeCollector";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[1.4] ✅ FeeCollector:", state.feeCollector);
  }

  // ModuleRegistry
  if (!state.moduleRegistry) {
    console.log("\n[1.5] Deploying ModuleRegistry...");
    const ModuleRegistry = await ethers.getContractFactory("contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry");
    const moduleRegistry = await ModuleRegistry.deploy();
    await moduleRegistry.waitForDeployment();
    state.moduleRegistry = await moduleRegistry.getAddress();
    console.log("  ✅ ModuleRegistry:", state.moduleRegistry);
    state.lastStep = "moduleRegistry";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[1.5] ✅ ModuleRegistry:", state.moduleRegistry);
  }

  // ========== STEP 2: SWAP HUB + ADAPTERS ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: SWAP HUB + ADAPTERS");
  console.log("=".repeat(70));

  // SwapHub
  if (!state.swapHub) {
    console.log("\n[2.1] Deploying SwapHub...");
    const SwapHub = await ethers.getContractFactory("contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub");
    const swapHub = await SwapHub.deploy(state.protocolCore, state.oracle);
    await swapHub.waitForDeployment();
    state.swapHub = await swapHub.getAddress();
    console.log("  ✅ SwapHub:", state.swapHub);
    state.lastStep = "swapHub";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[2.1] ✅ SwapHub:", state.swapHub);
  }

  // AerodromeAdapter (mainnet only)
  let aerodromeAdapter: any;
  if (isMainnet && !state.aerodromeAdapter) {
    console.log("\n[2.2] Deploying AerodromeAdapter...");
    const AerodromeAdapter = await ethers.getContractFactory("contracts/v3/mainnet/modules/swap/adapters/AerodromeAdapter.sol:AerodromeAdapter");
    const adapter = await AerodromeAdapter.deploy(BASE_MAINNET.AERODROME_ROUTER, BASE_MAINNET.AERODROME_FACTORY);
    await adapter.waitForDeployment();
    state.aerodromeAdapter = await adapter.getAddress();
    saveDeploymentState(network.name, state);
    aerodromeAdapter = adapter;
    console.log("  ✅ AerodromeAdapter:", state.aerodromeAdapter);
  } else if (state.aerodromeAdapter) {
    console.log("\n[2.2] ✅ AerodromeAdapter:", state.aerodromeAdapter);
    aerodromeAdapter = await ethers.getContractAt("contracts/v3/mainnet/modules/swap/adapters/AerodromeAdapter.sol:AerodromeAdapter", state.aerodromeAdapter);
  } else {
    console.log("\n[2.2] ⏭️  Skipping AerodromeAdapter (not mainnet)");
  }

  // Configure AerodromeAdapter (skip if already registered)
  if (isMainnet && state.aerodromeAdapter && !state.adapterIds?.aerodrome) {
    console.log("\n[2.2b] Configuring AerodromeAdapter...");
    await waitForTx(aerodromeAdapter.setSwapHub(state.swapHub));
    console.log("  ✓ SwapHub set");
    await waitForTx(aerodromeAdapter.configureRoute(BASE_MAINNET.USDC, BASE_MAINNET.WETH, false, true));
    console.log("  ✓ USDC->WETH route");
    await waitForTx(aerodromeAdapter.configureRoute(BASE_MAINNET.WETH, BASE_MAINNET.USDC, false, true));
    console.log("  ✓ WETH->USDC route");
    saveDeploymentState(network.name, state);
  }

  // Register Aerodrome with SwapHub
  if (isMainnet && state.aerodromeAdapter && !state.adapterIds?.aerodrome) {
    console.log("\n[2.3] Registering AerodromeAdapter with SwapHub...");
    const swapHub = await ethers.getContractAt("contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub", state.swapHub);
    const adapterId = ethers.keccak256(ethers.toUtf8Bytes("AERODROME"));
    await waitForTx(swapHub.addAdapter(adapterId, state.aerodromeAdapter));
    
    state.adapterIds = state.adapterIds || {};
    state.adapterIds.aerodrome = adapterId;
    console.log("  ✅ Registered, ID:", adapterId);
    state.lastStep = "aerodromeRegistered";
    saveDeploymentState(network.name, state);
  } else if (state.adapterIds?.aerodrome) {
    console.log("\n[2.3] ✅ AerodromeAdapter registered");
  }

  // ========== STEP 3: LENDING HUB + ADAPTERS ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 3: LENDING HUB + ADAPTERS");
  console.log("=".repeat(70));

  // LendingHub
  if (!state.lendingHub) {
    console.log("\n[3.1] Deploying LendingHub...");
    const LendingHub = await ethers.getContractFactory("contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub");
    const lendingHub = await LendingHub.deploy(state.protocolCore, state.oracle);
    await lendingHub.waitForDeployment();
    state.lendingHub = await lendingHub.getAddress();
    console.log("  ✅ LendingHub:", state.lendingHub);
    state.lastStep = "lendingHub";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[3.1] ✅ LendingHub:", state.lendingHub);
  }

  // AaveV3Adapter (mainnet only)
  let aaveV3Adapter: any;
  if (isMainnet && !state.aaveV3Adapter) {
    console.log("\n[3.2] Deploying AaveV3Adapter...");
    const AaveV3Adapter = await ethers.getContractFactory("contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter");
    const adapter = await AaveV3Adapter.deploy(BASE_MAINNET.AAVE_POOL_PROVIDER);
    await adapter.waitForDeployment();
    state.aaveV3Adapter = await adapter.getAddress();
    saveDeploymentState(network.name, state);
    aaveV3Adapter = adapter;
    console.log("  ✅ AaveV3Adapter:", state.aaveV3Adapter);
  } else if (state.aaveV3Adapter) {
    console.log("\n[3.2] ✅ AaveV3Adapter:", state.aaveV3Adapter);
    aaveV3Adapter = await ethers.getContractAt("contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter", state.aaveV3Adapter);
  } else {
    console.log("\n[3.2] ⏭️  Skipping AaveV3Adapter (not mainnet)");
  }

  // Configure AaveV3Adapter (skip if already registered)
  if (isMainnet && state.aaveV3Adapter && !state.adapterIds?.aaveV3) {
    console.log("\n[3.2b] Configuring AaveV3Adapter...");
    await waitForTx(aaveV3Adapter.setLendingHub(state.lendingHub));
    console.log("  ✓ LendingHub set");
    await waitForTx(aaveV3Adapter.addSupportedToken(BASE_MAINNET.USDC));
    console.log("  ✓ USDC added");
    await waitForTx(aaveV3Adapter.addSupportedToken(BASE_MAINNET.WETH));
    console.log("  ✓ WETH added");
    saveDeploymentState(network.name, state);
  }

  // Register Aave with LendingHub
  if (isMainnet && state.aaveV3Adapter && !state.adapterIds?.aaveV3) {
    console.log("\n[3.3] Registering AaveV3Adapter with LendingHub...");
    const lendingHub = await ethers.getContractAt("contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub", state.lendingHub);
    const adapterId = ethers.keccak256(ethers.toUtf8Bytes("AAVE_V3"));
    await waitForTx(lendingHub.addAdapter(adapterId, state.aaveV3Adapter));
    
    state.adapterIds = state.adapterIds || {};
    state.adapterIds.aaveV3 = adapterId;
    console.log("  ✅ Registered, ID:", adapterId);
    state.lastStep = "aaveRegistered";
    saveDeploymentState(network.name, state);
  } else if (state.adapterIds?.aaveV3) {
    console.log("\n[3.3] ✅ AaveV3Adapter registered");
  }

  // ========== STEP 4: OTHER MODULES ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 4: OTHER MODULES");
  console.log("=".repeat(70));

  // BuySellModule (uses SwapHub internally)
  if (!state.buySellModule) {
    console.log("\n[4.1] Deploying BuySellModule...");
    const BuySellModule = await ethers.getContractFactory("contracts/v3/modules/BuySellModule.sol:BuySellModule");
    const buySellModule = await BuySellModule.deploy(state.protocolCore, state.swapHub);
    await buySellModule.waitForDeployment();
    state.buySellModule = await buySellModule.getAddress();
    console.log("  ✅ BuySellModule:", state.buySellModule);
    state.lastStep = "buySellModule";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[4.1] ✅ BuySellModule:", state.buySellModule);
  }

  // BorrowModule
  if (!state.borrowModule) {
    console.log("\n[4.2] Deploying BorrowModule...");
    const BorrowModule = await ethers.getContractFactory("contracts/v3/modules/BorrowModule.sol:BorrowModule");
    const borrowModule = await BorrowModule.deploy(state.protocolCore, state.swapHub);
    await borrowModule.waitForDeployment();
    state.borrowModule = await borrowModule.getAddress();
    console.log("  ✅ BorrowModule:", state.borrowModule);
    state.lastStep = "borrowModule";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[4.2] ✅ BorrowModule:", state.borrowModule);
  }

  // ========== STEP 5: REGISTER MODULES ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 5: REGISTER MODULES IN REGISTRY");
  console.log("=".repeat(70));

  const moduleRegistry = await ethers.getContractAt("contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry", state.moduleRegistry);
  
  const currentSwap = await moduleRegistry.getSwapModule();
  if (currentSwap === ethers.ZeroAddress) {
    console.log("\n[5.1] Registering modules...");
    await waitForTx(moduleRegistry.setSwapModule(state.swapHub));
    console.log("  ✓ SwapHub registered as swap module");
    
    await waitForTx(moduleRegistry.setBuySellModule(state.buySellModule));
    console.log("  ✓ BuySellModule registered");
    
    await waitForTx(moduleRegistry.setLendModule(state.lendingHub));
    console.log("  ✓ LendingHub registered as lend module");
    
    await waitForTx(moduleRegistry.setBorrowModule(state.borrowModule));
    console.log("  ✓ BorrowModule registered");
    
    await waitForTx(moduleRegistry.setOracle(state.oracle));
    console.log("  ✓ Oracle registered");
    
    state.lastStep = "modulesRegistered";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[5.1] ✅ Modules already registered");
  }

  // ========== STEP 6: FACTORY ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 6: INDEX SWAP FACTORY");
  console.log("=".repeat(70));

  if (!state.indexSwapFactory) {
    console.log("\n[6.1] Deploying IndexSwapFactory...");
    const IndexSwapFactory = await ethers.getContractFactory("IndexSwapFactory");
    const factory = await IndexSwapFactory.deploy(state.protocolCore, state.moduleRegistry, state.swapHub);
    await factory.waitForDeployment();
    state.indexSwapFactory = await factory.getAddress();
    console.log("  ✅ IndexSwapFactory:", state.indexSwapFactory);
    
    console.log("\n[6.2] Registering factory with ProtocolCore...");
    const protocolCore = await ethers.getContractAt("ProtocolCore", state.protocolCore);
    await waitForTx(protocolCore.setIndexSwapFactory(state.indexSwapFactory));
    console.log("  ✅ Factory registered");
    
    state.lastStep = "indexSwapFactory";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\n[6.1] ✅ IndexSwapFactory:", state.indexSwapFactory);
  }

  // ========== STEP 7: TEST VAULT ==========
  console.log("\n" + "=".repeat(70));
  console.log("STEP 7: CREATE TEST VAULT");
  console.log("=".repeat(70));

  if (!state.testVault && isMainnet) {
    console.log("\n[7.1] Deploying VaultSafe...");
    const VaultSafe = await ethers.getContractFactory("contracts/v3/mainnet/vault/VaultSafe.sol:VaultSafe");
    const vaultSafe = await VaultSafe.deploy(state.protocolCore, [deployer.address], 1);
    await vaultSafe.waitForDeployment();
    const safeAddress = await vaultSafe.getAddress();
    console.log("  ✅ VaultSafe:", safeAddress);

    console.log("\n[7.2] Deploying IndexSwapV3...");
    const IndexSwapV3 = await ethers.getContractFactory("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3");
    const vault = await IndexSwapV3.deploy(
      state.protocolCore,
      safeAddress,
      state.moduleRegistry,
      "Test Vault V3",
      "TV3",
      [{ token: BASE_MAINNET.USDC, weightBps: 10000 }],
      0
    );
    await vault.waitForDeployment();
    const vaultAddress = await vault.getAddress();
    console.log("  ✅ IndexSwapV3:", vaultAddress);

    console.log("\n[7.3] Configuring vault...");
    await waitForTx(vault.setModules(state.lendingHub, ethers.ZeroAddress));
    await waitForTx(vault.setFeeCollector(state.feeCollector));
    await waitForTx(vault.setPerformanceFee(1000));
    await waitForTx(vault.setVaultOwner(deployer.address));
    console.log("  ✅ Vault configured");

    state.testVault = { safe: safeAddress, indexSwap: vaultAddress };
    state.lastStep = "testVault";
    saveDeploymentState(network.name, state);
  } else if (state.testVault) {
    console.log("\n[7.1] ✅ VaultSafe:", state.testVault.safe);
    console.log("[7.2] ✅ IndexSwapV3:", state.testVault.indexSwap);
  } else {
    console.log("\n[7.1] ⏭️  Skipping test vault (not mainnet)");
  }

  // ========== DEPLOYMENT SUMMARY ==========
  console.log("\n" + "=".repeat(70));
  console.log("✅ DEPLOYMENT COMPLETE");
  console.log("=".repeat(70));

  console.log("\n📋 Core Infrastructure:");
  console.log("  DXPToken:", state.dxpToken);
  console.log("  ProtocolCore:", state.protocolCore);
  console.log("  Oracle:", state.oracle);
  console.log("  FeeCollector:", state.feeCollector);
  console.log("  ModuleRegistry:", state.moduleRegistry);

  console.log("\n📋 Swap System (Hub + Adapter):");
  console.log("  SwapHub:", state.swapHub);
  console.log("  AerodromeAdapter:", state.aerodromeAdapter || "N/A");

  console.log("\n📋 Lending System (Hub + Adapter):");
  console.log("  LendingHub:", state.lendingHub);
  console.log("  AaveV3Adapter:", state.aaveV3Adapter || "N/A");

  console.log("\n📋 Other Modules:");
  console.log("  BuySellModule:", state.buySellModule);
  console.log("  BorrowModule:", state.borrowModule);

  console.log("\n📋 Factory:");
  console.log("  IndexSwapFactory:", state.indexSwapFactory);

  if (state.testVault) {
    console.log("\n📋 Test Vault:");
    console.log("  VaultSafe:", state.testVault.safe);
    console.log("  IndexSwapV3:", state.testVault.indexSwap);
  }

  console.log("\n📋 Adapter IDs:");
  console.log("  Aerodrome:", state.adapterIds?.aerodrome || "N/A");
  console.log("  AaveV3:", state.adapterIds?.aaveV3 || "N/A");

  console.log("\n💾 State saved to:", getDeploymentPath(network.name));

  console.log("\n" + "=".repeat(70));
  console.log("ARCHITECTURE BENEFITS:");
  console.log("=".repeat(70));
  console.log("✓ Hubs hold all accounting state (never need redeployment)");
  console.log("✓ Adapters are stateless (can be upgraded without losing data)");
  console.log("✓ New protocols added by deploying new adapters");
  console.log("✓ Users can choose which venue to use (Aave, Moonwell, etc.)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
