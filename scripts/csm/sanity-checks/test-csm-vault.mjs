import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function waitForReceipt(provider, txHash, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await provider.getTransactionReceipt(txHash);
      if (r) return r;
    } catch {}
    process.stdout.write(".");
    await new Promise(res => setTimeout(res, 3000));
  }
  throw new Error(`Receipt not found after ${maxAttempts} attempts: ${txHash}`);
}

const HOODI_RPC = "https://hoodi.drpc.org";
const PRIVATE_KEY = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";

const CS_MODULE    = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const CS_ACCOUNTING = "0xA54b90BA34C5f326BC1485054080994e38FB4C60";
const BOND_AMOUNT  = ethers.parseEther("2.4");

const VAULT_ABI = [
  "function depositSingle(address depositToken, uint256 depositAmount) returns (uint256 shares)",
  "function balanceOf(address) view returns (uint256)",
  "function getTotalValueUsd() view returns (uint256)",
  "function getSharePrice() view returns (uint256)",
  "function executeModuleAction(uint8 command, bytes params) returns (bytes)",
  "function moduleRegistry() view returns (address)",
];

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const ADAPTER_ABI = [
  "function registerVault(address vault, uint256 nodeOperatorId) external",
  "function vaultRegistered(address) view returns (bool)",
  "function vaultNodeOperatorId(address) view returns (uint256)",
  "function vaultBondedEth(address) view returns (uint256)",
];

const CSM_ABI = [
  "function getNodeOperator(uint256) view returns (tuple(uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint8,uint32,uint32,address,address,address,address,bool,bool))",
  "function getNodeOperatorsCount() view returns (uint256)",
];

const CSA_ABI = [
  "function getBondSummary(uint256 nodeOperatorId) view returns (uint256 current, uint256 required)",
];

