import { ethers } from "hardhat";

const VAULT = "0x6fb6c29d47ea7ead6612ab8567a24596c042294b";
const USDC = "0x135542cee4208a832ecc764d4f3a365cb9300575";
const USDC_DECIMALS = 6;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const VAULT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function getTotalValueUsd() view returns (uint256)",
  "function getSharePrice() view returns (uint256)",
  "function depositSingle(address,uint256) returns (uint256)",
  "function withdraw(uint256) returns (uint256[])",
];

function fmt6(v: bigint): string {
  return ethers.formatUnits(v, USDC_DECIMALS);
}

function fmt18(v: bigint): string {
  return ethers.formatUnits(v, 18);
}

async function main() {
  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  const usdc = await ethers.getContractAt(ERC20_ABI, USDC);
  const vault = await ethers.getContractAt(VAULT_ABI, VAULT);

  const amount = ethers.parseUnits("1", USDC_DECIMALS);

  const supplyBefore = await vault.totalSupply();
  const tvlBefore = await vault.getTotalValueUsd();
  const ppsBefore = await vault.getSharePrice();
  const sharesBefore = await vault.balanceOf(user);
  const usdcBefore = await usdc.balanceOf(user);

  await (await usdc.approve(VAULT, amount)).wait();
  const txD = await vault.depositSingle(USDC, amount);
  await txD.wait();

  const sharesAfterDeposit = await vault.balanceOf(user);
  const minted = sharesAfterDeposit - sharesBefore;
  const supplyAfterDeposit = await vault.totalSupply();
  const tvlAfterDeposit = await vault.getTotalValueUsd();
  const ppsAfterDeposit = await vault.getSharePrice();

  let withdrawHash = "not-sent";
  try {
    const txW = await vault.withdraw(minted);
    withdrawHash = txW.hash;
    await txW.wait();
  } catch (e: any) {
    withdrawHash = `reverted: ${e?.shortMessage || e?.message || "unknown"}`;
  }

  const usdcAfter = await usdc.balanceOf(user);
  const usdcDelta = usdcAfter - usdcBefore;

  console.log(`Signer: ${user}`);
  console.log(`Deposit tx: ${txD.hash}`);
  console.log(`Withdraw tx: ${withdrawHash}`);
  console.log(`Supply before/after deposit: ${fmt18(supplyBefore)} -> ${fmt18(supplyAfterDeposit)}`);
  console.log(`TVL before/after deposit: ${fmt18(tvlBefore)} -> ${fmt18(tvlAfterDeposit)}`);
  console.log(`PPS before/after deposit: ${fmt18(ppsBefore)} -> ${fmt18(ppsAfterDeposit)}`);
  console.log(`Minted shares for 1 USDC: ${fmt18(minted)}`);
  console.log(`Net wallet USDC delta after deposit+withdraw: ${fmt6(usdcDelta)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
