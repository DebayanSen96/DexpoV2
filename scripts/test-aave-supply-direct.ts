import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  AAVE_POOL_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  AAVE_AUSDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  
  console.log("Testing direct Aave supply from deployer wallet...\n");
  console.log("Deployer:", deployer.address);

  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const aUsdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.AAVE_AUSDC);

  const poolProviderAbi = ["function getPool() external view returns (address)"];
  const poolProvider = await ethers.getContractAt(poolProviderAbi, BASE_MAINNET.AAVE_POOL_PROVIDER);
  const poolAddress = await poolProvider.getPool();
  console.log("Aave Pool:", poolAddress);

  const poolAbi = [
    "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external"
  ];
  const pool = await ethers.getContractAt(poolAbi, poolAddress);

  const walletUsdc = await usdc.balanceOf(deployer.address);
  console.log("\nWallet USDC:", ethers.formatUnits(walletUsdc, 6));

  const amount = ethers.parseUnits("0.1", 6);
  
  console.log("\nApproving Aave pool...");
  await (await usdc.approve(poolAddress, amount)).wait();
  console.log("✅ Approved");

  const aUsdcBefore = await aUsdc.balanceOf(deployer.address);
  console.log("aUSDC before:", ethers.formatUnits(aUsdcBefore, 6));

  console.log("\nSupplying 0.1 USDC directly to Aave...");
  try {
    const tx = await pool.supply(BASE_MAINNET.USDC, amount, deployer.address, 0, { gasLimit: 300000 });
    console.log("TX hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("TX status:", receipt?.status === 1 ? "SUCCESS" : "FAILED");
    console.log("Gas used:", receipt?.gasUsed.toString());
  } catch (e: any) {
    console.log("Supply failed:", e.reason || e.message);
  }

  const aUsdcAfter = await aUsdc.balanceOf(deployer.address);
  console.log("\naUSDC after:", ethers.formatUnits(aUsdcAfter, 6));
  console.log("aUSDC received:", ethers.formatUnits(aUsdcAfter - aUsdcBefore, 6));

  if (aUsdcAfter > aUsdcBefore) {
    console.log("\n✅ Direct Aave supply works!");
    
    console.log("\nWithdrawing back...");
    const withdrawAbi = ["function withdraw(address asset, uint256 amount, address to) external returns (uint256)"];
    const poolWithdraw = await ethers.getContractAt(withdrawAbi, poolAddress);
    await (await poolWithdraw.withdraw(BASE_MAINNET.USDC, aUsdcAfter - aUsdcBefore, deployer.address, { gasLimit: 300000 })).wait();
    console.log("✅ Withdrawn");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
