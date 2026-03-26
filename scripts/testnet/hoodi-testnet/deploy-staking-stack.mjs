import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const HOODI_RPC = process.env.HOODI_RPC_URL || "https://hoodi.drpc.org";
const PRIVATE_KEY = process.env.HOODI_PRIVATE_KEY || process.env.MAINNET_WALLET_PK || process.env.PRIVATE_KEY || "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";
const CS_MODULE = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const CS_ACCOUNTING = "0xA54b90BA34C5f326BC1485054080994e38FB4C60";
const STETH = "0x3508A952176b3c15387C97BE809eaffB1982176a";
const PERMISSIONLESS_GATE = "0x5553077102322689876A6AdFd48D75014c28acfb";
const STAKING_ROUTER = "0xCc820558B39ee15C7C45B59390B503b83fb499A8";
const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const BOND_AMOUNT = ethers.parseEther(process.env.HOODI_BOND_ETH || "2.4");
const ETH_PRICE = ethers.parseEther(process.env.HOODI_ETH_PRICE_USD || "2000");
const VALIDATORS_JSON_PATH = process.env.TENNOVA_VALIDATORS_JSON || join(ROOT, "keys", "depost_data_1_march_2026.json");
const STATE_PATH = join(ROOT, "deployments", "testnet", "hoodi-testnet.json");

const PATHS = {
  mockWeth: ["v3/testnet/hoodi-testnet/tokens/HoodiTestnetMockWETH.sol", "HoodiTestnetMockWETH"],
  oracle: ["v3/testnet/hoodi-testnet/oracles/HoodiTestnetMockOracle.sol", "HoodiTestnetMockOracle"],
  dxpToken: ["v3/testnet/hoodi-testnet/core/HoodiTestnetDXPToken.sol", "HoodiTestnetDXPToken"],
  protocolCore: ["v3/testnet/hoodi-testnet/core/HoodiTestnetProtocolCore.sol", "HoodiTestnetProtocolCore"],
  feeCollector: ["v3/testnet/hoodi-testnet/core/HoodiTestnetFeeCollector.sol", "HoodiTestnetFeeCollector"],
  moduleRegistry: ["v3/testnet/hoodi-testnet/core/HoodiTestnetModuleRegistry.sol", "HoodiTestnetModuleRegistry"],
  staking: ["v3/testnet/hoodi-testnet/modules/HoodiTestnetLidoCSMAdapter.sol", "HoodiTestnetLidoCSMAdapter"],
  vaultImpl: ["v3/testnet/hoodi-testnet/vault/HoodiTestnetIndexSwapV3.sol", "HoodiTestnetIndexSwapV3"],
  factory: ["v3/testnet/hoodi-testnet/factories/HoodiTestnetIndexSwapFactory.sol", "HoodiTestnetIndexSwapFactory"],
};

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    freshState: args.has("--fresh-state"),
    runStage2: args.has("--run-stage-2"),
    skipVaultCreate: args.has("--skip-vault-create"),
  };
}

