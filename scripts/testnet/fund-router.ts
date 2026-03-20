import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.join(__dirname, "../deployments/v3-latest", `${network.name}.json`);
const TOKEN_FILE = path.join(__dirname, "../../contracts/v3/test/base-sepolia_test_tokens.json");
const MINT_AMOUNT = 10_000n;

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const tokenFile = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  const tokens: any[] = tokenFile.tokens;
  const [deployer] = await ethers.getSigners();

  const routerAddr: string = state.mockSwapRouter;
  const oracleAddr: string = state.oracle;

  console.log("=".repeat(70));
  console.log("FUND MOCK ROUTER");
  console.log("=".repeat(70));
  console.log("Router: ", routerAddr);
  console.log("Oracle: ", oracleAddr);
  console.log("Tokens: ", tokens.length);

  const nm = new ethers.NonceManager(deployer);
  const erc20Abi = ["function mint(address,uint256) external", "function balanceOf(address) view returns (uint256)"];
  const oracleAbi = ["function setPrice(address,uint256) external", "function priceUsdE18(address) view returns (uint256)"];
  const orc = new ethers.Contract(oracleAddr, oracleAbi, nm);

  let mintOk = 0;
  let priceOk = 0;

  for (const t of tokens) {
    const dec = BigInt(t.decimals);
    const amt = MINT_AMOUNT * 10n ** dec;
    const erc20 = new ethers.Contract(t.address, erc20Abi, nm);

    const bal = await erc20.balanceOf(routerAddr);
    if (bal < amt / 2n) {
      try {
        const tx = await erc20.mint(routerAddr, amt);
        await tx.wait(1);
        mintOk++;
      } catch (e: any) {
        console.log(`  ⚠ ${t.symbol} mint: ${e.message?.slice(0, 60)}`);
      }
    } else {
      mintOk++;
    }

    const target = BigInt(Math.round((t.priceUsd && t.priceUsd > 0 ? t.priceUsd : 1) * 1e18));
    let current = 0n;
    try { current = await orc.priceUsdE18(t.address); } catch {}
    if (current !== target) {
      try {
        const tx = await orc.setPrice(t.address, target);
        await tx.wait(1);
        priceOk++;
      } catch (e: any) {
        console.log(`  ⚠ ${t.symbol} oracle: ${e.message?.slice(0, 60)}`);
      }
    } else {
      priceOk++;
    }
  }

  console.log(`\nRouter funded: ${mintOk}/${tokens.length}`);
  console.log(`Oracle prices: ${priceOk}/${tokens.length}`);
  console.log(mintOk === tokens.length && priceOk === tokens.length ? "✅ ALL DONE" : "⚠ Re-run to fill gaps");
}

main().catch(err => { console.error(err); process.exit(1); });
