import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const HOODI_RPC   = "https://hoodi.drpc.org";
const PRIVATE_KEY = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";
const CS_ACCOUNTING = "0xA54b90BA34C5f326BC1485054080994e38FB4C60";
const BOND_AMOUNT = ethers.parseEther("2.4");

function loadDeployment() {
  const p = join(ROOT, "deployments", "v3-latest", "ethereum-hoodi.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

async function pollReceipt(provider, hash, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const r = await provider.getTransactionReceipt(hash);
      if (r) return r;
    } catch {}
    process.stdout.write(".");
  }
  throw new Error("Receipt timeout: " + hash);
}

async function send(wallet, provider, label, contract, method, args, overrides = {}) {
  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const gasPrice = (await provider.getFeeData()).gasPrice * 12n / 10n;
  console.log(`\n[${label}] nonce=${nonce}`);
  const tx = await contract[method](...args, { nonce, gasPrice, gasLimit: 600_000n, ...overrides });
  process.stdout.write(`  tx: ${tx.hash} `);
  const receipt = await pollReceipt(provider, tx.hash);
  if (receipt.status !== 1) throw new Error(`${label} REVERTED`);
  console.log(` ✅ gas: ${receipt.gasUsed}`);
  return receipt;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const dep      = loadDeployment();

  const { mockWETH, csmVault, lidoCSMAdapter } = dep;
  console.log("Wallet:         ", wallet.address);
  console.log("Balance:        ", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH");
  console.log("MockWETH:       ", mockWETH);
  console.log("CSM Vault:      ", csmVault);
  console.log("LidoCSMAdapter: ", lidoCSMAdapter);

  const weth = new ethers.Contract(mockWETH, [
    "function deposit() payable",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
  ], wallet);

  const vault = new ethers.Contract(csmVault, [
    "function depositSingle(address,uint256) returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function getTotalValueUsd() view returns (uint256)",
    "function executeModuleAction(uint8,bytes) returns (bytes)",
  ], wallet);

  const adapter = new ethers.Contract(lidoCSMAdapter, [
    "function vaultRegistered(address) view returns (bool)",
    "function vaultNodeOperatorId(address) view returns (uint256)",
    "function vaultBondedEth(address) view returns (uint256)",
  ], provider);

  const csa = new ethers.Contract(CS_ACCOUNTING, [
    "function getBondSummary(uint256) view returns (uint256 current, uint256 required)",
  ], provider);

  // ── Verify registration ──────────────────────────────────────────────────
  const registered = await adapter.vaultRegistered(csmVault);
  const noId = await adapter.vaultNodeOperatorId(csmVault);
  if (!registered) { console.error("Vault not registered. Run --register first."); process.exit(1); }
  console.log(`\nVault registered with NO ID: ${noId}`);

  // ── Step 1: Wrap ETH → WETH ───────────────────────────────────────────────
  const wethBal = await weth.balanceOf(wallet.address);
  console.log("\nWETH balance:", ethers.formatEther(wethBal));
  if (wethBal < BOND_AMOUNT) {
    await send(wallet, provider, "wrap 3 ETH → WETH", weth, "deposit", [], { value: ethers.parseEther("3") });
  } else {
    console.log("  ✓ sufficient WETH already");
  }

  // ── Step 2: Approve vault ─────────────────────────────────────────────────
  const allowance = await weth.allowance(wallet.address, csmVault);
  console.log("\nWETH allowance to vault:", ethers.formatEther(allowance));
  if (allowance < BOND_AMOUNT) {
    await send(wallet, provider, "approve vault for WETH", weth, "approve", [csmVault, ethers.MaxUint256]);
  } else {
    console.log("  ✓ already approved");
  }

  // ── Step 3: LP deposits WETH into vault ──────────────────────────────────
  const sharesBefore = await vault.balanceOf(wallet.address);
  console.log("\nShares before deposit:", ethers.formatEther(sharesBefore));
  await send(wallet, provider, "depositSingle 2.4 WETH into vault", vault, "depositSingle", [mockWETH, BOND_AMOUNT]);
  const sharesAfter = await vault.balanceOf(wallet.address);
  console.log("  Shares minted:", ethers.formatEther(sharesAfter - sharesBefore));
  console.log("  Vault TVL (USD):", ethers.formatEther(await vault.getTotalValueUsd()));

  // ── Step 4: Vault owner calls STAKE_BOND ─────────────────────────────────
  // ModuleCommand enum: LEND_SUPPLY=0, LEND_WITHDRAW=1, LEND_WITHDRAW_ALL=2, SWAP=3, SWAP_WITH_SLIPPAGE=4, STAKE_BOND=5
  const STAKE_BOND = 5;
  const params = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [mockWETH, BOND_AMOUNT]);
  await send(wallet, provider, "executeModuleAction(STAKE_BOND)", vault, "executeModuleAction", [STAKE_BOND, params]);

  // ── Step 5: Verify bond in CSAccounting ──────────────────────────────────
  console.log("\n=== Verification ===");
  const [current, required] = await csa.getBondSummary(noId);
  console.log("CSAccounting bond summary for NO", noId.toString());
  console.log("  current bond:", ethers.formatEther(current), "ETH (stETH)");
  console.log("  required bond:", ethers.formatEther(required), "ETH");

  const bonded = await adapter.vaultBondedEth(csmVault);
  console.log("Adapter tracked bond:", ethers.formatEther(bonded), "ETH");

  const tvlAfter = await vault.getTotalValueUsd();
  console.log("Vault TVL after stake:", ethers.formatEther(tvlAfter), "USD");

  console.log("\n" + "=".repeat(50));
  if (current > 0n) {
    console.log("✅ SUCCESS: LP ETH → vault → LidoCSMAdapter → CSM bond");
    console.log("   NO #" + noId + " bond funded via vault crowd-sourcing");
  } else {
    console.log("⚠  Bond sent but stETH not yet reflected (check CSM explorer)");
    console.log("   TX was successful — stETH conversion may take 1-2 blocks");
  }
  console.log("=".repeat(50));
}

main().catch(e => { console.error("\n❌", e.message || e); process.exit(1); });
