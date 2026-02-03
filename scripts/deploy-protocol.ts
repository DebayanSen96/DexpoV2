import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  AAVE_POOL_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  AERODROME_FACTORY: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  UNISWAP_SWAP_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
  UNISWAP_QUOTER: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  CHAINLINK_USDC_USD: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  CHAINLINK_ETH_USD: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
};

interface DeploymentState {
  deployer?: string;
  dxpToken?: string;
  protocolCore?: string;
  chainlinkOracle?: string;
  feeCollector?: string;
  moduleRegistry?: string;
  swapHub?: string;
  aerodromeAdapter?: string;
  uniswapV3Adapter?: string;
  lendingHub?: string;
  aaveV3Adapter?: string;
  indexSwapImplementation?: string;
  indexSwapFactory?: string;
  adapterIds?: {
    aerodrome?: string;
    uniswapV3?: string;
    aaveV3?: string;
  };
  testVault?: {
    safe: string;
    indexSwap: string;
  };
  lastStep?: string;
  timestamp?: string;
}

function getStatePath(): string {
  const deploymentsDir = path.join(__dirname, "..", "deployments", "v3-latest");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  return path.join(deploymentsDir, `${network.name}.json`);
}

function loadState(): DeploymentState {
  const statePath = getStatePath();
  if (fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  }
  return {};
}

