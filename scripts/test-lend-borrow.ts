import { ethers } from "hardhat";

/**
 * Test Lend/Borrow Module Functionality
 */

async function main() {
  console.log("=".repeat(60));
  console.log("Lend/Borrow Module Test");
  console.log("=".repeat(60));

  const [deployer] = await ethers.getSigners();
  
  const FACTORY_ADDRESS = "0x0fe4223AD99dF788A6Dcad148eB4086E6389cEB6";
  const MOCK_SWAP_ROUTER = "0xc7cDb7A2E5dDa1B7A0E792Fe1ef08ED20A6F56D4";
  const LEND_MODULE = "0x8e264821AFa98DD104eEcfcfa7FD9f8D8B320adA";
  const BORROW_MODULE = "0x871ACbEabBaf8Bed65c22ba7132beCFaBf8c27B5";

  // Deploy test tokens
  console.log("\n1. Deploy test tokens...");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  
  const usdc = await MockERC20.deploy("USDC", "USDC", 6);
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log("USDC:", usdcAddress);
  
  const weth = await MockERC20.deploy("WETH", "WETH", 18);
  await weth.waitForDeployment();
  const wethAddress = await weth.getAddress();
  console.log("WETH:", wethAddress);

  // Setup router
  console.log("\n2. Setup router prices...");
  const router = await ethers.getContractAt("MockSwapRouter", MOCK_SWAP_ROUTER);
  await router.addOrUpdateToken(usdcAddress, ethers.parseEther("1"));
  await router.addOrUpdateToken(wethAddress, ethers.parseEther("2500"));
  console.log("✅ Prices set");

  // Create vault
  console.log("\n3. Create vault...");
  const factory = await ethers.getContractAt("IndexSwapFactory", FACTORY_ADDRESS);
  
  const portfolio = [
    { token: usdcAddress, weightBps: 5000 },
    { token: wethAddress, weightBps: 5000 }
  ];
  
  const tx = await factory.createVault(
    [deployer.address],
    1,
    "Test Vault",
    "TV",
    portfolio,
    0,
    ethers.ZeroAddress
  );
  
  const receipt = await tx.wait();
  const event = receipt?.logs.find((log: any) => {
    try {
      const parsed = factory.interface.parseLog(log);
      return parsed?.name === "VaultCreated";
    } catch {
      return false;
    }
  });
  
  const parsedEvent = factory.interface.parseLog(event!);
  const indexSwap = parsedEvent?.args?.indexSwap as string;
  console.log("Vault:", indexSwap);

  // Deposit to vault
  console.log("\n4. Deposit to vault...");
  const usdcAmount = ethers.parseUnits("10000", 6);
  const wethAmount = ethers.parseEther("4");
  
  await usdc.mint(deployer.address, usdcAmount);
  await weth.mint(deployer.address, wethAmount);
  
  await usdc.approve(indexSwap, usdcAmount);
  await weth.approve(indexSwap, wethAmount);
  
  const vault = await ethers.getContractAt("IndexSwap", indexSwap);
  await vault.deposit([usdcAmount, wethAmount]);
  
  console.log("✅ Deposited 10,000 USDC + 4 WETH");

  // Check initial balances
  console.log("\n5. Initial vault balances:");
  let usdcBal = await usdc.balanceOf(indexSwap);
  let wethBal = await weth.balanceOf(indexSwap);
  console.log("USDC:", ethers.formatUnits(usdcBal, 6));
  console.log("WETH:", ethers.formatEther(wethBal));

  // Test Lending
  console.log("\n" + "=".repeat(60));
  console.log("LENDING TEST");
  console.log("=".repeat(60));
  
  const lendModule = await ethers.getContractAt("LendModule", LEND_MODULE);
  
  console.log("\n6. Lend 5,000 USDC...");
  const lendAmount = ethers.parseUnits("5000", 6);
  
  // Vault needs to approve module
  const approveTx = await vault.approveToken(usdcAddress, LEND_MODULE, lendAmount);
  await approveTx.wait();
  
  const lendTx = await lendModule.lend(indexSwap, usdcAddress, lendAmount);
  await lendTx.wait();
  console.log("✅ Lent 5,000 USDC");

  // Check position
  const lendPos = await lendModule.getPosition(indexSwap, usdcAddress);
  console.log("\nLend Position:");
  console.log("  Principal:", ethers.formatUnits(lendPos.principal, 6), "USDC");
  console.log("  APR:", Number(lendPos.aprBps) / 100, "%");
  console.log("  Last Accrual:", new Date(Number(lendPos.lastAccrualTime) * 1000).toISOString());

  // Check vault balance after lending
  usdcBal = await usdc.balanceOf(indexSwap);
  console.log("\nVault USDC balance after lending:", ethers.formatUnits(usdcBal, 6));

  // Wait a bit and check accrued interest
  console.log("\n7. Simulating time passage (mining 100 blocks)...");
  for (let i = 0; i < 100; i++) {
    await ethers.provider.send("evm_mine", []);
  }
  
  const accruedValue = await lendModule.getPositionValue(indexSwap, usdcAddress);
  console.log("Accrued value:", ethers.formatUnits(accruedValue, 6), "USDC");
  console.log("Interest earned:", ethers.formatUnits(accruedValue - lendPos.principal, 6), "USDC");

  // Test Borrowing
  console.log("\n" + "=".repeat(60));
  console.log("BORROWING TEST");
  console.log("=".repeat(60));
  
  const borrowModule = await ethers.getContractAt("BorrowModule", BORROW_MODULE);
  
  console.log("\n8. Borrow 2 WETH...");
  const borrowAmount = ethers.parseEther("2");
  
  // Mint WETH to borrow module (simulating lending pool)
  await weth.mint(BORROW_MODULE, ethers.parseEther("100"));
  
  const borrowTx = await borrowModule.borrow(indexSwap, wethAddress, borrowAmount);
  await borrowTx.wait();
  console.log("✅ Borrowed 2 WETH");

  // Check position
  const borrowPos = await borrowModule.getPosition(indexSwap, wethAddress);
  console.log("\nBorrow Position:");
  console.log("  Principal:", ethers.formatEther(borrowPos.principal), "WETH");
  console.log("  APR:", Number(borrowPos.aprBps) / 100, "%");
  console.log("  Last Accrual:", new Date(Number(borrowPos.lastAccrualTime) * 1000).toISOString());

  // Check vault balance after borrowing
  wethBal = await weth.balanceOf(indexSwap);
  console.log("\nVault WETH balance after borrowing:", ethers.formatEther(wethBal));

  // Wait and check accrued debt
  console.log("\n9. Simulating time passage (mining 100 blocks)...");
  for (let i = 0; i < 100; i++) {
    await ethers.provider.send("evm_mine", []);
  }
  
  const accruedDebt = await borrowModule.getPositionValue(indexSwap, wethAddress);
  console.log("Accrued debt:", ethers.formatEther(accruedDebt), "WETH");
  console.log("Interest owed:", ethers.formatEther(accruedDebt - borrowPos.principal), "WETH");

  // Calculate TVL with lending/borrowing
  console.log("\n" + "=".repeat(60));
  console.log("TVL CALCULATION");
  console.log("=".repeat(60));
  
  const tvl = await vault.getTotalValueUsd();
  console.log("\n10. Total Value Locked:", ethers.formatEther(tvl), "USD");
  
  // Manual calculation
  usdcBal = await usdc.balanceOf(indexSwap);
  wethBal = await weth.balanceOf(indexSwap);
  
  const usdcValue = (usdcBal * ethers.parseEther("1")) / ethers.parseUnits("1", 6);
  const wethValue = (wethBal * ethers.parseEther("2500")) / ethers.parseEther("1");
  const lendValue = (accruedValue * ethers.parseEther("1")) / ethers.parseUnits("1", 6);
  const borrowValue = (accruedDebt * ethers.parseEther("2500")) / ethers.parseEther("1");
  
  console.log("\nBreakdown:");
  console.log("  USDC holdings:", ethers.formatEther(usdcValue), "USD");
  console.log("  WETH holdings:", ethers.formatEther(wethValue), "USD");
  console.log("  USDC lent:", ethers.formatEther(lendValue), "USD");
  console.log("  WETH borrowed:", ethers.formatEther(borrowValue), "USD");
  console.log("  Net TVL:", ethers.formatEther(usdcValue + wethValue + lendValue - borrowValue), "USD");

  // Repay borrow
  console.log("\n11. Repay 1 WETH...");
  const repayAmount = ethers.parseEther("1");
  await vault.approveToken(wethAddress, BORROW_MODULE, repayAmount);
  
  const repayTx = await borrowModule.repay(indexSwap, wethAddress, repayAmount);
  await repayTx.wait();
  console.log("✅ Repaid 1 WETH");
  
  const newBorrowPos = await borrowModule.getPosition(indexSwap, wethAddress);
  console.log("Remaining debt:", ethers.formatEther(newBorrowPos.principal), "WETH");

  // Withdraw lent funds (repay to get funds back)
  console.log("\n12. Withdraw 2,500 USDC from lending...");
  const withdrawAmount = ethers.parseUnits("2500", 6);
  
  // Mint USDC to lend module (simulating lending pool repayment)
  await usdc.mint(LEND_MODULE, withdrawAmount);
  
  const withdrawTx = await lendModule.repay(indexSwap, usdcAddress, withdrawAmount);
  await withdrawTx.wait();
  console.log("✅ Withdrawn 2,500 USDC");
  
  const newLendPos = await lendModule.getPosition(indexSwap, usdcAddress);
  console.log("Remaining lent:", ethers.formatUnits(newLendPos.principal, 6), "USDC");

  console.log("\n" + "=".repeat(60));
  console.log("✅✅✅ LEND/BORROW TESTS PASSED! ✅✅✅");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
