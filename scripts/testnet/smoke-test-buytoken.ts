import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.join(__dirname, "..", "deployments", "v3-latest", `${network.name}.json`);
const TOKEN_FILE = path.join(__dirname, "..", "..", "contracts", "v3", "test", "base-sepolia_test_tokens.json");

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const tokenFile = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();

  const vault = state.testVault.indexSwap;
  const usdc = tokenFile.tokens.find((t: any) => t.symbol === "USDC");
  const weth = tokenFile.tokens.find((t: any) => t.symbol === "WETH");

  console.log("=".repeat(60));
  console.log("SMOKE TEST: buyToken");
  console.log("=".repeat(60));
  console.log("Vault:   ", vault);
  console.log("Deployer:", deployer.address);
  console.log("USDC:    ", usdc.address);
  console.log("WETH:    ", weth.address);

  const erc20Abi = ["function mint(address,uint256) external", "function balanceOf(address) view returns (uint256)"];
  const vaultAbi = [
    "function buyToken(address,address,uint256) external returns (uint256)",
    "function safe() view returns (address)",
    "function moduleRegistry() view returns (address)",
    "function getPortfolio() view returns (tuple(address token, uint16 weightBps)[])",
  ];

  const uc = new ethers.Contract(usdc.address, erc20Abi, deployer);
  const v = new ethers.Contract(vault, vaultAbi, deployer);

  const safe = await v.safe();
  const mr = await v.moduleRegistry();
  const portfolio = await v.getPortfolio();
  console.log("\nVault safe:          ", safe);
  console.log("Vault moduleRegistry:", mr);
  console.log("Portfolio:", portfolio.map((p: any) => `${p.token} (${p.weightBps}bps)`));

  const amt = ethers.parseUnits("100", usdc.decimals);
  console.log("\nMinting 100 USDC to vault...");
  console.log("  amount raw:", amt.toString());
  const mintTx = await uc.mint(vault, amt);
  const receipt = await mintTx.wait(1);
  console.log("  mint tx:", receipt.hash, "status:", receipt.status);
  const bal = await uc.balanceOf(vault);
  console.log("Vault USDC balance raw:", bal.toString());
  console.log("Vault USDC balance:", ethers.formatUnits(bal, usdc.decimals));
  const deployerBal = await uc.balanceOf(deployer.address);
  console.log("Deployer USDC balance raw:", deployerBal.toString());

  console.log("\nCalling buyToken(USDC, WETH, 100 USDC) via staticCall...");
  try {
    const amountOut = await v.buyToken.staticCall(usdc.address, weth.address, amt);
    console.log("✅ staticCall SUCCESS! amountOut:", amountOut.toString());
  } catch (e: any) {
    console.log("❌ staticCall FAILED:", e.message?.slice(0, 300));
    if (e.data) console.log("   revert data:", e.data);
    return;
  }

  console.log("\nExecuting buyToken for real...");
  try {
    const tx = await v.buyToken(usdc.address, weth.address, amt);
    const receipt = await tx.wait(1);
    console.log("✅ buyToken tx:", receipt.hash);
    console.log("   gas used:", receipt.gasUsed.toString());

    const wethContract = new ethers.Contract(weth.address, erc20Abi, deployer);
    const wethBal = await wethContract.balanceOf(vault);
    const usdcBal = await uc.balanceOf(vault);
    console.log("\nPost-swap balances:");
    console.log("  USDC raw:", usdcBal.toString(), "formatted:", ethers.formatUnits(usdcBal, usdc.decimals));
    console.log("  WETH raw:", wethBal.toString(), "formatted:", ethers.formatUnits(wethBal, weth.decimals));
  } catch (e: any) {
    console.log("❌ buyToken tx FAILED:", e.message?.slice(0, 300));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
