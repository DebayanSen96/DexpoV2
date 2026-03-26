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
  console.log("PROTOCOL FLOW TESTS - Aerodrome, Uniswap V3, Aave");
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
    "contracts/v3/mainnet/base-mainnet/modules/swap/SwapHub.sol:SwapHub",
    state.swapHub
  );
  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/base-mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );
  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/base-mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap
  );
  const oracle = await ethers.getContractAt(
    "contracts/v3/mainnet/base-mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    state.chainlinkOracle
  );

  const usdcBalance = await usdc.balanceOf(deployer.address);
  console.log("USDC Balance:", ethers.formatUnits(usdcBalance, 6), "USDC");

  if (usdcBalance < ethers.parseUnits("3", 6)) {
    console.log("\n⚠️ Insufficient USDC balance for tests (need at least 3 USDC)");
    process.exit(1);
  }

  console.log("\n--- Checking Oracle Prices ---");
  const usdcPrice = await oracle.priceUsdE18(BASE_MAINNET.USDC);
  console.log("USDC Price:", ethers.formatUnits(usdcPrice, 18), "USD");
  const wethPrice = await oracle.priceUsdE18(BASE_MAINNET.WETH);
  console.log("WETH Price:", ethers.formatUnits(wethPrice, 18), "USD");

  const ONE_USDC = ethers.parseUnits("1", 6);
  const HALF_USDC = ethers.parseUnits("0.5", 6);
  const vaultAddress = state.testVault.indexSwap;
  const AERODROME_ADAPTER_ID = state.adapterIds.aerodrome;
  const UNISWAP_ADAPTER_ID = state.adapterIds.uniswapV3;
  const AAVE_ADAPTER_ID = state.adapterIds.aaveV3;

  // ═══════════════════════════════════════════════════════════════════════
  // TEST 1: Aerodrome Swap Flow
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("TEST 1: AERODROME SWAP FLOW ($1)");
  console.log("=".repeat(70));

  console.log("\n[1.1] Depositing 1 USDC to vault...");
  await (await usdc.approve(vaultAddress, ONE_USDC)).wait();
  await delay(2000);
  await (await vault.deposit([ONE_USDC, 0])).wait();
  console.log("  ✅ Deposited 1 USDC");
  await delay(2000);

  let vaultUsdc = await usdc.balanceOf(vaultAddress);
  let vaultWeth = await weth.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));

  console.log("\n[1.2] Swapping 0.5 USDC -> WETH via Aerodrome...");
  await (await vault.approveToken(BASE_MAINNET.USDC, state.swapHub, HALF_USDC)).wait();
  await delay(2000);
  await (await swapHub.swap(vaultAddress, BASE_MAINNET.USDC, BASE_MAINNET.WETH, HALF_USDC, 0, AERODROME_ADAPTER_ID, { gasLimit: 500000 })).wait();
  console.log("  ✅ Swap executed via Aerodrome");
  await delay(2000);

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  vaultWeth = await weth.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  Vault WETH:", ethers.formatUnits(vaultWeth, 18));

  console.log("\n[1.3] Swapping WETH back to USDC via Aerodrome...");
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
  // TEST 2: Uniswap V3 Swap Flow
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("TEST 2: UNISWAP V3 SWAP FLOW ($1)");
  console.log("=".repeat(70));

  console.log("\n[2.1] Depositing 1 USDC to vault...");
  await (await usdc.approve(vaultAddress, ONE_USDC)).wait();
  await delay(2000);
  await (await vault.deposit([ONE_USDC, 0])).wait();
  console.log("  ✅ Deposited 1 USDC");
  await delay(2000);

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));

  console.log("\n[2.2] Swapping 0.5 USDC -> WETH via Uniswap V3...");
  await (await vault.approveToken(BASE_MAINNET.USDC, state.swapHub, HALF_USDC)).wait();
  await delay(2000);
  await (await swapHub.swap(vaultAddress, BASE_MAINNET.USDC, BASE_MAINNET.WETH, HALF_USDC, 0, UNISWAP_ADAPTER_ID, { gasLimit: 500000 })).wait();
  console.log("  ✅ Swap executed via Uniswap V3");
  await delay(2000);

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  vaultWeth = await weth.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  Vault WETH:", ethers.formatUnits(vaultWeth, 18));

  console.log("\n[2.3] Swapping WETH back to USDC via Uniswap V3...");
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
  // TEST 3: Aave Lending Flow
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("TEST 3: AAVE LENDING FLOW ($1)");
  console.log("=".repeat(70));

  console.log("\n[3.1] Depositing 1 USDC to vault...");
  await (await usdc.approve(vaultAddress, ONE_USDC)).wait();
  await delay(1500);
  await (await vault.deposit([ONE_USDC, 0])).wait();
  console.log("  ✅ Deposited 1 USDC");
  await delay(1500);

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  console.log("  Vault USDC:", ethers.formatUnits(vaultUsdc, 6));

  console.log("\n[3.2] Supplying 1 USDC to Aave via LendingHub...");
  await (await vault.approveToken(BASE_MAINNET.USDC, state.lendingHub, ONE_USDC)).wait();
  await delay(2000);
  await (await lendingHub.supply(vaultAddress, BASE_MAINNET.USDC, ONE_USDC, AAVE_ADAPTER_ID, { gasLimit: 600000 })).wait();
  console.log("  ✅ Supply executed");
  await delay(2000);

  const hubAUsdc = await aUsdc.balanceOf(state.lendingHub);
  console.log("  LendingHub aUSDC balance:", ethers.formatUnits(hubAUsdc, 6));

  const position = await lendingHub.getPosition(vaultAddress, BASE_MAINNET.USDC);
  console.log("  Position - Supplied:", ethers.formatUnits(position.suppliedAmount, 6), "USDC");
  console.log("  Position - Current:", ethers.formatUnits(position.currentBalance, 6), "USDC");
  console.log("  Position - Shares:", position.shares.toString());

  console.log("\n[3.3] Withdrawing all from Aave...");
  await (await lendingHub.withdrawAll(vaultAddress, BASE_MAINNET.USDC, { gasLimit: 600000 })).wait();
  console.log("  ✅ Withdraw executed");
  await delay(2000);

  vaultUsdc = await usdc.balanceOf(vaultAddress);
  const positionAfter = await lendingHub.getPosition(vaultAddress, BASE_MAINNET.USDC);
  console.log("  Vault USDC after withdraw:", ethers.formatUnits(vaultUsdc, 6));
  console.log("  Position shares after:", positionAfter.shares.toString());
  console.log("  ✅ AAVE LENDING TEST COMPLETE");

  // ═══════════════════════════════════════════════════════════════════════
  // WITHDRAW ALL BACK TO WALLET
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(70));
  console.log("WITHDRAWING ALL FUNDS BACK TO WALLET");
  console.log("=".repeat(70));

  const shares = await vault.balanceOf(deployer.address);
  console.log("\nUser shares:", ethers.formatUnits(shares, 18));

  if (shares > 0n) {
    console.log("\nWithdrawing all shares...");
    await (await vault.withdraw(shares)).wait();
    console.log("  ✅ Withdrawal complete");
    await delay(1500);
  }

  const finalUsdcBalance = await usdc.balanceOf(deployer.address);
  const finalWethBalance = await weth.balanceOf(deployer.address);
  console.log("\n📊 Final Wallet Balances:");
  console.log("  USDC:", ethers.formatUnits(finalUsdcBalance, 6));
  console.log("  WETH:", ethers.formatUnits(finalWethBalance, 18));

  console.log("\n" + "=".repeat(70));
  console.log("ALL TESTS COMPLETE ✅");
  console.log("=".repeat(70));
  console.log("\nSummary:");
  console.log("  ✅ Aerodrome Swap: USDC -> WETH -> USDC");
  console.log("  ✅ Uniswap V3 Swap: USDC -> WETH -> USDC");
  console.log("  ✅ Aave Lending: Supply USDC -> Withdraw");
  console.log("  ✅ All funds withdrawn to wallet");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  });


