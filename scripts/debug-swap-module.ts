import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
};

async function main() {
  const [signer] = await ethers.getSigners();
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  console.log("\n--- Debug Swap Module ---");
  
  const vault = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3",
    state.testVault.indexSwap,
    signer
  );
  
  const moduleRegistry = await vault.moduleRegistry();
  console.log("Vault's ModuleRegistry:", moduleRegistry);
  
  const registry = await ethers.getContractAt(
    "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry",
    moduleRegistry,
    signer
  );
  
  const swapModule = await registry.getSwapModule();
  console.log("SwapModule from registry:", swapModule);
  
  if (swapModule === ethers.ZeroAddress) {
    console.log("❌ SwapModule not set in registry!");
    return;
  }
  
  const swapModuleContract = await ethers.getContractAt(
    "contracts/v3/mainnet/modules/SwapModuleV3.sol:SwapModuleV3",
    swapModule,
    signer
  );
  
  console.log("\n--- SwapModule Config ---");
  const router = await swapModuleContract.swapRouter();
  console.log("SwapRouter:", router);
  
  const oracle = await swapModuleContract.oracle();
  console.log("Oracle:", oracle);
  
  const protocolCore = await swapModuleContract.protocolCore();
  console.log("ProtocolCore:", protocolCore);
  
  const wethUsdcFee = await swapModuleContract.pairPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.USDC);
  console.log("WETH/USDC pool fee:", wethUsdcFee.toString());
  
  const usdcWethFee = await swapModuleContract.pairPoolFee(BASE_MAINNET.USDC, BASE_MAINNET.WETH);
  console.log("USDC/WETH pool fee:", usdcWethFee.toString());
  
  console.log("\n--- Check Vault USDC Balance ---");
  const usdc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BASE_MAINNET.USDC);
  const vaultBalance = await usdc.balanceOf(state.testVault.indexSwap);
  console.log("Vault USDC:", ethers.formatUnits(vaultBalance, 6));
  
  console.log("\n--- Check Vault's Allowance to SwapModule ---");
  const allowance = await usdc.allowance(state.testVault.indexSwap, swapModule);
  console.log("Vault's USDC allowance to SwapModule:", ethers.formatUnits(allowance, 6));
  
  console.log("\n--- Check if signer is authorized ---");
  const vaultSafe = await vault.safe();
  console.log("Vault Safe:", vaultSafe);
  
  const safe = await ethers.getContractAt(
    "contracts/v3/mainnet/vault/VaultSafe.sol:VaultSafe",
    vaultSafe,
    signer
  );
  
  const isOwner = await safe.isOwner(signer.address);
  console.log("Signer is Safe owner:", isOwner);
  
  const coreContract = await ethers.getContractAt("IProtocolCoreOwnable", protocolCore, signer);
  const protocolOwner = await coreContract.owner();
  console.log("Protocol owner:", protocolOwner);
  console.log("Signer is protocol owner:", signer.address === protocolOwner);
}

main().catch(console.error);
