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
  "function depositSingle(address,uint256) returns (uint256)",
  "function withdraw(uint256) returns (uint256[])",
];

const EIP1967_IMPL_SLOT =
  "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";

function fmt18(x: bigint): string {
  return ethers.formatUnits(x, 18);
}

function fmt6(x: bigint): string {
  return ethers.formatUnits(x, USDC_DECIMALS);
}

async function main() {
  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  console.log(`Signer: ${user}`);
  console.log(`Vault:  ${VAULT}`);
  console.log(`USDC:   ${USDC}`);

  const usdc = await ethers.getContractAt(ERC20_ABI, USDC);
  const vault = await ethers.getContractAt(VAULT_ABI, VAULT);

  const implRaw = await ethers.provider.getStorage(VAULT, EIP1967_IMPL_SLOT);
  const implAddr = ethers.getAddress(`0x${implRaw.slice(26)}`);
  console.log(`Implementation: ${implAddr}`);

  const oneUsdc = ethers.parseUnits("1", USDC_DECIMALS);
  const hundredUsdc = ethers.parseUnits("100", USDC_DECIMALS);

  let balBefore = await usdc.balanceOf(user);
  let sharesBefore = await vault.balanceOf(user);
  let supply0 = await vault.totalSupply();
  let tvl0 = supply0 === 0n ? 0n : await vault.getTotalValueUsd();

  console.log(`USDC before:        ${fmt6(balBefore)}`);
  console.log(`Shares before:      ${fmt18(sharesBefore)}`);
  console.log(`Supply before:      ${fmt18(supply0)}`);
  console.log(`TVL before (USD):   ${fmt18(tvl0)}`);

  // Clean slate if this signer already has shares in this vault
  if (sharesBefore > 0n) {
    console.log("Existing shares detected; withdrawing all first for clean test state...");
    await (await vault.withdraw(sharesBefore)).wait();
    balBefore = await usdc.balanceOf(user);
    sharesBefore = await vault.balanceOf(user);
    supply0 = await vault.totalSupply();
    tvl0 = supply0 === 0n ? 0n : await vault.getTotalValueUsd();
    console.log(`USDC after pre-clean: ${fmt6(balBefore)}`);
    console.log(`Shares after pre-clean: ${fmt18(sharesBefore)}`);
    console.log(`Supply after pre-clean: ${fmt18(supply0)}`);
    console.log(`TVL after pre-clean: ${fmt18(tvl0)}`);
  }

  if (balBefore < oneUsdc + hundredUsdc) {
    throw new Error("Insufficient USDC for live test (need at least 101 USDC)");
  }

  // Deposit #1: 1 USDC
  await (await usdc.approve(VAULT, oneUsdc)).wait();
  const tx1 = await vault.depositSingle(USDC, oneUsdc);
  const r1 = await tx1.wait();

  const sharesAfter1 = await vault.balanceOf(user);
  const minted1 = sharesAfter1 - sharesBefore;
  const supply1 = await vault.totalSupply();
  const tvl1 = await vault.getTotalValueUsd();

  console.log(`Minted #1 shares:   ${fmt18(minted1)} (for 1 USDC)`);
  console.log(`Tx #1:              ${r1?.hash}`);
  console.log(`Supply after #1:    ${fmt18(supply1)}`);
  console.log(`TVL after #1 (USD): ${fmt18(tvl1)}`);

  // Pre-state for Deposit #2 check
  const preSupply2 = await vault.totalSupply();
  const preTvl2 = await vault.getTotalValueUsd();
  const deposit2Usd = ethers.parseUnits("100", 18);
  const expectedMint2 = (deposit2Usd * preSupply2) / preTvl2;

  // Deposit #2: 100 USDC
  await (await usdc.approve(VAULT, hundredUsdc)).wait();
  const tx2 = await vault.depositSingle(USDC, hundredUsdc);
  const r2 = await tx2.wait();

  const sharesAfter2 = await vault.balanceOf(user);
  const minted2 = sharesAfter2 - sharesAfter1;
  const supply2 = await vault.totalSupply();
  const tvl2 = await vault.getTotalValueUsd();

  console.log(`Pre #2 supply:      ${fmt18(preSupply2)}`);
  console.log(`Pre #2 TVL (USD):   ${fmt18(preTvl2)}`);
  console.log(`Expected #2 mint:   ${fmt18(expectedMint2)}`);
  console.log(`Actual #2 mint:     ${fmt18(minted2)}`);
  console.log(`Tx #2:              ${r2?.hash}`);
  console.log(`Supply after #2:    ${fmt18(supply2)}`);
  console.log(`TVL after #2 (USD): ${fmt18(tvl2)}`);

  const diff = expectedMint2 > minted2 ? expectedMint2 - minted2 : minted2 - expectedMint2;
  console.log(`Mint diff:          ${fmt18(diff)} shares`);

  // Withdraw all shares for cleanup/funds recovery
  const usdcBeforeWithdraw = await usdc.balanceOf(user);
  const sharesToWithdraw = await vault.balanceOf(user);
  const txW = await vault.withdraw(sharesToWithdraw);
  await txW.wait();

  const usdcAfterWithdraw = await usdc.balanceOf(user);
  const withdrawnUsdc = usdcAfterWithdraw - usdcBeforeWithdraw;
  const sharesAfterWithdraw = await vault.balanceOf(user);
  const supplyAfterWithdraw = await vault.totalSupply();
  const tvlAfterWithdraw = await vault.getTotalValueUsd();

  console.log(`Withdrawn USDC:      ${fmt6(withdrawnUsdc)} (after burning all signer shares)`);
  console.log(`Shares after wd:     ${fmt18(sharesAfterWithdraw)}`);
  console.log(`Supply after wd:     ${fmt18(supplyAfterWithdraw)}`);
  console.log(`TVL after wd (USD):  ${fmt18(tvlAfterWithdraw)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
