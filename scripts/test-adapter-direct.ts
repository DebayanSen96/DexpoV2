import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AAVE_AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  console.log("Testing adapter supply directly (bypassing LendingHub)...\n");

  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const aUsdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.AAVE_AUSDC);

  const aaveAdapter = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter",
    state.aaveV3Adapter
  );

  console.log("Adapter:", state.aaveV3Adapter);
  console.log("LendingHub:", state.lendingHub);

  const hubAddress = await aaveAdapter.lendingHub();
  console.log("Adapter's hub:", hubAddress);

  const amount = ethers.parseUnits("0.1", 6);

  console.log("\nTransferring 0.1 USDC to LendingHub...");
  await (await usdc.transfer(state.lendingHub, amount)).wait();
  console.log("✅ Transferred");

  const hubUsdc = await usdc.balanceOf(state.lendingHub);
  console.log("Hub USDC:", ethers.formatUnits(hubUsdc, 6));

  console.log("\nApproving adapter from hub perspective...");
  const lendingHub = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub",
    state.lendingHub
  );

  const aUsdcBefore = await aUsdc.balanceOf(state.lendingHub);
  console.log("Hub aUSDC before:", ethers.formatUnits(aUsdcBefore, 6));

  console.log("\nCalling supply via LendingHub on vault...");
  const vault = state.testVault.indexSwap;
  const vaultContract = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    vault
  );

  const vaultUsdc = await usdc.balanceOf(vault);
  console.log("Vault USDC:", ethers.formatUnits(vaultUsdc, 6));

  if (vaultUsdc > 0n) {
    console.log("\nApproving hub from vault...");
    await (await vaultContract.approveToken(BASE_MAINNET.USDC, state.lendingHub, amount)).wait();
    console.log("✅ Approved");

    const allowance = await usdc.allowance(vault, state.lendingHub);
    console.log("Allowance:", ethers.formatUnits(allowance, 6));

    console.log("\nTrying supply with lower gas to see where it fails...");
    try {
      const tx = await lendingHub.supply(vault, BASE_MAINNET.USDC, amount, state.adapterIds.aaveV3, { gasLimit: 200000 });
      console.log("TX sent:", tx.hash);
      const receipt = await tx.wait();
      console.log("Status:", receipt?.status);
    } catch (e: any) {
      console.log("Failed at 200k gas:", e.reason || e.shortMessage || "unknown");
    }

    try {
      const tx = await lendingHub.supply(vault, BASE_MAINNET.USDC, amount, state.adapterIds.aaveV3, { gasLimit: 300000 });
      console.log("TX sent:", tx.hash);
      const receipt = await tx.wait();
      console.log("Status:", receipt?.status);
    } catch (e: any) {
      console.log("Failed at 300k gas:", e.reason || e.shortMessage || "unknown");
    }

    try {
      const tx = await lendingHub.supply(vault, BASE_MAINNET.USDC, amount, state.adapterIds.aaveV3, { gasLimit: 400000 });
      console.log("TX sent:", tx.hash);
      const receipt = await tx.wait();
      console.log("Status:", receipt?.status);
    } catch (e: any) {
      console.log("Failed at 400k gas:", e.reason || e.shortMessage || "unknown");
    }
  }

  const aUsdcAfter = await aUsdc.balanceOf(state.lendingHub);
  console.log("\nHub aUSDC after:", ethers.formatUnits(aUsdcAfter, 6));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
