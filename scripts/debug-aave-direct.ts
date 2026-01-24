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
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  console.log("Checking Aave configuration...\n");

  const poolProviderAbi = ["function getPool() external view returns (address)"];
  const poolProvider = await ethers.getContractAt(poolProviderAbi, BASE_MAINNET.AAVE_POOL_PROVIDER);
  const poolAddress = await poolProvider.getPool();
  console.log("Aave Pool Address:", poolAddress);

  const poolAbi = [
    "function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))"
  ];
  const pool = await ethers.getContractAt(poolAbi, poolAddress);
  
  const reserveData = await pool.getReserveData(BASE_MAINNET.USDC);
  console.log("\nUSDC Reserve Data:");
  console.log("  aToken:", reserveData.aTokenAddress);
  console.log("  Expected:", BASE_MAINNET.AAVE_AUSDC);
  console.log("  Match:", reserveData.aTokenAddress.toLowerCase() === BASE_MAINNET.AAVE_AUSDC.toLowerCase());

  const aaveAdapter = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/lending/adapters/AaveV3Adapter.sol:AaveV3Adapter",
    state.aaveV3Adapter
  );
  
  const adapterAToken = await aaveAdapter.tokenToAToken(BASE_MAINNET.USDC);
  console.log("\nAdapter's aToken for USDC:", adapterAToken);
  console.log("Match with Aave:", adapterAToken.toLowerCase() === reserveData.aTokenAddress.toLowerCase());

  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const lendingHubUsdc = await usdc.balanceOf(state.lendingHub);
  console.log("\nLendingHub USDC balance:", ethers.formatUnits(lendingHubUsdc, 6));

  const adapterUsdc = await usdc.balanceOf(state.aaveV3Adapter);
  console.log("Adapter USDC balance:", ethers.formatUnits(adapterUsdc, 6));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
