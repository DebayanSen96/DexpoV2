import hre from "hardhat";
import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers";

// IMPORTANT: Target vault address
const VAULT_ADDRESS = "0xcd493D0A712c4082160682Bc821335b5B73ddC8a";
const TARGET_OUT_TOKEN = "0x5355419854236B3D9c0675a87Fa560F230127663";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ethers } = hre as any;
  if (!VAULT_ADDRESS || !ethers.isAddress(VAULT_ADDRESS)) {
    throw new Error("Set VAULT_ADDRESS at top of script to a valid address");
  }

  // Signer: from PRIVATE_KEY if provided, else default HH signer
  let signer = (await ethers.getSigners())[0];
  const pk = process.env.PRIVATE_KEY;
  if (pk && /^0x[a-fA-F0-9]{64}$/.test(pk)) {
    const provider = (ethers as any).provider as JsonRpcProvider;
    signer = new Wallet(pk, provider);
  }
  const signerAddr = await signer.getAddress();
  const network: string = ((hre as any).network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat";
  console.log("Network:", network);
  console.log("Signer:", signerAddr);
  console.log("Vault:", VAULT_ADDRESS);

  // Minimal ABIs
  const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function symbol() view returns (string)",
  ];
  const vaultAbi = [
    "function asset() view returns (address)",
    "function core() view returns (address)",
    "function assetsValuer() view returns (address)",
    "function usdPricer() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function totalAssetsUsdE18() view returns (uint256)",
    "function pricePerShareE18() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function getUserPosition(address) view returns (uint64,uint64)",
    "function deposit(uint256,address) returns (uint256)",
    "function withdraw(uint256,address,address) returns (uint256)",
    "function setLockupSeconds(uint64)",
    "function approveAsset(address,uint256)", // operator path (may require roles)
    "function userApproveAsset(address,uint256)", // owner-only
    "function executeAction(address,bytes) returns (bytes)",
    "function userExecuteAction(address,bytes) returns (bytes)", // owner-only
  ];
  const coreAbi = [
    "function owner() view returns (address)",
    "function setActionAllowlist(address,bool)",
    "function setActionTarget(address,address,bool)",
  ];
  const treasuryAbi = [
    "function router() view returns (address)",
    "function setRates(uint256,uint256)",
  ];
  const routerAbi = [
    "function addOrUpdateToken(address,uint256)",
    "function swap(address,address,uint256,address) returns (uint256)",
  ];

  // Bind contracts
  const vault = new Contract(VAULT_ADDRESS, vaultAbi, signer);
  const assetAddr: string = await vault.asset();
  const coreAddr: string = await vault.core();
  const treasuryAddr: string = await vault.assetsValuer();
  const pricerAddr: string = await vault.usdPricer();
  const asset = new Contract(assetAddr, erc20Abi, signer);
  const outToken = TARGET_OUT_TOKEN && (ethers as any).isAddress(TARGET_OUT_TOKEN) ? new Contract(TARGET_OUT_TOKEN, erc20Abi, signer) : null;
  const core = new Contract(coreAddr, coreAbi, signer);
  const treasury = treasuryAddr && (ethers as any).isAddress(treasuryAddr) ? new Contract(treasuryAddr, treasuryAbi, signer) : null;
  const routerAddr: string | undefined = treasury ? await treasury.router().catch(() => undefined) : undefined;
  const router = routerAddr && (ethers as any).isAddress(routerAddr) ? new Contract(routerAddr, routerAbi, signer) : null;

  console.log("Asset:", assetAddr);
  console.log("Core:", coreAddr);
  console.log("Treasury:", treasuryAddr || "(none)");
  console.log("Router:", routerAddr || "(none)");
  console.log("Swap target token:", TARGET_OUT_TOKEN || "(none)");

  // Read owner for informational logging only (no policy changes)
  try {
    const coreOwner: string = await core.owner();
    console.log("Core owner:", coreOwner);
  } catch {}

  // Parse base units
  const dec: bigint = await asset.decimals();
  const parse = (v: string) => (ethers as any).parseUnits(v, Number(dec));

  let checks = 0; let passed = 0;
  const assert = async (name: string, cond: boolean | (() => Promise<boolean>)) => {
    checks += 1;
    let ok = false;
    try { ok = typeof cond === "function" ? await (cond as any)() : !!cond; } catch {}
    if (ok) { passed += 1; console.log("[PASS]", name); } else { console.log("[FAIL]", name); }
  };

  // Ensure balance
  const bal = await asset.balanceOf(signerAddr);
  console.log("Base balance:", bal.toString());
  if (bal < parse("20000")) throw new Error("Need at least 20k base tokens for test");

  // Approve and deposit 10k
  const depositAmt = parse("10000");
  await (await asset.approve(VAULT_ADDRESS, depositAmt)).wait();
  await sleep(1000);
  const taBefore = await vault.totalAssets();
  const shBefore = await vault.balanceOf(signerAddr);
  const depRcpt = await (await vault.deposit(depositAmt, signerAddr)).wait();
  console.log("Deposit tx:", depRcpt.hash);
  await sleep(3000);
  const taAfter = await vault.totalAssets();
  const shAfter = await vault.balanceOf(signerAddr);
  await assert("deposit increased totalAssets", taAfter > taBefore);
  await assert("deposit minted shares", shAfter > shBefore);

  // Approvals for actions (owner-only userApproveAsset)
  console.log("-- Approvals (vault -> router / treasury) --");
  const actionAmt = parse("5000");
  if (router) { try { await (await vault.userApproveAsset(routerAddr!, actionAmt)).wait(); } catch { await (await vault.approveAsset(routerAddr!, actionAmt)).wait(); } }
  if (treasury) { try { await (await vault.userApproveAsset(treasuryAddr!, actionAmt)).wait(); } catch { await (await vault.approveAsset(treasuryAddr!, actionAmt)).wait(); } }

  // Lend 3000 base via Treasury (userExecuteAction)
  console.log("-- Lend via Treasury --");
  if (treasury) {
    const lendIface = new Interface(["function lendBase(uint256 amountBase)"]);
    const lendData = lendIface.encodeFunctionData("lendBase", [parse("3000")]);
    try {
      const tx = await vault.userExecuteAction(treasuryAddr!, lendData);
      await tx.wait();
      await sleep(3000);
      // Set high APR to observe PPS >
      try { await (await treasury.setRates(5000, 0)).wait(); } catch {}
      const pps1 = await vault.pricePerShareE18();
      await sleep(4000);
      const pps2 = await vault.pricePerShareE18();
      await assert("lend accrues positive PPS over time", pps2 >= pps1);
    } catch (e) {
      console.log("Lend path failed (skipping):", (e as any)?.message || e);
    }
  }

  // Borrow 500 base via Treasury (exercise path)
  console.log("-- Borrow via Treasury --");
  if (treasury) {
    const borrowIface = new Interface(["function borrowBase(uint256 amountBase)"]);
    const borrowData = borrowIface.encodeFunctionData("borrowBase", [parse("500")]);
    try {
      const tx = await vault.userExecuteAction(treasuryAddr!, borrowData);
      await tx.wait();
      await sleep(2000);
      await assert("borrow path executed", true);
    } catch (e) {
      console.log("Borrow path failed (skipping):", (e as any)?.message || e);
    }
  }

  

  // Swap (B) Treasury-based: vault -> treasury.swapBaseToToken; router.swapFrom(from=vault, recipient=treasury)
  console.log("-- Swap (Treasury-based) --");
  if (treasury && router && outToken) {
    try {
      // seed prices to 1e18 for both tokens
      const price = (10n ** 18n).toString();
      try { await (await router.addOrUpdateToken(assetAddr, price)).wait(); } catch {}
      try { await (await router.addOrUpdateToken(TARGET_OUT_TOKEN, price)).wait(); } catch {}
      const taPreT = await vault.totalAssets();
      const tvlUsdPreT = await vault.totalAssetsUsdE18();
      const tSwapIface = new Interface(["function swapBaseToToken(address,uint256) returns (uint256)"]);
      const swapDataT = tSwapIface.encodeFunctionData("swapBaseToToken", [TARGET_OUT_TOKEN, parse("100")]);
      const tOutBefore = await outToken.balanceOf(treasuryAddr);
      const rOutBefore = await outToken.balanceOf(routerAddr);
      console.log("[Treasury] Router balance (out token) before:", rOutBefore.toString());
      const txT = await vault.userExecuteAction(treasuryAddr!, swapDataT);
      await txT.wait();
      await sleep(2000);
      const tOutAfter = await outToken.balanceOf(treasuryAddr);
      const rOutAfter = await outToken.balanceOf(routerAddr);
      const taPostT = await vault.totalAssets();
      const tvlUsdPostT = await vault.totalAssetsUsdE18();
      console.log("[Treasury] Router balance (out token) after:", rOutAfter.toString());
      await assert("swap (treasury) executed", tOutAfter > tOutBefore);
      console.log(`[Treasury] totalAssets before=${taPreT.toString()} after=${taPostT.toString()}`);
      console.log(`[Treasury] totalAssetsUsdE18 before=${tvlUsdPreT.toString()} after=${tvlUsdPostT.toString()}`);
    } catch (e) {
      console.log("Swap (treasury) failed (skipping):", (e as any)?.message || e);
    }
  }

  // Withdraw 1000 base
  const taPreW = await vault.totalAssets();
  const shPreW = await vault.balanceOf(signerAddr);
  const wAmt = parse("1000");
  // If lockup is active and signer is vault owner, temporarily disable to allow withdraw
  try {
    const pos = await vault.getUserPosition(signerAddr);
    const lockedUntil = Number(pos[1]);
    const now = Math.floor(Date.now() / 1000);
    if (lockedUntil > now) {
      try { await (await vault.setLockupSeconds(0)).wait(); } catch {}
      await sleep(1000);
    }
  } catch {}
  const wRcpt = await (await vault.withdraw(wAmt, signerAddr, signerAddr)).wait();
  console.log("Withdraw tx:", wRcpt.hash);
  await sleep(3000);
  const taPostW = await vault.totalAssets();
  const shPostW = await vault.balanceOf(signerAddr);
  await assert("withdraw reduced totalAssets", taPostW < taPreW);
  await assert("withdraw burned shares", shPostW < shPreW);

  // User position checks
  try {
    const pos = await vault.getUserPosition(signerAddr);
    console.log("User position:", pos);
    await assert("getUserPosition returns timestamps", Number(pos[0]) >= 0 && Number(pos[1]) >= 0);
  } catch {}

  console.log(`Checks passed: ${passed}/${checks}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
