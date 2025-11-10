import hre from "hardhat";
import { readFile } from "fs/promises";
import { join } from "path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ethers } = hre as any;
  const network: string = ((hre as any).network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat";
  const deployFile = join("deployments", network, `${network}.json`);
  const dep = JSON.parse(await readFile(deployFile, "utf-8"));

  const vaultAddr: string = dep.contracts.vaults.bluechip.Vault;
  const coreAddr: string = dep.contracts.ProtocolCore;
  const treasuryAddr: string = dep.contracts.VaultTreasury;
  const routerAddr: string = dep.contracts.MockSwapRouter;
  const assetAddr: string = dep.contracts.DXPToken;

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();
  console.log("Network:", network);
  console.log("Signer:", signerAddr);
  console.log("Vault:", vaultAddr);
  console.log("Treasury:", treasuryAddr);
  console.log("Router:", routerAddr);
  console.log("Asset:", assetAddr);

  const vault = await ethers.getContractAt("contracts/v3/vault/BaseVault.sol:Vault4626", vaultAddr);
  const treasury = await ethers.getContractAt("contracts/v3/treasury/VaultTreasury.sol:VaultTreasury", treasuryAddr);
  const router = routerAddr ? await ethers.getContractAt("contracts/libraries/testnet/MockSwapRouter.sol:MockSwapRouter", routerAddr) : null;
  const asset = await ethers.getContractAt("contracts/DXPToken.sol:DXPToken", assetAddr);

  const dec = await asset.decimals();
  const parse = (v: string) => (ethers as any).parseUnits(v, dec);

  // Ensure balances and approvals
  const startBal = await asset.balanceOf(signerAddr);
  console.log("Asset balance:", startBal.toString());
  if (startBal < parse("2000")) throw new Error("Need at least 2000 base tokens for test");

  // Approve vault to pull deposit
  await (await asset.approve(vaultAddr, parse("2000"))).wait();

  // Deposit 2000 base
  await (await vault.deposit(parse("2000"), signerAddr)).wait();
  await sleep(1500);

  // Approve vault allowances for router and treasury so treasury can operate
  if (router) {
    await (await vault.approveAsset(routerAddr, parse("1000"))).wait();
  }
  await (await vault.approveAsset(treasuryAddr, parse("1000"))).wait();

  // Lend 1000 base via treasury (called through executeAction)
  const itf = new (ethers as any).Interface(["function lendBase(uint256 amountBase)"]);
  const data = itf.encodeFunctionData("lendBase", [parse("1000")]);
  await (await vault.executeAction(treasuryAddr, data)).wait();

  // Set high lend APR to observe PPS change quickly
  await (await treasury.setRates(5000, 0)).wait(); // 50% APR lend, 0% borrow

  const ppsBefore = await vault.pricePerShareE18();
  const taBefore = await vault.totalAssets();
  console.log("Before accrue - PPS:", ppsBefore.toString(), "TA:", taBefore.toString());

  // Wait a few seconds to accrue
  await sleep(5000);

  const ppsAfter = await vault.pricePerShareE18();
  const taAfter = await vault.totalAssets();
  console.log("After accrue  - PPS:", ppsAfter.toString(), "TA:", taAfter.toString());

  // Optional: demonstrate swap path if router funded with liquidity and token list set
  if (router) {
    try {
      // Ensure router knows about base asset price ~1e18
      await (await router.addOrUpdateToken(assetAddr, (10n ** 18n).toString())).wait();
    } catch {}
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