function saveState(state: DeploymentState): void {
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

async function waitForNonce(deployer: any, expectedNonce: number, maxRetries = 10): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const currentNonce = await deployer.getNonce();
    if (currentNonce >= expectedNonce) return;
    console.log(`  ⏳ Waiting for nonce ${expectedNonce} (current: ${currentNonce})...`);
    await delay(2000);
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deployContract(
  deployer: any,
  name: string,
  factoryPath: string,
  args: any[],
  state: DeploymentState,
  stateKey: keyof DeploymentState
): Promise<string> {
  if (state[stateKey]) {
    console.log(`  ✓ ${name} already deployed: ${state[stateKey]}`);
    return state[stateKey] as string;
  }

  const nonceBefore = await deployer.getNonce();
  console.log(`  Deploying ${name}... (nonce: ${nonceBefore})`);

  const Factory = await ethers.getContractFactory(factoryPath);
  const contract = await Factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`  ✅ ${name}: ${address}`);

  (state as any)[stateKey] = address;
  saveState(state);

  await waitForNonce(deployer, nonceBefore + 1);
  await delay(1500);

  return address;
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("DEXPONENT PROTOCOL - FULL DEPLOYMENT");
  console.log("=".repeat(70));
  console.log("Network:", network.name);
  console.log("Timestamp:", new Date().toISOString());

  const [deployer] = await ethers.getSigners();
  console.log("\nDeployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  let state = loadState();
  state.deployer = deployer.address;
  state.timestamp = new Date().toISOString();
  saveState(state);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: DXP Token
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[1/12] DXP Token");
  const dxpToken = await deployContract(
    deployer,
    "DXPToken",
    "contracts/DXPToken.sol:DXPToken",
    [],
    state,
    "dxpToken"
  );

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: Protocol Core
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[2/12] Protocol Core");
  const protocolCore = await deployContract(
    deployer,
    "ProtocolCore",
    "contracts/ProtocolCore.sol:ProtocolCore",
    [dxpToken, 100, 10, 20],
    state,
    "protocolCore"
  );

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: Chainlink Oracle
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[3/12] Chainlink Oracle");
  const chainlinkOracle = await deployContract(
    deployer,
    "ChainlinkOracle",
    "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    [],
    state,
    "chainlinkOracle"
  );

  if (state.lastStep !== "oracleConfigured" && state.lastStep !== "feeCollector") {
    console.log("  Configuring price feeds...");
    const oracle = await ethers.getContractAt(
      "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
      chainlinkOracle
    );
    
    let nonce = await deployer.getNonce();
    await (await oracle.setPriceFeeds(
      [BASE_MAINNET.USDC, BASE_MAINNET.WETH],
      [BASE_MAINNET.CHAINLINK_USDC_USD, BASE_MAINNET.CHAINLINK_ETH_USD]
    )).wait();
    console.log("  ✅ Price feeds configured");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    const ONE_DAY = 24 * 60 * 60;
    await (await oracle.setStaleThreshold(BASE_MAINNET.USDC, ONE_DAY)).wait();
    console.log("  ✅ USDC stale threshold set to 24 hours");
    
    state.lastStep = "oracleConfigured";
    saveState(state);
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: Fee Collector
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[4/12] Fee Collector");
  const feeCollector = await deployContract(
    deployer,
    "FeeCollector",
    "contracts/v3/mainnet/core/FeeCollector.sol:FeeCollector",
    [protocolCore, deployer.address],
    state,
    "feeCollector"
  );

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: Module Registry
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[5/12] Module Registry");
  const moduleRegistry = await deployContract(
    deployer,
    "ModuleRegistry",
    "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
    [],
    state,
    "moduleRegistry"
  );

  if (state.lastStep !== "registryOracleSet" && !state.swapHub) {
    console.log("  Setting oracle in registry...");
    const registry = await ethers.getContractAt(
      "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
      moduleRegistry
    );
    
    const nonce = await deployer.getNonce();
    await (await registry.setOracle(chainlinkOracle)).wait();
    console.log("  ✅ Oracle set in registry");
    
    state.lastStep = "registryOracleSet";
    saveState(state);
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 6: Swap Hub
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[6/12] Swap Hub");
  const swapHub = await deployContract(
    deployer,
    "SwapHub",
    "contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub",
    [protocolCore, chainlinkOracle],
    state,
    "swapHub"
  );

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 7: Aerodrome Adapter
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[7/12] Aerodrome Adapter");
  const aerodromeAdapter = await deployContract(
    deployer,
    "AerodromeAdapter",
    "contracts/v3/mainnet/modules/swap/adapters/AerodromeAdapter.sol:AerodromeAdapter",
    [BASE_MAINNET.AERODROME_ROUTER, BASE_MAINNET.AERODROME_FACTORY],
    state,
    "aerodromeAdapter"
  );

  state.adapterIds = state.adapterIds || {};
  const AERODROME_ADAPTER_ID = ethers.keccak256(ethers.toUtf8Bytes("AERODROME"));

  if (!state.adapterIds.aerodrome) {
    console.log("  Configuring Aerodrome adapter...");
    
    const adapter = await ethers.getContractAt(
      "contracts/v3/mainnet/modules/swap/adapters/AerodromeAdapter.sol:AerodromeAdapter",
      aerodromeAdapter
    );
    const hub = await ethers.getContractAt(
      "contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub",
      swapHub
    );

    let nonce = await deployer.getNonce();
    await (await adapter.setSwapHub(swapHub)).wait();
    console.log("  ✅ SwapHub set on adapter");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await adapter.configureRoute(BASE_MAINNET.USDC, BASE_MAINNET.WETH, false, true)).wait();
    console.log("  ✅ USDC->WETH route configured");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await adapter.configureRoute(BASE_MAINNET.WETH, BASE_MAINNET.USDC, false, true)).wait();
    console.log("  ✅ WETH->USDC route configured");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await hub.addAdapter(AERODROME_ADAPTER_ID, aerodromeAdapter)).wait();
    console.log("  ✅ Adapter added to SwapHub");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await hub.setDefaultAdapter(AERODROME_ADAPTER_ID)).wait();
    console.log("  ✅ Set as default adapter");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    state.adapterIds.aerodrome = AERODROME_ADAPTER_ID;
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 8: Uniswap V3 Adapter
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[8/14] Uniswap V3 Adapter");
  const uniswapV3Adapter = await deployContract(
    deployer,
    "UniswapV3Adapter",
    "contracts/v3/mainnet/modules/swap/adapters/UniswapV3Adapter.sol:UniswapV3Adapter",
    [BASE_MAINNET.UNISWAP_SWAP_ROUTER, BASE_MAINNET.UNISWAP_QUOTER],
    state,
    "uniswapV3Adapter"
  );

  const UNISWAP_ADAPTER_ID = ethers.keccak256(ethers.toUtf8Bytes("UNISWAP_V3"));

  if (!state.adapterIds?.uniswapV3) {
    console.log("  Configuring Uniswap V3 adapter...");
    
    const adapter = await ethers.getContractAt(
      "contracts/v3/mainnet/modules/swap/adapters/UniswapV3Adapter.sol:UniswapV3Adapter",
      uniswapV3Adapter
    );
    const hub = await ethers.getContractAt(
      "contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub",
      swapHub
    );

    let nonce = await deployer.getNonce();
    await (await adapter.setSwapHub(swapHub)).wait();
    console.log("  ✅ SwapHub set on adapter");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await adapter.configurePool(BASE_MAINNET.USDC, BASE_MAINNET.WETH, 500, true)).wait();
    console.log("  ✅ USDC->WETH pool configured (0.05% fee)");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await adapter.configurePool(BASE_MAINNET.WETH, BASE_MAINNET.USDC, 500, true)).wait();
    console.log("  ✅ WETH->USDC pool configured (0.05% fee)");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await hub.addAdapter(UNISWAP_ADAPTER_ID, uniswapV3Adapter)).wait();
    console.log("  ✅ Adapter added to SwapHub");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    state.adapterIds = state.adapterIds || {};
    state.adapterIds.uniswapV3 = UNISWAP_ADAPTER_ID;
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 9: Lending Hub
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[9/14] Lending Hub");
  const lendingHub = await deployContract(
    deployer,
    "LendingHub",
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    [protocolCore, chainlinkOracle],
    state,
    "lendingHub"
  );

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 10: Aave V3 Adapter
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[10/14] Aave V3 Adapter");
  const aaveV3Adapter = await deployContract(
    deployer,
    "AaveV3Adapter",
    "contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter",
    [BASE_MAINNET.AAVE_POOL_PROVIDER],
    state,
    "aaveV3Adapter"
  );

  const AAVE_ADAPTER_ID = ethers.keccak256(ethers.toUtf8Bytes("AAVE_V3"));

  if (!state.adapterIds?.aaveV3) {
    console.log("  Configuring Aave V3 adapter...");
    
    const adapter = await ethers.getContractAt(
      "contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter",
      aaveV3Adapter
    );
    const hub = await ethers.getContractAt(
      "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
      lendingHub
    );

    let nonce = await deployer.getNonce();
    await (await adapter.setLendingHub(lendingHub)).wait();
    console.log("  ✅ LendingHub set on adapter");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await adapter.addSupportedToken(BASE_MAINNET.USDC)).wait();
    console.log("  ✅ USDC added as supported token");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await adapter.addSupportedToken(BASE_MAINNET.WETH)).wait();
    console.log("  ✅ WETH added as supported token");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await hub.addAdapter(AAVE_ADAPTER_ID, aaveV3Adapter)).wait();
    console.log("  ✅ Adapter added to LendingHub");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    state.adapterIds = state.adapterIds || {};
    state.adapterIds.aaveV3 = AAVE_ADAPTER_ID;
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 11: Register Modules in Registry
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[11/14] Registering modules in ModuleRegistry");
  
  if (state.lastStep !== "modulesRegistered" && !state.indexSwapFactory) {
    const registry = await ethers.getContractAt(
      "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
      moduleRegistry
    );

    let nonce = await deployer.getNonce();
    await (await registry.setSwapModule(swapHub)).wait();
    console.log("  ✅ SwapHub registered as swap module");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await registry.setLendModule(lendingHub)).wait();
    console.log("  ✅ LendingHub registered as lend module");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    state.lastStep = "modulesRegistered";
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 12: IndexSwapV3 Implementation (for clone pattern)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[12/15] IndexSwapV3 Implementation");
  const indexSwapImplementation = await deployContract(
    deployer,
    "IndexSwapV3 (Implementation)",
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    [],
    state,
    "indexSwapImplementation"
  );

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 13: Index Swap Factory
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[13/15] Index Swap Factory");
  const indexSwapFactory = await deployContract(
    deployer,
    "IndexSwapFactory",
    "contracts/v3/factories/IndexSwapFactory.sol:IndexSwapFactory",
    [protocolCore, moduleRegistry, indexSwapImplementation, feeCollector],
    state,
    "indexSwapFactory"
  );

  if (state.lastStep !== "factoryRegistered" && !state.testVault) {
    console.log("  Registering factory in ProtocolCore...");
    const core = await ethers.getContractAt(
      "contracts/ProtocolCore.sol:ProtocolCore",
      protocolCore
    );

    let nonce = await deployer.getNonce();
    await (await core.setIndexSwapFactory(indexSwapFactory)).wait();
    console.log("  ✅ Factory registered in ProtocolCore");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    nonce = await deployer.getNonce();
    await (await core.setFeeCollector(feeCollector)).wait();
    console.log("  ✅ FeeCollector registered in ProtocolCore");
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);

    state.lastStep = "factoryRegistered";
    saveState(state);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 14: Deploy Test Vault via ProtocolCore
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n[14/15] Test Vault via ProtocolCore");
  
  if (!state.testVault) {
    const core = await ethers.getContractAt(
      "contracts/ProtocolCore.sol:ProtocolCore",
      protocolCore
    );
    
    const portfolio = [
      { token: BASE_MAINNET.USDC, weightBps: 5000 },
      { token: BASE_MAINNET.WETH, weightBps: 5000 },
    ];
    
    console.log("  Creating vault via ProtocolCore.createIndexSwapVault()...");
    let nonce = await deployer.getNonce();
    
    const tx = await core.createIndexSwapVault(
      deployer.address,
      "Test Index Vault",
      "TIV",
      portfolio,
      0,
      1000
    );
    const receipt = await tx.wait();
    
    const vaultCreatedEvent = receipt?.logs.find((log: any) => {
      try {
        const parsed = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
        return parsed?.name === "IndexSwapVaultCreated";
      } catch { return false; }
    });
    
    let vaultAddress: string;
    if (vaultCreatedEvent) {
      const parsed = core.interface.parseLog({ 
        topics: vaultCreatedEvent.topics as string[], 
        data: vaultCreatedEvent.data 
      });
      vaultAddress = parsed?.args[1];
    } else {
      const factory = await ethers.getContractAt(
        "contracts/v3/factories/IndexSwapFactory.sol:IndexSwapFactory",
        indexSwapFactory
      );
      const vaultCount = await factory.vaultCount();
      vaultAddress = await factory.vaults(vaultCount - 1n);
    }
    
    console.log("  ✅ IndexSwapV3 (clone):", vaultAddress);
    
    state.testVault = {
      safe: deployer.address,
      indexSwap: vaultAddress,
    };
    saveState(state);
    
    await waitForNonce(deployer, nonce + 1);
    await delay(1500);
  }

  state.lastStep = "complete";
  saveState(state);

  // ═══════════════════════════════════════════════════════════════════════
  // DEPLOYMENT SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(70));
  console.log("\n📦 Core Contracts:");
  console.log("  DXPToken:        ", state.dxpToken);
  console.log("  ProtocolCore:    ", state.protocolCore);
  console.log("  ChainlinkOracle: ", state.chainlinkOracle);
  console.log("  FeeCollector:    ", state.feeCollector);
  console.log("  ModuleRegistry:  ", state.moduleRegistry);
  
  console.log("\n📦 Swap Infrastructure:");
  console.log("  SwapHub:          ", state.swapHub);
  console.log("  AerodromeAdapter: ", state.aerodromeAdapter);
  console.log("  Aerodrome ID:     ", state.adapterIds?.aerodrome);
  console.log("  UniswapV3Adapter: ", state.uniswapV3Adapter);
  console.log("  Uniswap ID:       ", state.adapterIds?.uniswapV3);
  
  console.log("\n📦 Lending Infrastructure:");
  console.log("  LendingHub:      ", state.lendingHub);
  console.log("  AaveV3Adapter:   ", state.aaveV3Adapter);
  console.log("  Adapter ID:      ", state.adapterIds?.aaveV3);
  
  console.log("\n📦 Factory & Implementation:");
  console.log("  IndexSwapV3 Impl:", state.indexSwapImplementation);
  console.log("  IndexSwapFactory:", state.indexSwapFactory);
  
  console.log("\n📦 Test Vault:");
  console.log("  VaultOwner:      ", state.testVault?.safe);
  console.log("  IndexSwapV3:     ", state.testVault?.indexSwap);
  
  console.log("\n✅ State saved to:", getStatePath());
  console.log("=".repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
