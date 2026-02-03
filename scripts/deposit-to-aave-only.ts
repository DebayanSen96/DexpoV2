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
  console.log("DEPOSIT 1 USDC TO VAULT & INVEST IN AAVE (NO SWAPS)");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  console.log("\nDeployer:", deployer.address);
  console.log("Vault:", state.testVault.indexSwap);

  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const aUsdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.AAVE_AUSDC);
  
  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap
  );
  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );

  const AAVE_ADAPTER_ID = state.adapterIds.aaveV3;

  const walletUsdc = await usdc.balanceOf(deployer.address);
  console.log("Wallet USDC Balance:", ethers.formatUnits(walletUsdc, 6), "USDC");

  // Step 1: Deposit 1 USDC to vault
  console.log("\n" + "=".repeat(70));
  console.log("STEP 1: DEPOSIT 1 USDC TO VAULT");
  console.log("=".repeat(70));

  const depositAmount = ethers.parseUnits("0.18", 6);
  
  console.log("\nApproving USDC...");
  await (await usdc.approve(state.testVault.indexSwap, depositAmount)).wait();
  console.log("  ✅ Approved");

  console.log("\nDepositing 0.18 USDC...");
  const depositTx = await vault.depositSingle(BASE_MAINNET.USDC, depositAmount);
  await depositTx.wait();
  console.log("  ✅ Deposited");
  console.log("  Tx Hash:", depositTx.hash);

  await delay(2000);

  const vaultUsdcAfterDeposit = await usdc.balanceOf(state.testVault.indexSwap);
  const userShares = await vault.balanceOf(deployer.address);
  const userCostBasis = await vault.userCostBasisUsd(deployer.address);

  console.log("\n📊 After Deposit:");
  console.log("  Vault USDC:     ", ethers.formatUnits(vaultUsdcAfterDeposit, 6));
  console.log("  User Shares:    ", ethers.formatUnits(userShares, 18));
  console.log("  User Cost Basis:", ethers.formatUnits(userCostBasis, 18), "USD");

  // Step 2: Approve vault to spend USDC for lending
  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: APPROVE VAULT FOR LENDING");
  console.log("=".repeat(70));

  console.log("\nApproving LendingHub to spend vault's USDC...");
  const approveTx = await vault.approveToken(BASE_MAINNET.USDC, state.lendingHub, vaultUsdcAfterDeposit);
  await approveTx.wait();
  console.log("  ✅ Approved");

  await delay(2000);

  // Step 3: Supply all USDC to Aave
  console.log("\n" + "=".repeat(70));
  console.log("STEP 3: SUPPLY ALL USDC TO AAVE V3");
  console.log("=".repeat(70));

  console.log("\nSupplying", ethers.formatUnits(vaultUsdcAfterDeposit, 6), "USDC to Aave...");
  const supplyTx = await lendingHub.supply(
    state.testVault.indexSwap,
    BASE_MAINNET.USDC,
    vaultUsdcAfterDeposit,
    AAVE_ADAPTER_ID,
    { gasLimit: 600000 }
  );
  await supplyTx.wait();
  console.log("  ✅ Supply executed");
  console.log("  Tx Hash:", supplyTx.hash);

  await delay(2000);

  // Check final state
  const position = await lendingHub.getPosition(state.testVault.indexSwap, BASE_MAINNET.USDC);
  const hubAUsdc = await aUsdc.balanceOf(state.lendingHub);
  const vaultUsdcFinal = await usdc.balanceOf(state.testVault.indexSwap);

  console.log("\n" + "=".repeat(70));
  console.log("FINAL STATE");
  console.log("=".repeat(70));

  console.log("\n📊 Vault Holdings:");
  console.log("  USDC in vault:  ", ethers.formatUnits(vaultUsdcFinal, 6));
  console.log("  USDC in Aave:   ", ethers.formatUnits(position.currentBalance, 6));
  console.log("  User shares:    ", ethers.formatUnits(userShares, 18));
  console.log("  User cost basis:", ethers.formatUnits(userCostBasis, 18), "USD");

  console.log("\n📊 Aave Position:");
  console.log("  Supplied Amount:", ethers.formatUnits(position.suppliedAmount, 6), "USDC");
  console.log("  Current Balance:", ethers.formatUnits(position.currentBalance, 6), "USDC");
  console.log("  Shares:         ", position.shares.toString());
  console.log("  LendingHub aUSDC:", ethers.formatUnits(hubAUsdc, 6));

  console.log("\n" + "=".repeat(70));
  console.log("✅ DEPOSIT COMPLETE - NO SWAPS, NO SLIPPAGE LOSSES");
  console.log("=".repeat(70));
  console.log("\n⏳ Wait 1+ day for Aave interest to accrue");
  console.log("📝 Then run withdrawal script to test fee distribution");
  console.log("\nExpected fee split on profit:");
  console.log("  - 10% of profit → Performance fee");
  console.log("    - 90% of that → Vault Owner");
  console.log("    - 10% of that → Protocol");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
