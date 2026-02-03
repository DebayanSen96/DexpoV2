import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  AAVE_AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
};

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("VAULT FLOW TESTS - Single Deposit, Swap Tests, Aave Lending");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  console.log("\nDeployer:", deployer.address);
  console.log("Vault:", state.testVault.indexSwap);

  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const weth = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.WETH);
  const aUsdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.AAVE_AUSDC);

  const swapHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub",
    state.swapHub
  );
  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );
  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap
  );
  const oracle = await ethers.getContractAt(
    "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    state.chainlinkOracle
  );

  const usdcBalance = await usdc.balanceOf(deployer.address);
  console.log("Wallet USDC Balance:", ethers.formatUnits(usdcBalance, 6), "USDC");

  if (usdcBalance < ethers.parseUnits("1", 6)) {
    console.log("\n⚠️ Insufficient USDC balance (need at least 1 USDC)");
    process.exit(1);
  }

  console.log("\n--- Checking Oracle Prices ---");
  const usdcPrice = await oracle.priceUsdE18(BASE_MAINNET.USDC);
  console.log("USDC Price:", ethers.formatUnits(usdcPrice, 18), "USD");
  const wethPrice = await oracle.priceUsdE18(BASE_MAINNET.WETH);
  console.log("WETH Price:", ethers.formatUnits(wethPrice, 18), "USD");

  const ONE_USDC = ethers.parseUnits("1", 6);
  const QUARTER_USDC = ethers.parseUnits("0.25", 6);
  const vaultAddress = state.testVault.indexSwap;
  const AERODROME_ADAPTER_ID = state.adapterIds.aerodrome;
  const UNISWAP_ADAPTER_ID = state.adapterIds.uniswapV3;
  const AAVE_ADAPTER_ID = state.adapterIds.aaveV3;

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: Deposit 1 USDC to vault (ONCE)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("STEP 1: DEPOSIT 1 USDC TO VAULT");
  console.log("=".repeat(70));

  console.log("\nApproving and depositing 1 USDC...");
  await (await usdc.approve(vaultAddress, ONE_USDC)).wait();
  await delay(2000);
  await (await vault.deposit([ONE_USDC, 0])).wait();
  console.log("  ✅ Deposited 1 USDC to vault");
  await delay(2000);

  let vaultUsdc = await usdc.balanceOf(vaultAddress);
  let vaultWeth = await weth.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  Vault WETH:", ethers.formatUnits(vaultWeth, 18));

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: Uniswap V3 Swap Flow (0.25 USDC -> WETH -> USDC)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: UNISWAP V3 SWAP (0.25 USDC -> WETH -> USDC)");
  console.log("=".repeat(70));

  console.log("\n[2.1] Swapping 0.25 USDC -> WETH via Uniswap V3...");
  await (await vault.approveToken(BASE_MAINNET.USDC, state.swapHub, QUARTER_USDC)).wait();
  await delay(2000);
  await (await swapHub.swap(vaultAddress, BASE_MAINNET.USDC, BASE_MAINNET.WETH, QUARTER_USDC, 0, UNISWAP_ADAPTER_ID, { gasLimit: 500000 })).wait();
  console.log("  ✅ Swap executed via Uniswap V3");
  await delay(2000);

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  vaultWeth = await weth.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  Vault WETH:", ethers.formatUnits(vaultWeth, 18));

  console.log("\n[2.2] Swapping WETH back to USDC via Uniswap V3...");
  await (await vault.approveToken(BASE_MAINNET.WETH, state.swapHub, vaultWeth)).wait();
  await delay(2000);
  await (await swapHub.swap(vaultAddress, BASE_MAINNET.WETH, BASE_MAINNET.USDC, vaultWeth, 0, UNISWAP_ADAPTER_ID, { gasLimit: 500000 })).wait();
  console.log("  ✅ Swap back executed via Uniswap V3");
  await delay(2000);

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  vaultWeth = await weth.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  Vault WETH:", ethers.formatUnits(vaultWeth, 18));
  console.log("  ✅ UNISWAP V3 SWAP TEST COMPLETE");

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: Aerodrome Swap Flow (0.25 USDC -> WETH -> USDC)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("STEP 3: AERODROME SWAP (0.25 USDC -> WETH -> USDC)");
  console.log("=".repeat(70));

  console.log("\n[3.1] Swapping 0.25 USDC -> WETH via Aerodrome...");
  await (await vault.approveToken(BASE_MAINNET.USDC, state.swapHub, QUARTER_USDC)).wait();
  await delay(2000);
  await (await swapHub.swap(vaultAddress, BASE_MAINNET.USDC, BASE_MAINNET.WETH, QUARTER_USDC, 0, AERODROME_ADAPTER_ID, { gasLimit: 500000 })).wait();
  console.log("  ✅ Swap executed via Aerodrome");
  await delay(2000);

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  vaultWeth = await weth.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  Vault WETH:", ethers.formatUnits(vaultWeth, 18));

  console.log("\n[3.2] Swapping WETH back to USDC via Aerodrome...");
  await (await vault.approveToken(BASE_MAINNET.WETH, state.swapHub, vaultWeth)).wait();
  await delay(2000);
  await (await swapHub.swap(vaultAddress, BASE_MAINNET.WETH, BASE_MAINNET.USDC, vaultWeth, 0, AERODROME_ADAPTER_ID, { gasLimit: 500000 })).wait();
  console.log("  ✅ Swap back executed via Aerodrome");
  await delay(2000);

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  vaultWeth = await weth.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  Vault WETH:", ethers.formatUnits(vaultWeth, 18));
  console.log("  ✅ AERODROME SWAP TEST COMPLETE");

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: Aave V3 Lending (Supply ALL remaining USDC - NO WITHDRAW)
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("STEP 4: AAVE V3 LENDING (Supply remaining USDC - NO WITHDRAW)");
  console.log("=".repeat(70));

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  console.log("\n  Vault USDC available for lending:", ethers.formatUnits(vaultUsdc, 6));

  if (vaultUsdc > 0n) {
    console.log("\n[4.1] Supplying all USDC to Aave V3...");
    await (await vault.approveToken(BASE_MAINNET.USDC, state.lendingHub, vaultUsdc)).wait();
    await delay(2000);
    await (await lendingHub.supply(vaultAddress, BASE_MAINNET.USDC, vaultUsdc, AAVE_ADAPTER_ID, { gasLimit: 600000 })).wait();
    console.log("  ✅ Supply executed");
    await delay(2000);

    const hubAUsdc = await aUsdc.balanceOf(state.lendingHub);
    console.log("  LendingHub aUSDC balance:", ethers.formatUnits(hubAUsdc, 6));

    const position = await lendingHub.getPosition(vaultAddress, BASE_MAINNET.USDC);
    console.log("\n  📊 Aave Position:");
    console.log("    Supplied Amount:", ethers.formatUnits(position.suppliedAmount, 6), "USDC");
    console.log("    Current Balance:", ethers.formatUnits(position.currentBalance, 6), "USDC");
    console.log("    Shares:", position.shares.toString());
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FINAL STATUS
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("FINAL STATUS");
  console.log("=".repeat(70));

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  vaultWeth = await weth.balanceOf(vaultAddress);
  const vaultShares = await vault.balanceOf(deployer.address);
  const position = await lendingHub.getPosition(vaultAddress, BASE_MAINNET.USDC);

  console.log("\n📊 Vault Holdings:");
  console.log("  USDC in vault:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  WETH in vault:", ethers.formatUnits(vaultWeth, 18));
  console.log("  USDC in Aave:", ethers.formatUnits(position.currentBalance, 6));
  console.log("  User shares:", ethers.formatUnits(vaultShares, 18));

  console.log("\n" + "=".repeat(70));
  console.log("ALL TESTS COMPLETE ✅");
  console.log("=".repeat(70));
  console.log("\nSummary:");
  console.log("  ✅ Deposited 1 USDC to vault");
  console.log("  ✅ Uniswap V3 Swap: 0.25 USDC -> WETH -> USDC");
  console.log("  ✅ Aerodrome Swap: 0.25 USDC -> WETH -> USDC");
  console.log("  ✅ Aave V3 Lending: Supplied remaining USDC");
  console.log("\n⏳ USDC is now earning interest on Aave V3.");
  console.log("   Run 'check-aave-position.ts' after 1 day to see profit.");
  console.log("   Then withdraw to test fee distribution flow.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  });
