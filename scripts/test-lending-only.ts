import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AAVE_AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
};

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("AAVE LENDING TEST");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const aUsdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.AAVE_AUSDC);

  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );
  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap
  );

  const vaultAddress = state.testVault.indexSwap;
  const AAVE_ADAPTER_ID = state.adapterIds.aaveV3;

  console.log("\nVault:", vaultAddress);
  console.log("LendingHub:", state.lendingHub);

  let vaultUsdc = await usdc.balanceOf(vaultAddress);
  console.log("\nVault USDC balance:", ethers.formatUnits(vaultUsdc, 6));

  if (vaultUsdc === 0n) {
    console.log("No USDC in vault, depositing 1 USDC...");
    const ONE_USDC = ethers.parseUnits("1", 6);
    await (await usdc.approve(vaultAddress, ONE_USDC)).wait();
    await delay(2000);
    await (await vault.deposit([ONE_USDC, 0])).wait();
    console.log("✅ Deposited");
    await delay(2000);
    vaultUsdc = await usdc.balanceOf(vaultAddress);
    console.log("Vault USDC now:", ethers.formatUnits(vaultUsdc, 6));
  }

  const ONE_USDC = ethers.parseUnits("1", 6);

  console.log("\n[1] Approving LendingHub...");
  await (await vault.approveToken(BASE_MAINNET.USDC, state.lendingHub, ONE_USDC)).wait();
  console.log("✅ Approved");
  await delay(2000);

  const allowance = await usdc.allowance(vaultAddress, state.lendingHub);
  console.log("Allowance:", ethers.formatUnits(allowance, 6));

  console.log("\n[2] Supplying 1 USDC to Aave...");
  const tx = await lendingHub.supply(vaultAddress, BASE_MAINNET.USDC, ONE_USDC, AAVE_ADAPTER_ID, { gasLimit: 600000 });
  console.log("TX hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("TX status:", receipt?.status === 1 ? "SUCCESS" : "FAILED");
  console.log("Gas used:", receipt?.gasUsed.toString());
  await delay(2000);

  const hubAUsdc = await aUsdc.balanceOf(state.lendingHub);
  console.log("\nLendingHub aUSDC:", ethers.formatUnits(hubAUsdc, 6));

  const position = await lendingHub.getPosition(vaultAddress, BASE_MAINNET.USDC);
  console.log("Position shares:", position.shares.toString());
  console.log("Position supplied:", ethers.formatUnits(position.suppliedAmount, 6));

  if (position.shares > 0n) {
    console.log("\n[3] Withdrawing all from Aave...");
    const withdrawTx = await lendingHub.withdrawAll(vaultAddress, BASE_MAINNET.USDC, { gasLimit: 500000 });
    console.log("TX hash:", withdrawTx.hash);
    const withdrawReceipt = await withdrawTx.wait();
    console.log("TX status:", withdrawReceipt?.status === 1 ? "SUCCESS" : "FAILED");
    await delay(2000);

    vaultUsdc = await usdc.balanceOf(vaultAddress);
    console.log("\nVault USDC after withdraw:", ethers.formatUnits(vaultUsdc, 6));
    
    const positionAfter = await lendingHub.getPosition(vaultAddress, BASE_MAINNET.USDC);
    console.log("Position shares after:", positionAfter.shares.toString());
  }

  console.log("\n✅ LENDING TEST COMPLETE");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
