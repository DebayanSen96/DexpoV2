import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const HOODI_RPC    = "https://hoodi.drpc.org";
const PRIVATE_KEY  = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";
const CS_MODULE    = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const CS_ACCOUNTING= "0xA54b90BA34C5f326BC1485054080994e38FB4C60";
const PERMISSIONLESS_GATE = "0x5553077102322689876A6AdFd48D75014c28acfb";
const STAKING_ROUTER = "0xCc820558B39ee15C7C45B59390B503b83fb499A8";
const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const BOND_AMOUNT = ethers.parseEther("2.4");
const ETH_PRICE    = ethers.parseEther("2000"); // $2000 fixed
const VALIDATORS_JSON_PATH = join(ROOT, "keys", "depost_data_1_march_2026.json");

const STATE_PATH = join(ROOT, "deployments", "v3-latest", "ethereum-hoodi.json");

function loadState() {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  return {};
}
function saveState(s) {
  const dir = join(ROOT, "deployments", "v3-latest");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function artifact(contractPath, contractName) {
  const p = join(ROOT, "artifacts", "contracts", contractPath, `${contractName}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

async function deployContract(wallet, provider, name, artPath, artName, constructorArgs) {
  const art = artifact(artPath, artName);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  console.log(`  Deploying ${name} (nonce: ${nonce})...`);
  const gasPrice = (await provider.getFeeData()).gasPrice * 12n / 10n; // +20% buffer
  const contract = await factory.deploy(...constructorArgs, { nonce, gasPrice, gasLimit: 6_000_000n });
  process.stdout.write("  Waiting for tx " + contract.deploymentTransaction().hash + " ...");
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(" ✅");
  console.log(`  ${name}: ${addr}`);
  await sleep(2000);
  return addr;
}

async function sendTx(wallet, provider, label, to, abi, method, args, valueOrOverrides) {
  const contract = new ethers.Contract(to, abi, wallet);
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const gasPrice = (await provider.getFeeData()).gasPrice * 12n / 10n;
  console.log(`  ${label} (nonce: ${nonce})...`);
  let overrides = { nonce, gasPrice, gasLimit: 500_000n };
  if (typeof valueOrOverrides === "bigint") {
    overrides.value = valueOrOverrides;
  } else if (valueOrOverrides && typeof valueOrOverrides === "object") {
    overrides = { ...overrides, ...valueOrOverrides };
  }
  const tx = await contract[method](...args, overrides);
  process.stdout.write("  Waiting " + tx.hash + " ...");
  const receipt = await tx.wait();
  console.log(" ✅");
  await sleep(1500);
  return { hash: tx.hash, receipt };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeHex(hex) {
  if (!hex) return "0x";
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function pickNextValidator(entries) {
  return entries.find((entry) => !entry.used && !entry.usedAt);
}

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("DEXPONENT v3 — HOODI CSM VAULT DEPLOYMENT");
  console.log("=".repeat(60));

  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const bal      = await provider.getBalance(wallet.address);
  const nonce    = await provider.getTransactionCount(wallet.address, "latest");
  console.log("Deployer:", wallet.address);
  console.log("Balance: ", ethers.formatEther(bal), "ETH");
  console.log("Nonce (latest):", nonce, "\n");

  let s = loadState();
  s.deployer  = wallet.address;
  s.timestamp = new Date().toISOString();
  saveState(s);

  // ── 1. MockWETH ──────────────────────────────────────────────────────────
  console.log("[1] MockWETH");
  if (!s.mockWETH) {
    s.mockWETH = await deployContract(wallet, provider, "MockWETH",
      "v3/test/MockWETH.sol", "MockWETH", []);
    saveState(s);
  } else { console.log(`  ✓ ${s.mockWETH}`); }

  // ── 2. MockOracle ─────────────────────────────────────────────────────────
  console.log("\n[2] MockOracle");
  if (!s.mockOracle) {
    s.mockOracle = await deployContract(wallet, provider, "MockOracle",
      "v3/test/MockOracle.sol", "MockOracle", []);
    saveState(s);
  } else { console.log(`  ✓ ${s.mockOracle}`); }

  // Set prices if not set
  const oracleArt = artifact("v3/test/MockOracle.sol", "MockOracle");
  const oracleRO  = new ethers.Contract(s.mockOracle, oracleArt.abi, provider);
  const ethPriceSet = await oracleRO.prices(ETH_SENTINEL);
  if (ethPriceSet === 0n) {
    await sendTx(wallet, provider, "Set ETH price $2000", s.mockOracle, oracleArt.abi, "setPrice", [ETH_SENTINEL, ETH_PRICE]);
    await sendTx(wallet, provider, "Set WETH price $2000", s.mockOracle, oracleArt.abi, "setPrice", [s.mockWETH, ETH_PRICE]);
  } else {
    console.log("  ✓ Prices already set");
  }

  // ── 3. DXPToken ───────────────────────────────────────────────────────────
  console.log("\n[3] DXPToken");
  if (!s.dxpToken) {
    s.dxpToken = await deployContract(wallet, provider, "DXPToken",
      "DXPToken.sol", "DXPToken", []);
    saveState(s);
  } else { console.log(`  ✓ ${s.dxpToken}`); }

  // ── 4. ProtocolCore ───────────────────────────────────────────────────────
  console.log("\n[4] ProtocolCore");
  if (!s.protocolCore) {
    s.protocolCore = await deployContract(wallet, provider, "ProtocolCore",
      "ProtocolCore.sol", "ProtocolCore", [s.dxpToken, 100, 10, 20]);
    saveState(s);
  } else { console.log(`  ✓ ${s.protocolCore}`); }

  // ── 5. FeeCollector ───────────────────────────────────────────────────────
  console.log("\n[5] FeeCollector");
  if (!s.feeCollector) {
    s.feeCollector = await deployContract(wallet, provider, "FeeCollector",
      "v3/mainnet/ethereum-mainnet/core/FeeCollector.sol", "FeeCollector", [s.protocolCore, wallet.address]);
    saveState(s);
  } else { console.log(`  ✓ ${s.feeCollector}`); }

  // ── 6. ModuleRegistry ─────────────────────────────────────────────────────
  console.log("\n[6] ModuleRegistry");
  if (!s.moduleRegistry) {
    s.moduleRegistry = await deployContract(wallet, provider, "ModuleRegistry",
      "v3/mainnet/ethereum-mainnet/core/ModuleRegistry.sol", "ModuleRegistry", []);
    saveState(s);
  } else { console.log(`  ✓ ${s.moduleRegistry}`); }

  const regArt = artifact("v3/mainnet/ethereum-mainnet/core/ModuleRegistry.sol", "ModuleRegistry");
  const regRO  = new ethers.Contract(s.moduleRegistry, regArt.abi, provider);
  const currentOracle = await regRO.oracle();
  if (currentOracle === ethers.ZeroAddress) {
    await sendTx(wallet, provider, "Set oracle in registry", s.moduleRegistry, regArt.abi, "setOracle", [s.mockOracle]);
  } else { console.log("  ✓ Oracle already set"); }

  // ── 7. LidoCSMAdapter ─────────────────────────────────────────────────────
  console.log("\n[7] LidoCSMAdapter");
  if (!s.lidoCSMAdapter) {
    s.lidoCSMAdapter = await deployContract(wallet, provider, "LidoCSMAdapter",
      "v3/modules/LidoCSMAdapter.sol", "LidoCSMAdapter",
      [CS_MODULE, CS_ACCOUNTING, PERMISSIONLESS_GATE, s.mockOracle, s.mockWETH]);
    saveState(s);
  } else { console.log(`  ✓ ${s.lidoCSMAdapter}`); }

  const currentStaking = await regRO.stakingModule();
  if (currentStaking === ethers.ZeroAddress) {
    await sendTx(wallet, provider, "Register LidoCSMAdapter as staking module", s.moduleRegistry, regArt.abi, "setStakingModule", [s.lidoCSMAdapter]);
  } else { console.log("  ✓ Staking module already set"); }

  // ── 8. IndexSwapV3 Implementation ─────────────────────────────────────────
  console.log("\n[8] IndexSwapV3 Implementation");
  if (!s.indexSwapImplementation) {
    s.indexSwapImplementation = await deployContract(wallet, provider, "IndexSwapV3 (impl)",
      "v3/mainnet/ethereum-mainnet/vault/IndexSwapV3.sol", "IndexSwapV3", []);
    saveState(s);
  } else { console.log(`  ✓ ${s.indexSwapImplementation}`); }

  // ── 9. IndexSwapFactory ───────────────────────────────────────────────────
  console.log("\n[9] IndexSwapFactory");
  if (!s.indexSwapFactory) {
    s.indexSwapFactory = await deployContract(wallet, provider, "IndexSwapFactory",
      "v3/factories/IndexSwapFactory.sol", "IndexSwapFactory",
      [s.protocolCore, s.moduleRegistry, s.indexSwapImplementation, s.feeCollector]);
    saveState(s);
  } else { console.log(`  ✓ ${s.indexSwapFactory}`); }

  // Register factory + feeCollector in ProtocolCore
  const coreArt = artifact("ProtocolCore.sol", "ProtocolCore");
  const coreRO  = new ethers.Contract(s.protocolCore, coreArt.abi, provider);
  const currentFactory = await coreRO.indexSwapFactory().catch(() => ethers.ZeroAddress);
  if (currentFactory === ethers.ZeroAddress || currentFactory.toLowerCase() !== s.indexSwapFactory.toLowerCase()) {
    await sendTx(wallet, provider, "Register factory in ProtocolCore", s.protocolCore, coreArt.abi, "setIndexSwapFactory", [s.indexSwapFactory]);
    await sendTx(wallet, provider, "Register FeeCollector in ProtocolCore", s.protocolCore, coreArt.abi, "setFeeCollector", [s.feeCollector]);
  } else { console.log("  ✓ Factory already registered"); }

  // ── 10. Deploy CSM Vault ──────────────────────────────────────────────────
  console.log("\n[10] CSM Vault (WETH 100%)");
  if (!s.csmVault) {
    const portfolio = [{ token: s.mockWETH, weightBps: 10000 }];
    const nonce = await provider.getTransactionCount(wallet.address, "latest");
    const gasPrice = (await provider.getFeeData()).gasPrice * 12n / 10n;
    console.log(`  Creating vault (nonce: ${nonce})...`);
    const core = new ethers.Contract(s.protocolCore, coreArt.abi, wallet);
    const tx = await core.createIndexSwapVault(
      wallet.address, "Lido CSM Bond Vault", "dCSM", portfolio, 0, 0,
      { nonce, gasPrice, gasLimit: 4_000_000n }
    );
    process.stdout.write("  Waiting " + tx.hash + " ...");
    const receipt = await tx.wait();
    console.log(" ✅");

    // Parse vault address from logs
    let vaultAddress = "";
    for (const log of receipt.logs) {
      try {
        const parsed = core.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "IndexSwapVaultCreated") { vaultAddress = parsed.args[1]; break; }
      } catch {}
    }
    if (!vaultAddress) {
      const factArt = artifact("v3/factories/IndexSwapFactory.sol", "IndexSwapFactory");
      const factory = new ethers.Contract(s.indexSwapFactory, factArt.abi, provider);
      const count = await factory.vaultCount();
      vaultAddress = await factory.vaults(count - 1n);
    }
    console.log("  CSM Vault:", vaultAddress);
    s.csmVault = vaultAddress;
    saveState(s);
    await sleep(2000);
  } else { console.log(`  ✓ ${s.csmVault}`); }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("MockWETH:           ", s.mockWETH);
  console.log("MockOracle:         ", s.mockOracle);
  console.log("DXPToken:           ", s.dxpToken);
  console.log("ProtocolCore:       ", s.protocolCore);
  console.log("FeeCollector:       ", s.feeCollector);
  console.log("ModuleRegistry:     ", s.moduleRegistry);
  console.log("LidoCSMAdapter:     ", s.lidoCSMAdapter);
  console.log("IndexSwapV3 (impl): ", s.indexSwapImplementation);
  console.log("IndexSwapFactory:   ", s.indexSwapFactory);
  console.log("CSM Vault:          ", s.csmVault);
  console.log("\nCSM Contracts (Hoodi):");
  console.log("  CSModule:         ", CS_MODULE);
  console.log("  CSAccounting:     ", CS_ACCOUNTING);
  console.log("\nState:", STATE_PATH);
  console.log("=".repeat(60));

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== 560048) {
    console.log("\nSkipping Stage 2: non-Hoodi network");
    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STAGE 2: E2E Test — LP Deposit → STAKE_BOND via Vault → Verify on CSM
  // ════════════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(60));
  console.log("STAGE 2: E2E STAKING TEST (Hoodi)");
  console.log("=".repeat(60));

  const vaultArt = artifact("v3/mainnet/ethereum-mainnet/vault/IndexSwapV3.sol", "IndexSwapV3");
  const wethArt  = artifact("v3/test/MockWETH.sol", "MockWETH");
  const vault    = new ethers.Contract(s.csmVault, vaultArt.abi, wallet);
  const wethC    = new ethers.Contract(s.mockWETH, wethArt.abi, wallet);

  console.log("\n[2x] Selecting validator from JSON:", VALIDATORS_JSON_PATH);
  const validators = JSON.parse(readFileSync(VALIDATORS_JSON_PATH, "utf8"));
  if (!Array.isArray(validators) || validators.length === 0) {
    throw new Error("Validator JSON is empty or invalid");
  }
  const selected = pickNextValidator(validators);
  if (!selected) {
    console.log("No unused validators found. Stopping Stage 2 as requested.");
    return;
  }

  const pubkey = normalizeHex(selected.pubkey);
  const signature = normalizeHex(selected.signature);
  if (pubkey.length !== 98) throw new Error("Invalid pubkey length in selected JSON entry");
  if (signature.length !== 194) throw new Error("Invalid signature length in selected JSON entry");

  const sr = new ethers.Contract(STAKING_ROUTER, ["function getWithdrawalCredentials() view returns (bytes32)"], provider);
  const expectedWC = (await sr.getWithdrawalCredentials()).toLowerCase();
  const jsonWC = normalizeHex(selected.withdrawal_credentials).toLowerCase();
  if (expectedWC !== jsonWC) {
    throw new Error(`withdrawal_credentials mismatch. json=${jsonWC} expected=${expectedWC}`);
  }
  console.log("  Using pubkey:", pubkey);

  // ── 2a. Wrap ETH → WETH ─────────────────────────────────────────────────
  console.log("\n[2a] Wrapping", ethers.formatEther(BOND_AMOUNT), "ETH → WETH");
  await sendTx(wallet, provider, "WETH.deposit", s.mockWETH, wethArt.abi, "deposit", [], BOND_AMOUNT);

  const wethBal = await wethC.balanceOf(wallet.address);
  console.log("  WETH balance:", ethers.formatEther(wethBal));

  // ── 2b. Approve vault to pull WETH ───────────────────────────────────────
  console.log("\n[2b] Approving vault to pull WETH");
  await sendTx(wallet, provider, "WETH.approve(vault)", s.mockWETH, wethArt.abi, "approve", [s.csmVault, BOND_AMOUNT]);

  // ── 2c. LP Deposit into vault ────────────────────────────────────────────
  console.log("\n[2c] LP deposit into vault (", ethers.formatEther(BOND_AMOUNT), "WETH)");
  await sendTx(wallet, provider, "vault.depositSingle", s.csmVault, vaultArt.abi, "depositSingle", [s.mockWETH, BOND_AMOUNT]);

  const shares = await vault.balanceOf(wallet.address);
  const vaultWeth = await wethC.balanceOf(s.csmVault);
  console.log("  LP shares:", ethers.formatEther(shares));
  console.log("  Vault WETH:", ethers.formatEther(vaultWeth));

  // ── 2e. Vault approves LidoCSMAdapter to pull WETH ───────────────────────
  console.log("\n[2e] Vault approves LidoCSMAdapter to pull WETH");
  await sendTx(wallet, provider, "vault.approveToken", s.csmVault, vaultArt.abi,
    "approveToken", [s.mockWETH, s.lidoCSMAdapter, BOND_AMOUNT]);

  // ── 2f. Call STAKE_BOND through vault's executeModuleAction ──────────────
  console.log("\n[2f] Calling STAKE_BOND via vault.executeModuleAction");
  const validatorData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes", "bytes"], [pubkey, signature]
  );
  const stakeParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "bytes"],
    [s.mockWETH, BOND_AMOUNT, validatorData]
  );
  const STAKE_BOND_CMD = 5; // enum index
  const stakeReceipt = await sendTx(wallet, provider, "vault.executeModuleAction(STAKE_BOND)",
    s.csmVault, vaultArt.abi, "executeModuleAction",
    [STAKE_BOND_CMD, stakeParams], { gasLimit: 3_000_000n });

  // ── 2g. Verify on CSM ────────────────────────────────────────────────────
  console.log("\n[2g] Verifying on Lido CSM...");
  const adapterArt = artifact("v3/modules/LidoCSMAdapter.sol", "LidoCSMAdapter");
  const adapter = new ethers.Contract(s.lidoCSMAdapter, adapterArt.abi, provider);
  const registered = await adapter.vaultRegistered(s.csmVault);
  const noId = await adapter.vaultNodeOperatorId(s.csmVault);
  const bonded = await adapter.vaultBondedEth(s.csmVault);
  console.log("  Vault registered:", registered);
  console.log("  Node Operator ID:", Number(noId));
  console.log("  Bonded ETH:      ", ethers.formatEther(bonded));

  const csm = new ethers.Contract(CS_MODULE, [
    "function getNodeOperator(uint256) view returns (tuple(uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint8,uint32,uint32,address,address,address,address,bool,bool))",
  ], provider);
  const no = await csm.getNodeOperator(noId);
  console.log("  totalAddedKeys:  ", Number(no[0]));
  console.log("  totalVettedKeys: ", Number(no[3]));
  console.log("  depositableCount:", Number(no[5]));
  console.log("  manager:         ", no[10]);

  if (Number(no[3]) === 0) {
    console.warn("\n⚠ WARNING: Key NOT vetted — signature or WC may be wrong");
  } else {
    console.log("\n✅ Key VETTED! Validator registered via vault infra.");
  }

  selected.used = true;
  selected.usedAt = new Date().toISOString();
  selected.nodeOperatorId = Number(noId);
  selected.txHash = stakeReceipt.hash;
  selected.vetted = Number(no[3]) > 0;
  writeFileSync(VALIDATORS_JSON_PATH, JSON.stringify(validators, null, 2));

  console.log("\nValidator pubkey:", pubkey);
  console.log("Monitor: https://hoodi.beaconcha.in/validator/" + pubkey);

  const vaultWethAfter = await wethC.balanceOf(s.csmVault);
  console.log("\nVault WETH after stake:", ethers.formatEther(vaultWethAfter));
  console.log("=".repeat(60));
  console.log("E2E TEST COMPLETE");
  console.log("=".repeat(60));
}

main().catch(e => { console.error(e); process.exit(1); });


