import hre from "hardhat";
import { readFile } from "fs/promises";
import { join } from "path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>, tries = 5, delayMs = 1000): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; }
    await sleep(delayMs);
  }
  throw lastErr;
}

async function main() {
  const network: string = ((hre as any).network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat";
  const { ethers } = hre as any;

  const deployFile = join("deployments", network, `${network}.json`);
  const raw = await readFile(deployFile, "utf-8");
  const dep = JSON.parse(raw);

  const vaultAddr: string = dep.contracts.vaults.bluechip.Vault;
  const dxpAddr: string = dep.contracts.DXPToken;

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();
  console.log("Network:", network);
  console.log("Signer:", signerAddr);
  console.log("Vault:", vaultAddr);
  console.log("DXP:", dxpAddr);

  const erc20 = await ethers.getContractAt("contracts/v3/vault/BaseVault.sol:Vault4626", vaultAddr);
  const dxp = await ethers.getContractAt("contracts/DXPToken.sol:DXPToken", dxpAddr);

  const dec = await dxp.decimals();
  const amount = (ethers as any).parseUnits("1000", dec);

  const balBefore = await dxp.balanceOf(signerAddr);
  console.log("DXP balance before:", balBefore.toString());
  if (balBefore < amount) throw new Error("Insufficient DXP for test");

  const apprTx = await dxp.approve(vaultAddr, amount);
  await apprTx.wait();
  await sleep(1500);
  console.log("Approved", amount.toString());

  const shBefore = await retry<bigint>(() => erc20.balanceOf(signerAddr));
  const taBefore = await retry<bigint>(() => erc20.totalAssets());

  const depTx = await erc20.deposit(amount, signerAddr);
  const depRcpt = await depTx.wait();
  await sleep(2000);
  console.log("Deposit tx:", depRcpt?.hash);

  const shAfter = await retry<bigint>(() => erc20.balanceOf(signerAddr));
  const taAfter = await retry<bigint>(() => erc20.totalAssets());
  console.log("Shares minted:", (shAfter - shBefore as bigint).toString());
  console.log("TotalAssets delta:", (taAfter - taBefore as bigint).toString());

  const withdrawAmount = (ethers as any).parseUnits("100", dec);
  const wTx = await erc20.withdraw(withdrawAmount, signerAddr, signerAddr);
  const wRcpt = await wTx.wait();
  await sleep(2000);
  console.log("Withdraw tx:", wRcpt?.hash);
  const shPostW = await retry<bigint>(() => erc20.balanceOf(signerAddr));
  const taPostW = await retry<bigint>(() => erc20.totalAssets());
  console.log("Shares after withdraw:", shPostW.toString());
  console.log("TotalAssets after withdraw:", taPostW.toString());

  const iface = new (ethers as any).Interface(["function symbol() view returns (string)"]);
  const data = iface.encodeFunctionData("symbol", []);
  // Read return via static call
  const ret = await erc20.executeAction.staticCall(dxpAddr, data);
  const decoded = iface.decodeFunctionResult("symbol", ret)[0];
  console.log("DXP.symbol via executeAction (static):", decoded);
  // Also submit the actual transaction (no-op state change but exercises path)
  const actTx = await erc20.executeAction(dxpAddr, data);
  await actTx.wait();
  await sleep(1000);
  console.log("executeAction tx:", actTx.hash);

  const pps = await erc20.pricePerShareE18();
  console.log("pricePerShareE18:", pps.toString());
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
