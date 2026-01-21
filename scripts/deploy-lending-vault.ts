import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

interface DeploymentState {
  protocolCore?: string;
  moduleRegistry?: string;
  lendModuleV3?: string;
  feeCollector?: string;
  protocolMetrics?: string;
  lendingVault?: {
    safe: string;
    indexSwap: string;
  };
}

function getDeploymentPath(): string {
  return path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
}

function loadState(): DeploymentState {
  const p = getDeploymentPath();
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveState(state: DeploymentState): void {
  fs.writeFileSync(getDeploymentPath(), JSON.stringify(state, null, 2));
  console.log("💾 State saved");
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("DEPLOYING NEW LENDING VAULT (with executeModuleAction)");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  console.log("\nDeployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const state = loadState() as any;
  
  if (!state.protocolCore || !state.moduleRegistry || !state.lendModuleV3) {
    console.log("\n❌ Missing required contracts. Run deployV3-mainnet-v3.ts first.");
    return;
  }

  console.log("\n📦 Using existing contracts:");
  console.log("  ProtocolCore:", state.protocolCore);
  console.log("  ModuleRegistry:", state.moduleRegistry);
  console.log("  LendModuleV3:", state.lendModuleV3);

  if (state.lendingVault) {
    console.log("\n✅ Lending vault already exists:");
    console.log("  VaultSafe:", state.lendingVault.safe);
    console.log("  IndexSwapV3:", state.lendingVault.indexSwap);
    return;
  }

  console.log("\n[1/2] Deploying VaultSafe...");
  const VaultSafe = await ethers.getContractFactory("contracts/v3/mainnet/vault/VaultSafe.sol:VaultSafe");
  const safe = await VaultSafe.deploy(state.protocolCore, [deployer.address], 1);
  await safe.waitForDeployment();
  const safeAddress = await safe.getAddress();
  console.log("  ✅ VaultSafe:", safeAddress);

  console.log("\n[2/2] Deploying IndexSwapV3 (USDC Lending Vault)...");
  const portfolio = [
    { token: BASE_MAINNET.USDC, weightBps: 10000 },
  ];
  
  const IndexSwapV3 = await ethers.getContractFactory("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3");
  const vault = await IndexSwapV3.deploy(
    state.protocolCore,
    safeAddress,
    state.moduleRegistry,
    "USDC Lending Vault",
    "ULV",
    portfolio,
    0
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("  ✅ IndexSwapV3:", vaultAddress);

  console.log("\n  Configuring vault...");
  
  console.log("    Setting lend module...");
  await (await vault.setModules(state.lendModuleV3, ethers.ZeroAddress)).wait();
  
  if (state.feeCollector) {
    console.log("    Setting fee collector...");
    await (await vault.setFeeCollector(state.feeCollector)).wait();
  }

  if (state.protocolMetrics) {
    console.log("    Registering in ProtocolMetrics...");
    const metrics = await ethers.getContractAt(
      "contracts/v3/mainnet/core/ProtocolMetrics.sol:ProtocolMetrics", 
      state.protocolMetrics
    );
    await (await metrics.registerVault(vaultAddress)).wait();
  }

  state.lendingVault = { safe: safeAddress, indexSwap: vaultAddress };
  saveState(state);

  console.log("\n" + "=".repeat(70));
  console.log("✅ LENDING VAULT DEPLOYED");
  console.log("=".repeat(70));
  console.log("\n  VaultSafe:", safeAddress);
  console.log("  IndexSwapV3:", vaultAddress);
  console.log("\n📝 Next steps:");
  console.log("  1. Send USDC to your wallet");
  console.log("  2. Run: npx hardhat run scripts/test-lending-mainnet.ts --network base-mainnet");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
