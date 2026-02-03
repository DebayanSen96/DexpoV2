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
  console.log("WITHDRAW FROM AAVE & VAULT - CHECK FEE DISTRIBUTION");
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
  const feeCollector = await ethers.getContractAt(
    "contracts/v3/mainnet/core/FeeCollector.sol:FeeCollector",
    state.feeCollector
  );

  // Check current state
  console.log("\n" + "=".repeat(70));
  console.log("STEP 1: CHECK CURRENT STATE");
  console.log("=".repeat(70));

  const position = await lendingHub.getPosition(state.testVault.indexSwap, BASE_MAINNET.USDC);
  const userShares = await vault.balanceOf(deployer.address);
  const userCostBasis = await vault.userCostBasisUsd(deployer.address);
  const walletUsdcBefore = await usdc.balanceOf(deployer.address);
  const vaultOwner = await vault.vaultOwner();
  const performanceFeeBps = await vault.performanceFeeBps();
  const protocolCutBps = await feeCollector.protocolCutBps();
  const feeRecipient = await feeCollector.feeRecipient();

  console.log("\n📊 Current State:");
  console.log("  Originally Supplied:", ethers.formatUnits(position.suppliedAmount, 6), "USDC");
  console.log("  Current Balance:    ", ethers.formatUnits(position.currentBalance, 6), "USDC");
  console.log("  Interest Earned:    ", ethers.formatUnits(position.currentBalance - position.suppliedAmount, 6), "USDC");
  console.log("  User Shares:        ", ethers.formatUnits(userShares, 18));
  console.log("  User Cost Basis:    ", ethers.formatUnits(userCostBasis, 18), "USD");
  console.log("  Wallet USDC Before: ", ethers.formatUnits(walletUsdcBefore, 6));

  console.log("\n📊 Fee Configuration:");
  console.log("  Vault Owner:        ", vaultOwner);
  console.log("  Performance Fee:    ", performanceFeeBps.toString(), "bps (", Number(performanceFeeBps) / 100, "%)");
  console.log("  Protocol Cut:       ", protocolCutBps.toString(), "bps (", Number(protocolCutBps) / 100, "% of vault owner fee)");
  console.log("  Fee Recipient:      ", feeRecipient);

  const interest = position.currentBalance - position.suppliedAmount;
  console.log("\n💰 Expected Fee Calculation:");
  console.log("  Interest earned:    ", ethers.formatUnits(interest, 6), "USDC");
  console.log("  Performance fee (10%):", ethers.formatUnits(interest / 10n, 6), "USDC");
  console.log("  - Vault owner (90%):", ethers.formatUnits(interest * 9n / 100n, 6), "USDC");
  console.log("  - Protocol (10%):  ", ethers.formatUnits(interest / 100n, 6), "USDC");

  // Step 2: Withdraw from Aave
  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: WITHDRAW ALL FROM AAVE");
  console.log("=".repeat(70));

  console.log("\nWithdrawing all USDC from Aave...");
  const withdrawTx = await lendingHub.withdrawAll(state.testVault.indexSwap, BASE_MAINNET.USDC, { gasLimit: 600000 });
  await withdrawTx.wait();
  console.log("  ✅ Withdraw from Aave executed");
  console.log("  Tx Hash:", withdrawTx.hash);

  await delay(2000);

  const vaultUsdcAfterAave = await usdc.balanceOf(state.testVault.indexSwap);
  console.log("\n📊 After Aave Withdrawal:");
  console.log("  Vault USDC Balance:", ethers.formatUnits(vaultUsdcAfterAave, 6));

  // Step 3: Withdraw from vault (triggers fee distribution)
  console.log("\n" + "=".repeat(70));
  console.log("STEP 3: WITHDRAW FROM VAULT (TRIGGERS FEE DISTRIBUTION)");
  console.log("=".repeat(70));

  console.log("\nWithdrawing all shares from vault...");
  const vaultWithdrawTx = await vault.withdraw(userShares);
  const vaultWithdrawReceipt = await vaultWithdrawTx.wait();
  console.log("  ✅ Vault withdrawal executed");
  console.log("  Tx Hash:", vaultWithdrawTx.hash);

  // Step 4: Parse fee distribution events
  console.log("\n" + "=".repeat(70));
  console.log("STEP 4: ANALYZE FEE DISTRIBUTION");
  console.log("=".repeat(70));

  let feeDistributed = false;
  for (const log of vaultWithdrawReceipt!.logs) {
    try {
      const parsed = feeCollector.interface.parseLog({ 
        topics: log.topics as string[], 
        data: log.data 
      });
      
      if (parsed?.name === "PerformanceFeeDistributed") {
        feeDistributed = true;
        console.log("\n🎉 FEE DISTRIBUTION EVENT FOUND!");
        console.log("\n  Event: PerformanceFeeDistributed");
        console.log("  Vault:              ", parsed.args[0]);
        console.log("  Token:              ", parsed.args[1]);
        console.log("  Total Fee Amount:   ", ethers.formatUnits(parsed.args[2], 6), "USDC");
        console.log("  Vault Owner Net:    ", ethers.formatUnits(parsed.args[3], 6), "USDC");
        console.log("  Protocol Fee:       ", ethers.formatUnits(parsed.args[4], 6), "USDC");
        console.log("  Vault Owner:        ", parsed.args[5]);
        console.log("  Protocol Recipient: ", parsed.args[6]);
        
        const totalFee = parsed.args[2];
        const vaultOwnerNet = parsed.args[3];
        const protocolFee = parsed.args[4];
        
        console.log("\n✅ FEE SPLIT VERIFICATION:");
        console.log("  Total fee:          ", ethers.formatUnits(totalFee, 6), "USDC");
        console.log("  Vault owner got:    ", ethers.formatUnits(vaultOwnerNet, 6), "USDC (", (Number(vaultOwnerNet) * 100 / Number(totalFee)).toFixed(2), "%)");
        console.log("  Protocol got:       ", ethers.formatUnits(protocolFee, 6), "USDC (", (Number(protocolFee) * 100 / Number(totalFee)).toFixed(2), "%)");
      }
    } catch {}
  }

  if (!feeDistributed) {
    console.log("\n⚠️ No PerformanceFeeDistributed event found");
    console.log("This means either:");
    console.log("  1. No profit was made (value <= cost basis)");
    console.log("  2. Performance fee is set to 0");
    console.log("  3. Fee collector is not configured");
  }

  // Step 5: Final balances
  console.log("\n" + "=".repeat(70));
  console.log("STEP 5: FINAL BALANCES");
  console.log("=".repeat(70));

  const walletUsdcAfter = await usdc.balanceOf(deployer.address);
  const vaultUsdcFinal = await usdc.balanceOf(state.testVault.indexSwap);
  const userSharesFinal = await vault.balanceOf(deployer.address);
  const feeRecipientBalance = await usdc.balanceOf(feeRecipient);

  console.log("\n📊 Final State:");
  console.log("  Wallet USDC After:  ", ethers.formatUnits(walletUsdcAfter, 6));
  console.log("  USDC Received:      ", ethers.formatUnits(walletUsdcAfter - walletUsdcBefore, 6));
  console.log("  Vault USDC:         ", ethers.formatUnits(vaultUsdcFinal, 6));
  console.log("  User Shares Left:   ", ethers.formatUnits(userSharesFinal, 18));
  console.log("  Fee Recipient USDC: ", ethers.formatUnits(feeRecipientBalance, 6));

  console.log("\n" + "=".repeat(70));
  console.log("✅ WITHDRAWAL COMPLETE");
  console.log("=".repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Error:", error);
    process.exit(1);
  });