function loadDeployment() {
  const p = join(__dirname, "..", "..", "..", "deployments", "v3-latest", "ethereum-hoodi.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  const registerFlag = args.indexOf("--register");
  const noIdArg = registerFlag !== -1 ? parseInt(args[registerFlag + 1]) : null;

  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Wallet:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH\n");

  const dep = loadDeployment();
  const { mockWETH, csmVault, lidoCSMAdapter } = dep;

  if (!mockWETH || !csmVault || !lidoCSMAdapter) {
    console.error("Missing deployment addresses. Run deploy-hoodi-csm first.");
    process.exit(1);
  }

  console.log("MockWETH:       ", mockWETH);
  console.log("CSM Vault:      ", csmVault);
  console.log("LidoCSMAdapter: ", lidoCSMAdapter);

  const weth    = new ethers.Contract(mockWETH, WETH_ABI, wallet);
  const vault   = new ethers.Contract(csmVault, VAULT_ABI, wallet);
  const adapter = new ethers.Contract(lidoCSMAdapter, ADAPTER_ABI, wallet);
  const csm     = new ethers.Contract(CS_MODULE, CSM_ABI, provider);
  const csa     = new ethers.Contract(CS_ACCOUNTING, CSA_ABI, provider);

  // ── Step 0: Register vault with NO ID if requested ──────────────────────
  if (noIdArg !== null) {
    console.log(`\n[0] Registering vault with Node Operator ID ${noIdArg}...`);
    const already = await adapter.vaultRegistered(csmVault);
    if (already) {
      const existingId = await adapter.vaultNodeOperatorId(csmVault);
      console.log(`  Vault already registered with NO ID: ${existingId}`);
    } else {
      const tx = await adapter.registerVault(csmVault, noIdArg);
      process.stdout.write("  Waiting " + tx.hash + " ");
      await waitForReceipt(provider, tx.hash);
      console.log(" ✅");
      console.log(`  Vault registered with NO ID ${noIdArg}`);
    }
    return;
  }

  // ── Check vault is registered ────────────────────────────────────────────
  const registered = await adapter.vaultRegistered(csmVault);
  if (!registered) {
    console.error("\n❌ Vault not registered with an NO ID.");
    console.error("   First create a Node Operator, then run:");
    console.error("   node scripts/test-csm-vault.mjs --register <noId>");
    process.exit(1);
  }
  const noId = await adapter.vaultNodeOperatorId(csmVault);
  console.log(`\nVault registered with NO ID: ${noId}`);

  // ── Step 1: Wrap ETH → WETH (simulate LP deposit) ───────────────────────
  console.log("\n[1] Wrapping 3 ETH → WETH (LP simulation)...");
  const wrapAmount = ethers.parseEther("3");
  const wethBalBefore = await weth.balanceOf(wallet.address);
  if (wethBalBefore < wrapAmount) {
    const nonce = await provider.getTransactionCount(wallet.address, "latest");
    const tx = await weth.deposit({ value: wrapAmount, nonce });
    process.stdout.write("  Waiting " + tx.hash + " ");
    await waitForReceipt(provider, tx.hash);
    console.log(" ✅ Wrapped 3 ETH → WETH");
  } else {
    console.log("  ✓ Already have enough WETH:", ethers.formatEther(wethBalBefore));
  }

  // ── Step 2: Approve vault to spend WETH ──────────────────────────────────
  console.log("\n[2] Approving vault to spend WETH...");
  const allowance = await weth.allowance(wallet.address, csmVault);
  if (allowance < BOND_AMOUNT) {
    const nonce = await provider.getTransactionCount(wallet.address, "latest");
    const tx = await weth.approve(csmVault, ethers.MaxUint256, { nonce });
    process.stdout.write("  Waiting " + tx.hash + " ");
    await waitForReceipt(provider, tx.hash);
    console.log(" ✅ Approved");
  } else {
    console.log("  ✓ Already approved");
  }

  // ── Step 3: LP deposits WETH into vault ──────────────────────────────────
  console.log("\n[3] LP deposits 2.4 WETH into vault...");
  const sharesBefore = await vault.balanceOf(wallet.address);
  const nonce3 = await provider.getTransactionCount(wallet.address, "latest");
  const depositTx = await vault.depositSingle(mockWETH, BOND_AMOUNT, { nonce: nonce3, gasLimit: 500_000n });
  process.stdout.write("  Waiting " + depositTx.hash + " ");
  const depositReceipt = await waitForReceipt(provider, depositTx.hash);
  console.log(" ✅ gas:", depositReceipt.gasUsed.toString());
  const sharesAfter = await vault.balanceOf(wallet.address);
  console.log("  ✅ Shares minted:", ethers.formatEther(sharesAfter - sharesBefore));

  const tvl = await vault.getTotalValueUsd();
  const sharePrice = await vault.getSharePrice();
  console.log("  Vault TVL (USD):", ethers.formatEther(tvl));
  console.log("  Share price:    ", ethers.formatEther(sharePrice));

  // ── Step 4: Vault owner calls STAKE_BOND ─────────────────────────────────
  // ModuleCommand.STAKE_BOND = 5 (enum index)
  console.log("\n[4] Vault owner calls executeModuleAction(STAKE_BOND, 2.4 WETH)...");
  const stakeBondCommand = 5;
  const stakeBondParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"],
    [mockWETH, BOND_AMOUNT]
  );

  const nonce4 = await provider.getTransactionCount(wallet.address, "latest");
  const stakeTx = await vault.executeModuleAction(stakeBondCommand, stakeBondParams, {
    nonce: nonce4,
    gasLimit: 500_000n,
  });
  process.stdout.write("  Waiting " + stakeTx.hash + " ");
  const stakeReceipt = await waitForReceipt(provider, stakeTx.hash);
  console.log(" gas:", stakeReceipt.gasUsed.toString());

  if (stakeReceipt.status !== 1) {
    console.error("  ❌ STAKE_BOND transaction reverted");
    process.exit(1);
  }
  console.log("  ✅ STAKE_BOND executed");

  // ── Step 5: Verify bond in CSM ────────────────────────────────────────────
  console.log("\n[5] Verifying bond in CSAccounting...");
  const [current, required] = await csa.getBondSummary(noId);
  console.log("  current bond:", ethers.formatEther(current), "ETH (stETH)");
  console.log("  required bond:", ethers.formatEther(required), "ETH");

  const no = await csm.getNodeOperator(noId);
  console.log("\n  NO state:");
  console.log("    added:     ", Number(no[0]));
  console.log("    deposited: ", Number(no[2]));
  console.log("    vetted:    ", Number(no[3]));

  const bonded = await adapter.vaultBondedEth(csmVault);
  console.log("\n  Adapter tracked bond:", ethers.formatEther(bonded), "ETH");

  console.log("\n" + "=".repeat(50));
  if (current > 0n) {
    console.log("✅ SUCCESS: Bond deposited into Lido CSM via vault!");
    console.log("   LP deposited WETH → vault → adapter → CSM bond");
  } else {
    console.log("⚠ Bond not reflected yet (stETH conversion may take a block)");
  }
  console.log("=".repeat(50));
}

main().catch(e => { console.error(e); process.exit(1); });
