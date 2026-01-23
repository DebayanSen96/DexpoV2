import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  AAVE_POOL_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  AERODROME_FACTORY: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
};

function getStatePath(): string {
  const deploymentsDir = path.join(__dirname, "..", "deployments", "v3-latest");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  return path.join(deploymentsDir, `${network.name}.json`);
}

async function main() {
  const isMainnet = network.name === "base-mainnet";
  
  console.log("\n" + "=".repeat(70));
  console.log("DEPLOYING HUB + ADAPTER ARCHITECTURE");
  console.log("=".repeat(70));
  console.log("Network:", network.name);

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  let state: any = {};
  const statePath = getStatePath();
  
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    console.log("📂 Loaded existing state\n");
  }

  const protocolCoreAddress = state.protocolCore;
  const oracleAddress = state.oracle || state.chainlinkOracle;
  
  if (!protocolCoreAddress) {
    console.log("❌ ProtocolCore not found. Deploy base infrastructure first.");
    return;
  }

  console.log("ProtocolCore:", protocolCoreAddress);
  console.log("Oracle:", oracleAddress);

  console.log("\n" + "=".repeat(70));
  console.log("STEP 1: DEPLOY LENDING HUB");
  console.log("=".repeat(70));

  let lendingHubAddress = state.lendingHub;
  if (!lendingHubAddress) {
    const LendingHub = await ethers.getContractFactory("contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub");
    const lendingHub = await LendingHub.deploy(protocolCoreAddress, oracleAddress);
    await lendingHub.waitForDeployment();
    lendingHubAddress = await lendingHub.getAddress();
    console.log("✅ LendingHub deployed:", lendingHubAddress);
    
    state.lendingHub = lendingHubAddress;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } else {
    console.log("✅ LendingHub already deployed:", lendingHubAddress);
  }

  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: DEPLOY AAVE V3 ADAPTER");
  console.log("=".repeat(70));

  let aaveAdapterAddress = state.aaveV3Adapter;
  if (!aaveAdapterAddress) {
    const poolProvider = isMainnet ? BASE_MAINNET.AAVE_POOL_PROVIDER : ethers.ZeroAddress;
    
    if (poolProvider === ethers.ZeroAddress) {
      console.log("⚠️ Skipping AaveV3Adapter (no pool provider for this network)");
    } else {
      const AaveV3Adapter = await ethers.getContractFactory("contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter");
      const aaveAdapter = await AaveV3Adapter.deploy(poolProvider);
      await aaveAdapter.waitForDeployment();
      aaveAdapterAddress = await aaveAdapter.getAddress();
      console.log("✅ AaveV3Adapter deployed:", aaveAdapterAddress);

      console.log("   Setting LendingHub...");
      await (await aaveAdapter.setLendingHub(lendingHubAddress)).wait();
      
      console.log("   Adding supported tokens...");
      await (await aaveAdapter.addSupportedToken(BASE_MAINNET.USDC)).wait();
      console.log("   ✓ USDC added");
      await (await aaveAdapter.addSupportedToken(BASE_MAINNET.WETH)).wait();
      console.log("   ✓ WETH added");

      state.aaveV3Adapter = aaveAdapterAddress;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  } else {
    console.log("✅ AaveV3Adapter already deployed:", aaveAdapterAddress);
  }

  console.log("\n" + "=".repeat(70));
  console.log("STEP 3: REGISTER AAVE ADAPTER WITH HUB");
  console.log("=".repeat(70));

  if (aaveAdapterAddress && !state.aaveAdapterRegistered) {
    const lendingHub = await ethers.getContractAt("contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub", lendingHubAddress);
    
    const adapterId = ethers.keccak256(ethers.toUtf8Bytes("AAVE_V3"));
    console.log("Adapter ID:", adapterId);
    
    await (await lendingHub.addAdapter(adapterId, aaveAdapterAddress)).wait();
    console.log("✅ AaveV3Adapter registered with LendingHub");
    
    state.aaveAdapterRegistered = true;
    state.aaveAdapterId = adapterId;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } else if (state.aaveAdapterRegistered) {
    console.log("✅ AaveV3Adapter already registered");
  }

  console.log("\n" + "=".repeat(70));
  console.log("STEP 4: DEPLOY SWAP HUB");
  console.log("=".repeat(70));

  let swapHubAddress = state.swapHub;
  if (!swapHubAddress) {
    const SwapHub = await ethers.getContractFactory("contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub");
    const swapHub = await SwapHub.deploy(protocolCoreAddress, oracleAddress);
    await swapHub.waitForDeployment();
    swapHubAddress = await swapHub.getAddress();
    console.log("✅ SwapHub deployed:", swapHubAddress);
    
    state.swapHub = swapHubAddress;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } else {
    console.log("✅ SwapHub already deployed:", swapHubAddress);
  }

  console.log("\n" + "=".repeat(70));
  console.log("STEP 5: DEPLOY AERODROME ADAPTER");
  console.log("=".repeat(70));

  let aerodromeAdapterAddress = state.aerodromeAdapter;
  if (!aerodromeAdapterAddress) {
    if (!isMainnet) {
      console.log("⚠️ Skipping AerodromeAdapter (not on mainnet)");
    } else {
      const AerodromeAdapter = await ethers.getContractFactory("contracts/v3/mainnet/modules/swap/adapters/AerodromeAdapter.sol:AerodromeAdapter");
      const aerodromeAdapter = await AerodromeAdapter.deploy(
        BASE_MAINNET.AERODROME_ROUTER,
        BASE_MAINNET.AERODROME_FACTORY
      );
      await aerodromeAdapter.waitForDeployment();
      aerodromeAdapterAddress = await aerodromeAdapter.getAddress();
      console.log("✅ AerodromeAdapter deployed:", aerodromeAdapterAddress);

      console.log("   Setting SwapHub...");
      await (await aerodromeAdapter.setSwapHub(swapHubAddress)).wait();
      
      console.log("   Configuring routes...");
      await (await aerodromeAdapter.configureRoute(BASE_MAINNET.USDC, BASE_MAINNET.WETH, false, true)).wait();
      console.log("   ✓ USDC -> WETH (volatile)");
      await (await aerodromeAdapter.configureRoute(BASE_MAINNET.WETH, BASE_MAINNET.USDC, false, true)).wait();
      console.log("   ✓ WETH -> USDC (volatile)");

      state.aerodromeAdapter = aerodromeAdapterAddress;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  } else {
    console.log("✅ AerodromeAdapter already deployed:", aerodromeAdapterAddress);
  }

  console.log("\n" + "=".repeat(70));
  console.log("STEP 6: REGISTER AERODROME ADAPTER WITH HUB");
  console.log("=".repeat(70));

  if (aerodromeAdapterAddress && !state.aerodromeAdapterRegistered) {
    const swapHub = await ethers.getContractAt("contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub", swapHubAddress);
    
    const adapterId = ethers.keccak256(ethers.toUtf8Bytes("AERODROME"));
    console.log("Adapter ID:", adapterId);
    
    await (await swapHub.addAdapter(adapterId, aerodromeAdapterAddress)).wait();
    console.log("✅ AerodromeAdapter registered with SwapHub");
    
    state.aerodromeAdapterRegistered = true;
    state.aerodromeAdapterId = adapterId;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } else if (state.aerodromeAdapterRegistered) {
    console.log("✅ AerodromeAdapter already registered");
  }

  console.log("\n" + "=".repeat(70));
  console.log("STEP 7: UPDATE MODULE REGISTRY");
  console.log("=".repeat(70));

  if (state.moduleRegistry) {
    const moduleRegistry = await ethers.getContractAt("ModuleRegistry", state.moduleRegistry);
    
    console.log("Updating ModuleRegistry with new Hubs...");
    await (await moduleRegistry.setSwapModule(swapHubAddress)).wait();
    console.log("✓ SwapHub set as swap module");
    
    await (await moduleRegistry.setLendModule(lendingHubAddress)).wait();
    console.log("✓ LendingHub set as lend module");
    
    state.hubArchitectureDeployed = true;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ HUB + ADAPTER ARCHITECTURE DEPLOYED");
  console.log("=".repeat(70));
  
  console.log("\n📦 Deployed Contracts:");
  console.log("  LendingHub:", lendingHubAddress);
  console.log("  AaveV3Adapter:", aaveAdapterAddress || "N/A");
  console.log("  SwapHub:", swapHubAddress);
  console.log("  AerodromeAdapter:", aerodromeAdapterAddress || "N/A");
  
  console.log("\n📋 Architecture Benefits:");
  console.log("  ✓ Accounting data persists in Hubs (never need redeployment)");
  console.log("  ✓ Adapters can be upgraded without losing state");
  console.log("  ✓ New protocols can be added by deploying new adapters");
  console.log("  ✓ Users can choose which protocol to use (Aave, Moonwell, etc.)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