function loadState(freshState) {
  if (freshState || !existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  const dir = join(ROOT, "deployments", "testnet");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function artifact(contractPath, contractName) {
  const p = join(ROOT, "artifacts", "contracts", contractPath, `${contractName}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function normalizeHex(hex) {
  if (!hex) return "0x";
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function pickNextValidator(entries) {
  return entries.find((entry) => !entry.used && !entry.usedAt);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getGasPrice(provider) {
  const feeData = await provider.getFeeData();
  return ((feeData.gasPrice ?? 1n) * 12n) / 10n;
}

async function getNonce(provider, address) {
  return provider.getTransactionCount(address, "pending");
}

async function sendWithRetry(label, builder, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await builder(attempt);
    } catch (err) {
      lastError = err;
      const msg = err?.shortMessage || err?.message || String(err);
      console.log(`  ${label} attempt ${attempt}/${maxAttempts} failed: ${msg}`);
      if (
        attempt < maxAttempts &&
        (msg.includes("nonce too low") || msg.includes("already known") || msg.includes("underpriced") || msg.includes("replacement fee too low") || msg.includes("timeout"))
      ) {
        await delay(3000);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function deployContract(wallet, provider, state, stateKey, label, contractPath, contractName, constructorArgs) {
  if (state[stateKey]) {
    console.log(`  ${label}: ${state[stateKey]}`);
    return state[stateKey];
  }

  const art = artifact(contractPath, contractName);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);

  const address = await sendWithRetry(label, async () => {
    const nonce = await getNonce(provider, wallet.address);
    const gasPrice = await getGasPrice(provider);
    console.log(`  Deploying ${label} (nonce ${nonce})...`);
    const contract = await factory.deploy(...constructorArgs, { nonce, gasPrice, gasLimit: 7_000_000n });
    const tx = contract.deploymentTransaction();
    console.log(`  ${label} tx: ${tx.hash}`);
    await contract.waitForDeployment();
    return contract.getAddress();
  });

  state[stateKey] = address;
  saveState(state);
  await delay(1500);
  return address;
}

async function sendTx(wallet, provider, label, to, abi, method, args = [], extraOverrides = {}) {
  const contract = new ethers.Contract(to, abi, wallet);
  return sendWithRetry(label, async () => {
    const nonce = await getNonce(provider, wallet.address);
    const gasPrice = await getGasPrice(provider);
    const overrides = { nonce, gasPrice, gasLimit: 800_000n, ...extraOverrides };
    console.log(`  ${label} (nonce ${nonce})...`);
    const tx = await contract[method](...args, overrides);
    console.log(`  ${label} tx: ${tx.hash}`);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
    await delay(1200);
    return { tx, receipt };
  });
}

async function ensureOraclePrices(wallet, provider, state) {
  const [oraclePath, oracleName] = PATHS.oracle;
  const oracleArt = artifact(oraclePath, oracleName);
  const oracle = new ethers.Contract(state.mockOracle, oracleArt.abi, provider);
  const ethPrice = await oracle.prices(ETH_SENTINEL);
  if (ethPrice !== 0n) {
    console.log("  Oracle prices already configured");
    return;
  }

  await sendTx(wallet, provider, "oracle.setPrice(ETH)", state.mockOracle, oracleArt.abi, "setPrice", [ETH_SENTINEL, ETH_PRICE]);
  await sendTx(wallet, provider, "oracle.setPrice(WETH)", state.mockOracle, oracleArt.abi, "setPrice", [state.mockWETH, ETH_PRICE]);
}

async function ensureRegistryConfig(wallet, provider, state) {
  const [registryPath, registryName] = PATHS.moduleRegistry;
  const registryArt = artifact(registryPath, registryName);
  const registry = new ethers.Contract(state.moduleRegistry, registryArt.abi, provider);

  if ((await registry.oracle()) === ethers.ZeroAddress) {
    await sendTx(wallet, provider, "registry.setOracle", state.moduleRegistry, registryArt.abi, "setOracle", [state.mockOracle]);
  }

  if ((await registry.stakingModule()) === ethers.ZeroAddress) {
    await sendTx(wallet, provider, "registry.setStakingModule", state.moduleRegistry, registryArt.abi, "setStakingModule", [state.lidoCSMAdapter]);
  }
}

async function ensureCoreConfig(wallet, provider, state) {
  const [corePath, coreName] = PATHS.protocolCore;
  const coreArt = artifact(corePath, coreName);
  const core = new ethers.Contract(state.protocolCore, coreArt.abi, provider);

  const currentFactory = await core.indexSwapFactory().catch(() => ethers.ZeroAddress);
  if (currentFactory === ethers.ZeroAddress || currentFactory.toLowerCase() !== state.indexSwapFactory.toLowerCase()) {
    await sendTx(wallet, provider, "core.setIndexSwapFactory", state.protocolCore, coreArt.abi, "setIndexSwapFactory", [state.indexSwapFactory]);
  }

  const currentFeeCollector = await core.feeCollector().catch(() => ethers.ZeroAddress);
  if (currentFeeCollector === ethers.ZeroAddress || currentFeeCollector.toLowerCase() !== state.feeCollector.toLowerCase()) {
    await sendTx(wallet, provider, "core.setFeeCollector", state.protocolCore, coreArt.abi, "setFeeCollector", [state.feeCollector]);
  }
}

async function createVault(wallet, provider, state) {
  if (state.csmVault) {
    console.log(`  Existing staking vault: ${state.csmVault}`);
    return state.csmVault;
  }

  const [corePath, coreName] = PATHS.protocolCore;
  const [factoryPath, factoryName] = PATHS.factory;
  const coreArt = artifact(corePath, coreName);
  const factoryArt = artifact(factoryPath, factoryName);
  const core = new ethers.Contract(state.protocolCore, coreArt.abi, wallet);
  const portfolio = [{ token: state.mockWETH, weightBps: 10000 }];

  const { receipt } = await sendWithRetry("core.createIndexSwapVault", async () => {
    const nonce = await getNonce(provider, wallet.address);
    const gasPrice = await getGasPrice(provider);
    console.log(`  core.createIndexSwapVault (nonce ${nonce})...`);
    const tx = await core.createIndexSwapVault(
      wallet.address,
      "Lido CSM Bond Vault",
      "dCSM",
      portfolio,
      0,
      0,
      { nonce, gasPrice, gasLimit: 4_500_000n }
    );
    console.log(`  core.createIndexSwapVault tx: ${tx.hash}`);
    const rec = await tx.wait();
    if (!rec || rec.status !== 1) throw new Error("createIndexSwapVault failed");
    return { receipt: rec };
  });

  let vaultAddress = "";
  for (const log of receipt.logs) {
    try {
      const parsed = core.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "IndexSwapVaultCreated") {
        vaultAddress = parsed.args[1];
        break;
      }
    } catch {}
  }

  if (!vaultAddress) {
    const factory = new ethers.Contract(state.indexSwapFactory, factoryArt.abi, provider);
    const count = await factory.vaultCount();
    vaultAddress = await factory.vaults(count - 1n);
  }

  state.csmVault = vaultAddress;
  saveState(state);
  return vaultAddress;
}

async function runStage2(wallet, provider, state) {
  console.log("\n[Stage 2] Tennova key + 2.4 ETH bond flow");

  const balance = await provider.getBalance(wallet.address);
  const requiredBalance = BOND_AMOUNT + ethers.parseEther("0.05");
  if (balance < requiredBalance) {
    throw new Error(
      `Insufficient Hoodi ETH for staking stage. balance=${ethers.formatEther(balance)} required~=${ethers.formatEther(requiredBalance)}`
    );
  }

  const validators = JSON.parse(readFileSync(VALIDATORS_JSON_PATH, "utf8"));
  if (!Array.isArray(validators) || validators.length === 0) {
    throw new Error(`Validator JSON is empty or invalid: ${VALIDATORS_JSON_PATH}`);
  }

  const selected = pickNextValidator(validators);
  if (!selected) {
    console.log("  No unused validator entries left in JSON.");
    return;
  }

  const pubkey = normalizeHex(selected.pubkey);
  const signature = normalizeHex(selected.signature);
  const jsonWC = normalizeHex(selected.withdrawal_credentials).toLowerCase();
  const sr = new ethers.Contract(STAKING_ROUTER, ["function getWithdrawalCredentials() view returns (bytes32)"], provider);
  const expectedWC = (await sr.getWithdrawalCredentials()).toLowerCase();

  if (jsonWC !== expectedWC) {
    throw new Error(`withdrawal_credentials mismatch. json=${jsonWC} expected=${expectedWC}`);
  }

  const [vaultPath, vaultName] = PATHS.vaultImpl;
  const [wethPath, wethName] = PATHS.mockWeth;
  const [adapterPath, adapterName] = PATHS.staking;
  const vaultArt = artifact(vaultPath, vaultName);
  const wethArt = artifact(wethPath, wethName);
  const adapterArt = artifact(adapterPath, adapterName);

  const vault = new ethers.Contract(state.csmVault, vaultArt.abi, wallet);
  const adapter = new ethers.Contract(state.lidoCSMAdapter, adapterArt.abi, provider);

  await sendTx(wallet, provider, "vault.depositNative", state.csmVault, vaultArt.abi, "depositNative", [state.mockWETH], { value: BOND_AMOUNT });
  await sendTx(wallet, provider, "vault.approveToken(adapter)", state.csmVault, vaultArt.abi, "approveToken", [state.mockWETH, state.lidoCSMAdapter, BOND_AMOUNT]);

  const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes"], [pubkey, signature]);
  const params = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes"], [state.mockWETH, BOND_AMOUNT, validatorData]);
  await sendTx(wallet, provider, "vault.executeModuleAction(STAKE_BOND)", state.csmVault, vaultArt.abi, "executeModuleAction", [5, params], { gasLimit: 3_000_000n });

  const noId = await adapter.vaultNodeOperatorId(state.csmVault);
  const bonded = await adapter.vaultBondedEth(state.csmVault);
  console.log(`  Node operator id: ${Number(noId)}`);
  console.log(`  Adapter bonded ETH: ${ethers.formatEther(bonded)}`);

  selected.used = true;
  selected.usedAt = new Date().toISOString();
  selected.nodeOperatorId = Number(noId);
  writeFileSync(VALIDATORS_JSON_PATH, JSON.stringify(validators, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("\n============================================================");
  console.log("HOODI TESTNET STAKING STACK DEPLOYMENT");
  console.log("============================================================");
  console.log("Deployer:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH");

  const state = loadState(args.freshState);
  state.deployer = wallet.address;
  state.timestamp = new Date().toISOString();
  saveState(state);

  console.log("\n[1] Deploy Hoodi testnet core + staking stack");
  state.mockWETH = await deployContract(wallet, provider, state, "mockWETH", "HoodiTestnetMockWETH", ...PATHS.mockWeth, []);
  state.mockOracle = await deployContract(wallet, provider, state, "mockOracle", "HoodiTestnetMockOracle", ...PATHS.oracle, []);
  state.dxpToken = await deployContract(wallet, provider, state, "dxpToken", "HoodiTestnetDXPToken", ...PATHS.dxpToken, []);
  state.protocolCore = await deployContract(wallet, provider, state, "protocolCore", "HoodiTestnetProtocolCore", ...PATHS.protocolCore, [state.dxpToken, 100, 10, 20]);
  state.feeCollector = await deployContract(wallet, provider, state, "feeCollector", "HoodiTestnetFeeCollector", ...PATHS.feeCollector, [state.protocolCore, wallet.address]);
  state.moduleRegistry = await deployContract(wallet, provider, state, "moduleRegistry", "HoodiTestnetModuleRegistry", ...PATHS.moduleRegistry, []);
  state.lidoCSMAdapter = await deployContract(wallet, provider, state, "lidoCSMAdapter", "HoodiTestnetLidoCSMAdapter", ...PATHS.staking, [CS_MODULE, CS_ACCOUNTING, PERMISSIONLESS_GATE, state.mockOracle, state.mockWETH, STETH]);
  state.indexSwapImplementation = await deployContract(wallet, provider, state, "indexSwapImplementation", "HoodiTestnetIndexSwapV3", ...PATHS.vaultImpl, []);
  state.indexSwapFactory = await deployContract(wallet, provider, state, "indexSwapFactory", "HoodiTestnetIndexSwapFactory", ...PATHS.factory, [state.protocolCore, state.moduleRegistry, state.indexSwapImplementation, state.feeCollector]);

  console.log("\n[2] Configure registry + oracle + protocol core");
  await ensureOraclePrices(wallet, provider, state);
  await ensureRegistryConfig(wallet, provider, state);
  await ensureCoreConfig(wallet, provider, state);

  if (!args.skipVaultCreate) {
    console.log("\n[3] Create staking vault");
    await createVault(wallet, provider, state);
  }

  console.log("\nSummary");
  console.log("  mockWETH:            ", state.mockWETH);
  console.log("  mockOracle:          ", state.mockOracle);
  console.log("  protocolCore:        ", state.protocolCore);
  console.log("  feeCollector:        ", state.feeCollector);
  console.log("  moduleRegistry:      ", state.moduleRegistry);
  console.log("  lidoCSMAdapter:      ", state.lidoCSMAdapter);
  console.log("  indexSwapImpl:       ", state.indexSwapImplementation);
  console.log("  indexSwapFactory:    ", state.indexSwapFactory);
  console.log("  csmVault:            ", state.csmVault || "(not created)");
  console.log("  state file:          ", STATE_PATH);

  if (args.runStage2) {
    if (!state.csmVault) throw new Error("Stage 2 requires a created staking vault");
    await runStage2(wallet, provider, state);
  } else {
    console.log("\nStage 2 skipped. Pass --run-stage-2 to use Tennova validator JSON and stake 2.4 ETH through the vault.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
