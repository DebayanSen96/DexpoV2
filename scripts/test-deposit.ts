import hre from "hardhat";
import { readFile } from "fs/promises";
import { join } from "path";

async function main() {
  const { ethers, network } = hre as any;
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("Network:", network.name);
  console.log("Signer:", me);

  // Load deployment addresses
  const depPath = join("deployments", network.name, `${network.name}.json`);
  const raw = await readFile(depPath, "utf-8");
  const dep = JSON.parse(raw);

  let baseFarm: string | undefined = dep.contracts?.vaults?.bluechip?.BaseFarm || dep.contracts?.BaseFarm;
  const dxp: string = dep.contracts?.DXPToken;
  if (!dxp) throw new Error(`Missing DXPToken in ${depPath}`);

  // If BaseFarm not recorded in deployments file, read from ProtocolCore registry for farmId=1
  if (!baseFarm || baseFarm === ethers.ZeroAddress) {
    const coreAddr: string | undefined = dep.contracts?.ProtocolCore;
    if (!coreAddr) throw new Error(`Missing ProtocolCore in ${depPath}`);
    const core = await ethers.getContractAt("contracts/ProtocolCore.sol:ProtocolCore", coreAddr);
    baseFarm = await core.farmAddressOf(1);
  }
  if (!baseFarm || baseFarm === ethers.ZeroAddress) throw new Error("Could not resolve BaseFarm address (farmId=1)");
  console.log("BaseFarm:", baseFarm);
  console.log("DXPToken (asset):", dxp);

  const farm = await ethers.getContractAt("contracts/v3/farm/BaseFarm.sol:BaseFarm", baseFarm);
  const assetAddr: string = await farm.asset();
  if (assetAddr.toLowerCase() !== dxp.toLowerCase()) {
    console.log("Warning: farm.asset() != DXPToken. Using farm.asset() for approvals.");
  }

  // Resolve share token and decimals
  const shareTokenAddr: string = await (async () => {
    const st = await farm.shareToken();
    return st as string;
  })();
  const asset = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata", assetAddr);
  const assetDecimals: number = await asset.decimals();
  const shareErc20 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata", shareTokenAddr);
  const shareName = await shareErc20.name();
  const shareSymbol = await shareErc20.symbol();
  const shareDecimals = await shareErc20.decimals();
  console.log(`ShareToken: ${shareName} (${shareSymbol}), decimals=${shareDecimals}, address=${shareTokenAddr}`);

  // Choose a small deposit (e.g., 1 DXP)
  const amount = (ethers as any).parseUnits("1", assetDecimals);
  console.log(`Approving ${amount.toString()} (1 token) to BaseFarm...`);
  // approve
  const currentAllow = await asset.allowance(me, baseFarm);
  if (currentAllow < amount) {
    const txa = await asset.approve(baseFarm, amount);
    await txa.wait();
  }

  // Pre balances
  const preAssetBal = await asset.balanceOf(me);
  const preShares = await shareErc20.balanceOf(me);
  console.log("Pre: asset=", preAssetBal.toString(), "shares=", preShares.toString());

  console.log("Calling BaseFarm.deposit(1 token)...");
  const tx = await farm.deposit(amount);
  const rcpt = await tx.wait();
  console.log("Deposit tx:", tx.hash, "status:", rcpt?.status);
  // Poll post share balance up to 5 times in case of RPC lag
  let postShares = await shareErc20.balanceOf(me);
  for (let i = 0; i < 5 && postShares <= preShares; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    postShares = await shareErc20.balanceOf(me);
  }
  const postAssetBal = await asset.balanceOf(me);
  console.log("Post: asset=", postAssetBal.toString(), "shares=", postShares.toString());

  // Basic assertion
  if (postShares > preShares) {
    console.log("SUCCESS: Received OFT-based share tokens.");
  } else {
    console.log("FAIL: Share balance did not increase.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
