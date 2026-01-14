import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  SWAP_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WBTC: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
  POOL_FEE_LOWEST: 100,
  POOL_FEE_LOW: 500,
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  const safeAddress = "0x0c914cc97D118Bf1fe26dfcCF0C0DD13f04A824B";
  
  if (!state.testVault) {
    console.log("\nDeploying IndexSwapV3...");
    
    const portfolio = [
      { token: BASE_MAINNET.USDC, weightBps: 5000 },
      { token: BASE_MAINNET.WETH, weightBps: 3000 },
      { token: BASE_MAINNET.WBTC, weightBps: 2000 },
    ];
    
    const IndexSwapV3 = await ethers.getContractFactory("contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3");
    const vault = await IndexSwapV3.deploy(
      state.protocolCore,
      safeAddress,
      state.chainlinkOracle,
      BASE_MAINNET.SWAP_ROUTER,
      "Test Index Vault",
      "TIV",
      portfolio,
      0
    );
    await vault.waitForDeployment();
    const vaultAddress = await vault.getAddress();
    console.log("IndexSwapV3 deployed:", vaultAddress);
    
    console.log("Setting pool fees...");
    await (await vault.setPoolFee(BASE_MAINNET.WETH, BASE_MAINNET.POOL_FEE_LOW)).wait();
    await (await vault.setPoolFee(BASE_MAINNET.WBTC, BASE_MAINNET.POOL_FEE_LOW)).wait();
    await (await vault.setPoolFee(BASE_MAINNET.USDC, BASE_MAINNET.POOL_FEE_LOWEST)).wait();
    
    console.log("Setting fee collector...");
    await (await vault.setFeeCollector(state.feeCollector)).wait();
    
    console.log("Registering vault in ProtocolMetrics...");
    const metrics = await ethers.getContractAt("contracts/v3/mainnet/core/ProtocolMetrics.sol:ProtocolMetrics", state.protocolMetrics);
    await (await metrics.registerVault(vaultAddress)).wait();
    
    state.testVault = { safe: safeAddress, indexSwap: vaultAddress };
    state.lastStep = "testVault";
    fs.writeFileSync(deploymentPath, JSON.stringify(state, null, 2));
    
    console.log("\n✅ DEPLOYMENT COMPLETE!");
    console.log("VaultSafe:", safeAddress);
    console.log("IndexSwapV3:", vaultAddress);
  } else {
    console.log("Test vault already exists:", state.testVault);
  }
}

main().catch(console.error);
