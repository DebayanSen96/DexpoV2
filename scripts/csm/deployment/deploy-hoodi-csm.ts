import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const HOODI = {
  CS_MODULE:    "0x79CEf36D84743222f37765204Bec41E92a93E59d",
  CS_ACCOUNTING:"0xA54b90BA34C5f326BC1485054080994e38FB4C60",
  ETH_PRICE_USD: ethers.parseEther("2000"), // $2000/ETH fixed mock price
};

const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

interface State {
  deployer?: string;
  mockWETH?: string;
  mockOracle?: string;
  protocolCore?: string;
  feeCollector?: string;
  moduleRegistry?: string;
  indexSwapImplementation?: string;
  indexSwapFactory?: string;
  lidoCSMAdapter?: string;
  csmVault?: string;
  timestamp?: string;
}

function getStatePath(): string {
  const dir = path.join(__dirname, "..", "deployments", "v3-latest");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${network.name}.json`);
}

function loadState(): State {
  const p = getStatePath();
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
}

function saveState(s: State) {
  fs.writeFileSync(getStatePath(), JSON.stringify(s, null, 2));
}

async function deploy(name: string, factory: string, args: any[], deployer: any): Promise<string> {
  console.log(`  Deploying ${name}...`);
  const nonce = await deployer.getNonce();
  const F = await ethers.getContractFactory(factory);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`  ✅ ${name}: ${addr}`);
  await new Promise(r => setTimeout(r, 2000));
  return addr;
}

async function tx(label: string, promise: Promise<any>) {
  console.log(`  ${label}...`);
  const r = await (await promise).wait();
  console.log(`  ✅ done (gas: ${r.gasUsed})`);
  await new Promise(r => setTimeout(r, 1500));
}

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("DEXPONENT v3 — HOODI CSM VAULT DEPLOYMENT");
  console.log("=".repeat(60));
  console.log("Network:", network.name);

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  let s = loadState();
  s.deployer = deployer.address;
  s.timestamp = new Date().toISOString();
  saveState(s);

  // ── 1. MockWETH ──────────────────────────────────────────────────────────
  console.log("[1] MockWETH");
  if (!s.mockWETH) {
    s.mockWETH = await deploy("MockWETH", "contracts/v3/test/MockWETH.sol:MockWETH", [], deployer);
    saveState(s);
  } else { console.log(`  ✓ already deployed: ${s.mockWETH}`); }

  // ── 2. MockOracle ─────────────────────────────────────────────────────────
  console.log("\n[2] MockOracle");
  if (!s.mockOracle) {
    s.mockOracle = await deploy("MockOracle", "contracts/v3/test/MockOracle.sol:MockOracle", [], deployer);
    saveState(s);
  } else { console.log(`  ✓ already deployed: ${s.mockOracle}`); }

  // Set ETH price and WETH price in oracle
  const oracle = await ethers.getContractAt("contracts/v3/test/MockOracle.sol:MockOracle", s.mockOracle);
  const currentEthPrice = await oracle.prices(ETH_SENTINEL).catch(() => 0n);
  if (currentEthPrice === 0n) {
    await tx("Set ETH price $2000", oracle.setPrice(ETH_SENTINEL, HOODI.ETH_PRICE_USD));
    await tx("Set WETH price $2000", oracle.setPrice(s.mockWETH!, HOODI.ETH_PRICE_USD));
  }

  // ── 3. ProtocolCore ───────────────────────────────────────────────────────
  console.log("\n[3] ProtocolCore");
  if (!s.protocolCore) {
    // Deploy a minimal DXPToken first (needed by ProtocolCore constructor)
    const dxpToken = await deploy("DXPToken", "contracts/DXPToken.sol:DXPToken", [], deployer);
    s.protocolCore = await deploy("ProtocolCore", "contracts/ProtocolCore.sol:ProtocolCore", [dxpToken, 100, 10, 20], deployer);
    saveState(s);
  } else { console.log(`  ✓ already deployed: ${s.protocolCore}`); }

  // ── 4. FeeCollector ───────────────────────────────────────────────────────
  console.log("\n[4] FeeCollector");
  if (!s.feeCollector) {
    s.feeCollector = await deploy("FeeCollector", "contracts/v3/mainnet/core/FeeCollector.sol:FeeCollector", [s.protocolCore, deployer.address], deployer);
    saveState(s);
  } else { console.log(`  ✓ already deployed: ${s.feeCollector}`); }

  // ── 5. ModuleRegistry ─────────────────────────────────────────────────────
  console.log("\n[5] ModuleRegistry");
  if (!s.moduleRegistry) {
    s.moduleRegistry = await deploy("ModuleRegistry", "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry", [], deployer);
    saveState(s);
  } else { console.log(`  ✓ already deployed: ${s.moduleRegistry}`); }

  const registry = await ethers.getContractAt("contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry", s.moduleRegistry!);
  const currentOracle = await registry.oracle();
  if (currentOracle === ethers.ZeroAddress) {
    await tx("Set oracle in registry", registry.setOracle(s.mockOracle!));
  }

  // ── 6. LidoCSMAdapter ─────────────────────────────────────────────────────
  console.log("\n[6] LidoCSMAdapter");
  if (!s.lidoCSMAdapter) {
    s.lidoCSMAdapter = await deploy(
      "LidoCSMAdapter",
      "contracts/v3/modules/LidoCSMAdapter.sol:LidoCSMAdapter",
      [HOODI.CS_MODULE, HOODI.CS_ACCOUNTING, s.mockOracle, deployer.address],
      deployer
    );
    saveState(s);
  } else { console.log(`  ✓ already deployed: ${s.lidoCSMAdapter}`); }

  // Register staking module in registry
  const currentStaking = await registry.stakingModule();
  if (currentStaking === ethers.ZeroAddress) {
    await tx("Register LidoCSMAdapter as staking module", registry.setStakingModule(s.lidoCSMAdapter!));
  }

  // ── 7. IndexSwapV3 Implementation ─────────────────────────────────────────
  console.log("\n[7] IndexSwapV3 Implementation");
  if (!s.indexSwapImplementation) {
    s.indexSwapImplementation = await deploy("IndexSwapV3 (impl)", "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3", [], deployer);
    saveState(s);
  } else { console.log(`  ✓ already deployed: ${s.indexSwapImplementation}`); }

  // ── 8. IndexSwapFactory ───────────────────────────────────────────────────
  console.log("\n[8] IndexSwapFactory");
  if (!s.indexSwapFactory) {
    s.indexSwapFactory = await deploy(
      "IndexSwapFactory",
      "contracts/v3/factories/IndexSwapFactory.sol:IndexSwapFactory",
      [s.protocolCore, s.moduleRegistry, s.indexSwapImplementation, s.feeCollector],
      deployer
    );
    saveState(s);
  } else { console.log(`  ✓ already deployed: ${s.indexSwapFactory}`); }

  // Register factory in ProtocolCore
  const core = await ethers.getContractAt("contracts/ProtocolCore.sol:ProtocolCore", s.protocolCore!);
  const currentFactory = await core.indexSwapFactory().catch(() => ethers.ZeroAddress);
  if (currentFactory === ethers.ZeroAddress || currentFactory.toLowerCase() !== s.indexSwapFactory!.toLowerCase()) {
    await tx("Register factory in ProtocolCore", core.setIndexSwapFactory(s.indexSwapFactory!));
    await tx("Register FeeCollector in ProtocolCore", core.setFeeCollector(s.feeCollector!));
  }

  // ── 9. Deploy CSM Vault (WETH 100%) ───────────────────────────────────────
  console.log("\n[9] CSM Vault (WETH 100%)");
  if (!s.csmVault) {
    const portfolio = [{ token: s.mockWETH!, weightBps: 10000 }];

    console.log("  Creating vault via ProtocolCore.createIndexSwapVault()...");
    const nonce = await deployer.getNonce();
    const txr = await (await core.createIndexSwapVault(
      deployer.address,
      "Lido CSM Bond Vault",
      "dCSM",
      portfolio,
      0,
      0
    )).wait();

    // Parse vault address from event
    let vaultAddress: string = "";
    for (const log of txr!.logs) {
      try {
        const parsed = core.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "IndexSwapVaultCreated") {
          vaultAddress = parsed.args[1];
          break;
        }
      } catch {}
    }
    if (!vaultAddress) {
      const factory = await ethers.getContractAt("contracts/v3/factories/IndexSwapFactory.sol:IndexSwapFactory", s.indexSwapFactory!);
      const count = await factory.vaultCount();
      vaultAddress = await factory.vaults(count - 1n);
    }

    console.log(`  ✅ CSM Vault: ${vaultAddress}`);
    s.csmVault = vaultAddress;
    saveState(s);
    await new Promise(r => setTimeout(r, 2000));
  } else { console.log(`  ✓ already deployed: ${s.csmVault}`); }

  // ── 10. Summary ───────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("MockWETH:            ", s.mockWETH);
  console.log("MockOracle:          ", s.mockOracle);
  console.log("ProtocolCore:        ", s.protocolCore);
  console.log("FeeCollector:        ", s.feeCollector);
  console.log("ModuleRegistry:      ", s.moduleRegistry);
  console.log("LidoCSMAdapter:      ", s.lidoCSMAdapter);
  console.log("IndexSwapV3 (impl):  ", s.indexSwapImplementation);
  console.log("IndexSwapFactory:    ", s.indexSwapFactory);
  console.log("CSM Vault:           ", s.csmVault);
  console.log("\nCSM Contracts (Hoodi):");
  console.log("  CSModule:          ", HOODI.CS_MODULE);
  console.log("  CSAccounting:      ", HOODI.CS_ACCOUNTING);
  console.log("\nState saved to:", getStatePath());
  console.log("=".repeat(60));
  console.log("\nNext steps:");
  console.log("  1. Create a new Node Operator: node scripts/correct-tennova-csm-flow/01-register-node-operator.mjs");
  console.log("  2. Register vault with NO ID:  node scripts/test-csm-vault.mjs --register <noId>");
  console.log("  3. Test full flow:             node scripts/test-csm-vault.mjs");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
