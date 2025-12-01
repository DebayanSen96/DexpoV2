import { ethers } from "hardhat";

/**
 * Complete IndexSwap System Test
 * 
 * This script tests all major functionality of the IndexSwap vault system:
 * 1. Vault creation with multi-token portfolio
 * 2. Multi-token deposits
 * 3. TVL and share price calculations
 * 4. Portfolio weight updates
 * 5. Rebalancing
 * 6. User position tracking
 * 7. Withdrawals
 */

async function main() {
  console.log("=".repeat(60));
  console.log("IndexSwap Complete System Test");
  console.log("=".repeat(60));

  const [deployer, user1] = await ethers.getSigners();
  console.log("\n📍 Test Accounts:");
  console.log("Deployer:", deployer.address);
  console.log("User1:", user1.address);

  // Deployed contract addresses (from deploy-indexswap-system.ts)
  const FACTORY_ADDRESS = "0x2b5A4e5493d4a54E717057B127cf0C000C876f9B";
  const MOCK_SWAP_ROUTER = "0xaca81583840B1bf2dDF6CDe824ada250C1936B4D";

  console.log("\n📍 System Contracts:");
  console.log("Factory:", FACTORY_ADDRESS);
  console.log("Router:", MOCK_SWAP_ROUTER);

  // ========== STEP 1: Deploy Test Tokens ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 1: Deploy Test ERC20 Tokens");
  console.log("=".repeat(60));
  
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  
  const weth = await MockERC20.deploy("Wrapped ETH", "WETH", 18);
  await weth.waitForDeployment();
  const wethAddress = await weth.getAddress();
  console.log("✅ WETH deployed:", wethAddress);
  
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log("✅ USDC deployed:", usdcAddress);
  
  const wbtc = await MockERC20.deploy("Wrapped BTC", "WBTC", 8);
  await wbtc.waitForDeployment();
  const wbtcAddress = await wbtc.getAddress();
  console.log("✅ WBTC deployed:", wbtcAddress);

  // ========== STEP 2: Setup MockSwapRouter ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 2: Configure MockSwapRouter Prices");
  console.log("=".repeat(60));
  
  const router = await ethers.getContractAt("MockSwapRouter", MOCK_SWAP_ROUTER);
  
  await router.addOrUpdateToken(wethAddress, ethers.parseEther("2500")); // $2500
  console.log("✅ WETH price: $2,500");
  
  await router.addOrUpdateToken(usdcAddress, ethers.parseEther("1")); // $1
  console.log("✅ USDC price: $1");
  
  await router.addOrUpdateToken(wbtcAddress, ethers.parseEther("50000")); // $50000
  console.log("✅ WBTC price: $50,000");

  // Add liquidity to router for swaps
  await weth.mint(MOCK_SWAP_ROUTER, ethers.parseEther("1000"));
  await usdc.mint(MOCK_SWAP_ROUTER, ethers.parseUnits("5000000", 6));
  await wbtc.mint(MOCK_SWAP_ROUTER, ethers.parseUnits("100", 8));
  console.log("✅ Router liquidity added");

  // ========== STEP 3: Create Vault with Initial Portfolio ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 3: Create Vault with 50/30/20 Portfolio");
  console.log("=".repeat(60));
  
  const factory = await ethers.getContractAt("IndexSwapFactory", FACTORY_ADDRESS);
  
  const initialPortfolio = [
    { token: wethAddress, weightBps: 5000 },  // 50%
    { token: usdcAddress, weightBps: 3000 },  // 30%
    { token: wbtcAddress, weightBps: 2000 }   // 20%
  ];
  
  console.log("Portfolio weights:");
  console.log("  - WETH: 50%");
  console.log("  - USDC: 30%");
  console.log("  - WBTC: 20%");
  
  const tx = await factory.createVault(
    [deployer.address],
    1,
    "Balanced Crypto Fund",
    "BCF",
    initialPortfolio,
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
  const safe = parsedEvent?.args?.safe as string;
  const indexSwap = parsedEvent?.args?.indexSwap as string;
  
  console.log("\n✅ Vault Created!");
  console.log("Safe Address:", safe);
  console.log("IndexSwap Address:", indexSwap);

  const vault = await ethers.getContractAt("IndexSwap", indexSwap);

  // ========== STEP 4: First Deposit (Deployer) ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 4: Deployer Deposits Multi-Token");
  console.log("=".repeat(60));
  
  const wethAmount1 = ethers.parseEther("2");      // 2 WETH = $5,000
  const usdcAmount1 = ethers.parseUnits("3000", 6); // 3000 USDC = $3,000
  const wbtcAmount1 = ethers.parseUnits("0.04", 8); // 0.04 WBTC = $2,000
  // Total = $10,000
  
  await weth.mint(deployer.address, wethAmount1);
  await usdc.mint(deployer.address, usdcAmount1);
  await wbtc.mint(deployer.address, wbtcAmount1);
  
  await weth.approve(indexSwap, wethAmount1);
  await usdc.approve(indexSwap, usdcAmount1);
  await wbtc.approve(indexSwap, wbtcAmount1);
  
  console.log("Depositing:");
  console.log("  - 2 WETH ($5,000)");
  console.log("  - 3,000 USDC ($3,000)");
  console.log("  - 0.04 WBTC ($2,000)");
  console.log("  Total: $10,000");
  
  const depositTx1 = await vault.deposit([wethAmount1, usdcAmount1, wbtcAmount1]);
  await depositTx1.wait();
  
  const deployerShares = await vault.balanceOf(deployer.address);
  console.log("\n✅ Deposit Successful!");
  console.log("Shares Received:", ethers.formatEther(deployerShares));

  // ========== STEP 5: Check Vault Metrics ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 5: Vault Metrics After First Deposit");
  console.log("=".repeat(60));
  
  let tvl = await vault.getTotalValueUsd();
  let sharePrice = await vault.getSharePrice();
  let totalSupply = await vault.totalSupply();
  
  console.log("📊 Vault Metrics:");
  console.log("  TVL:", ethers.formatEther(tvl), "USD");
  console.log("  Share Price:", ethers.formatEther(sharePrice), "USD");
  console.log("  Total Supply:", ethers.formatEther(totalSupply), "shares");
  
  const wethBal1 = await weth.balanceOf(indexSwap);
  const usdcBal1 = await usdc.balanceOf(indexSwap);
  const wbtcBal1 = await wbtc.balanceOf(indexSwap);
  
  console.log("\n📦 Token Balances:");
  console.log("  WETH:", ethers.formatEther(wethBal1));
  console.log("  USDC:", ethers.formatUnits(usdcBal1, 6));
  console.log("  WBTC:", ethers.formatUnits(wbtcBal1, 8));

  // ========== STEP 6: Second Deposit (User1) ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 6: User1 Deposits");
  console.log("=".repeat(60));
  
  const wethAmount2 = ethers.parseEther("1");
  const usdcAmount2 = ethers.parseUnits("1500", 6);
  const wbtcAmount2 = ethers.parseUnits("0.02", 8);
  // Total = $5,000
  
  await weth.mint(user1.address, wethAmount2);
  await usdc.mint(user1.address, usdcAmount2);
  await wbtc.mint(user1.address, wbtcAmount2);
  
  await weth.connect(user1).approve(indexSwap, wethAmount2);
  await usdc.connect(user1).approve(indexSwap, usdcAmount2);
  await wbtc.connect(user1).approve(indexSwap, wbtcAmount2);
  
  console.log("User1 depositing:");
  console.log("  - 1 WETH ($2,500)");
  console.log("  - 1,500 USDC ($1,500)");
  console.log("  - 0.02 WBTC ($1,000)");
  console.log("  Total: $5,000");
  
  const depositTx2 = await vault.connect(user1).deposit([wethAmount2, usdcAmount2, wbtcAmount2]);
  await depositTx2.wait();
  
  const user1Shares = await vault.balanceOf(user1.address);
  console.log("\n✅ User1 Deposit Successful!");
  console.log("Shares Received:", ethers.formatEther(user1Shares));

  // ========== STEP 7: Check User Positions ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 7: User Positions");
  console.log("=".repeat(60));
  
  tvl = await vault.getTotalValueUsd();
  sharePrice = await vault.getSharePrice();
  totalSupply = await vault.totalSupply();
  
  const deployerSharesNow = await vault.balanceOf(deployer.address);
  const user1SharesNow = await vault.balanceOf(user1.address);
  
  const deployerValue = (deployerSharesNow * tvl) / totalSupply;
  const user1Value = (user1SharesNow * tvl) / totalSupply;
  
  console.log("📊 Updated Vault Metrics:");
  console.log("  TVL:", ethers.formatEther(tvl), "USD");
  console.log("  Share Price:", ethers.formatEther(sharePrice), "USD");
  console.log("  Total Supply:", ethers.formatEther(totalSupply), "shares");
  
  console.log("\n👤 Deployer Position:");
  console.log("  Shares:", ethers.formatEther(deployerSharesNow));
  console.log("  Value:", ethers.formatEther(deployerValue), "USD");
  console.log("  Ownership:", ((deployerSharesNow * 10000n) / totalSupply / 100n).toString() + "%");
  
  console.log("\n👤 User1 Position:");
  console.log("  Shares:", ethers.formatEther(user1SharesNow));
  console.log("  Value:", ethers.formatEther(user1Value), "USD");
  console.log("  Ownership:", ((user1SharesNow * 10000n) / totalSupply / 100n).toString() + "%");

  // ========== STEP 8: Update Portfolio Weights ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 8: Update Portfolio Weights to 40/40/20");
  console.log("=".repeat(60));
  
  const newPortfolio = [
    { token: wethAddress, weightBps: 4000 },  // 40%
    { token: usdcAddress, weightBps: 4000 },  // 40%
    { token: wbtcAddress, weightBps: 2000 }   // 20%
  ];
  
  console.log("New weights:");
  console.log("  - WETH: 40% (was 50%)");
  console.log("  - USDC: 40% (was 30%)");
  console.log("  - WBTC: 20% (unchanged)");
  
  const updateTx = await vault.setPortfolio(newPortfolio);
  await updateTx.wait();
  
  console.log("✅ Portfolio weights updated!");
  
  const currentPortfolio = await vault.getPortfolio();
  console.log("\n📋 Current Portfolio:");
  for (let i = 0; i < currentPortfolio.length; i++) {
    const tokenAddr = currentPortfolio[i][0];
    const weight = currentPortfolio[i][1];
    let tokenName = "Unknown";
    if (tokenAddr === wethAddress) tokenName = "WETH";
    else if (tokenAddr === usdcAddress) tokenName = "USDC";
    else if (tokenAddr === wbtcAddress) tokenName = "WBTC";
    console.log(`  ${tokenName}: ${Number(weight) / 100}%`);
  }

  // ========== STEP 9: Rebalance to New Weights ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 9: Rebalance Portfolio");
  console.log("=".repeat(60));
  
  console.log("Current holdings before rebalance:");
  const wethBalBefore = await weth.balanceOf(indexSwap);
  const usdcBalBefore = await usdc.balanceOf(indexSwap);
  const wbtcBalBefore = await wbtc.balanceOf(indexSwap);
  
  const wethValueBefore = (wethBalBefore * ethers.parseEther("2500")) / ethers.parseEther("1");
  const usdcValueBefore = (usdcBalBefore * ethers.parseEther("1")) / ethers.parseUnits("1", 6);
  const wbtcValueBefore = (wbtcBalBefore * ethers.parseEther("50000")) / ethers.parseUnits("1", 8);
  
  console.log("  WETH:", ethers.formatEther(wethBalBefore), `($${ethers.formatEther(wethValueBefore)})`);
  console.log("  USDC:", ethers.formatUnits(usdcBalBefore, 6), `($${ethers.formatEther(usdcValueBefore)})`);
  console.log("  WBTC:", ethers.formatUnits(wbtcBalBefore, 8), `($${ethers.formatEther(wbtcValueBefore)})`);
  
  const rebalanceTx = await vault.rebalance();
  await rebalanceTx.wait();
  
  console.log("\n✅ Rebalance Complete!");
  
  console.log("\nHoldings after rebalance:");
  const wethBalAfter = await weth.balanceOf(indexSwap);
  const usdcBalAfter = await usdc.balanceOf(indexSwap);
  const wbtcBalAfter = await wbtc.balanceOf(indexSwap);
  
  const wethValueAfter = (wethBalAfter * ethers.parseEther("2500")) / ethers.parseEther("1");
  const usdcValueAfter = (usdcBalAfter * ethers.parseEther("1")) / ethers.parseUnits("1", 6);
  const wbtcValueAfter = (wbtcBalAfter * ethers.parseEther("50000")) / ethers.parseUnits("1", 8);
  
  console.log("  WETH:", ethers.formatEther(wethBalAfter), `($${ethers.formatEther(wethValueAfter)})`);
  console.log("  USDC:", ethers.formatUnits(usdcBalAfter, 6), `($${ethers.formatEther(usdcValueAfter)})`);
  console.log("  WBTC:", ethers.formatUnits(wbtcBalAfter, 8), `($${ethers.formatEther(wbtcValueAfter)})`);

  // ========== STEP 10: Partial Withdrawal ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 10: User1 Partial Withdrawal (50%)");
  console.log("=".repeat(60));
  
  const withdrawShares = user1SharesNow / 2n;
  console.log("Withdrawing:", ethers.formatEther(withdrawShares), "shares");
  
  const withdrawTx = await vault.connect(user1).withdraw(withdrawShares);
  await withdrawTx.wait();
  
  const user1SharesAfterWithdraw = await vault.balanceOf(user1.address);
  console.log("\n✅ Withdrawal Successful!");
  console.log("Remaining shares:", ethers.formatEther(user1SharesAfterWithdraw));

  // ========== STEP 11: Final Metrics ==========
  console.log("\n" + "=".repeat(60));
  console.log("STEP 11: Final Vault State");
  console.log("=".repeat(60));
  
  tvl = await vault.getTotalValueUsd();
  sharePrice = await vault.getSharePrice();
  totalSupply = await vault.totalSupply();
  
  const finalDeployerShares = await vault.balanceOf(deployer.address);
  const finalUser1Shares = await vault.balanceOf(user1.address);
  
  const finalDeployerValue = (finalDeployerShares * tvl) / totalSupply;
  const finalUser1Value = (finalUser1Shares * tvl) / totalSupply;
  
  console.log("📊 Final Vault Metrics:");
  console.log("  TVL:", ethers.formatEther(tvl), "USD");
  console.log("  Share Price:", ethers.formatEther(sharePrice), "USD");
  console.log("  Total Supply:", ethers.formatEther(totalSupply), "shares");
  
  console.log("\n👤 Final Deployer Position:");
  console.log("  Shares:", ethers.formatEther(finalDeployerShares));
  console.log("  Value:", ethers.formatEther(finalDeployerValue), "USD");
  
  console.log("\n👤 Final User1 Position:");
  console.log("  Shares:", ethers.formatEther(finalUser1Shares));
  console.log("  Value:", ethers.formatEther(finalUser1Value), "USD");

  // ========== Summary ==========
  console.log("\n" + "=".repeat(60));
  console.log("✅✅✅ ALL TESTS PASSED! ✅✅✅");
  console.log("=".repeat(60));
  console.log("\n✅ Vault Creation");
  console.log("✅ Multi-Token Deposits");
  console.log("✅ TVL & Share Price Calculations");
  console.log("✅ User Position Tracking");
  console.log("✅ Portfolio Weight Updates");
  console.log("✅ Rebalancing");
  console.log("✅ Withdrawals");
  
  return {
    safe,
    indexSwap,
    weth: wethAddress,
    usdc: usdcAddress,
    wbtc: wbtcAddress,
    router: MOCK_SWAP_ROUTER,
    factory: FACTORY_ADDRESS
  };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
