import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json"), "utf8")
  );

  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap
  );
  const registry = await ethers.getContractAt(
    "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
    state.moduleRegistry
  );

  console.log("Vault:", state.testVault.indexSwap);
  console.log("ModuleRegistry:", state.moduleRegistry);
  console.log("SwapHub:", state.swapHub);

  const vaultRegistry = await vault.moduleRegistry();
  console.log("\nVault's moduleRegistry:", vaultRegistry);
  console.log("Match:", vaultRegistry === state.moduleRegistry);

  const registeredSwap = await registry.getSwapModule();
  console.log("\nRegistered SwapModule:", registeredSwap);
  console.log("Match:", registeredSwap === state.swapHub);

  const maxSlippage = await vault.maxSlippageBps();
  console.log("\nVault maxSlippageBps:", maxSlippage.toString());

  console.log("\nTrying static call to buyToken...");
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const vaultUsdc = await usdc.balanceOf(state.testVault.indexSwap);
  console.log("Vault USDC balance:", ethers.formatUnits(vaultUsdc, 6));

  if (vaultUsdc > 0n) {
    const amount = ethers.parseUnits("0.5", 6);
    try {
      const result = await vault.buyToken.staticCall(BASE_MAINNET.USDC, BASE_MAINNET.WETH, amount);
      console.log("Static call result:", result.toString());
    } catch (e: any) {
      console.log("Static call error:", e.reason || e.message);
      if (e.data) console.log("Error data:", e.data);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
