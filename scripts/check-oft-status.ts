import hre from "hardhat";
import { readFile } from "fs/promises";
import { join } from "path";

async function resolveBaseShareToken(ethers: any, networkName: string): Promise<string> {
  const depPath = join("deployments", networkName, `${networkName}.json`);
  const raw = await readFile(depPath, "utf-8");
  const dep = JSON.parse(raw);
  let baseFarm: string | undefined = dep.contracts?.vaults?.bluechip?.BaseFarm || dep.contracts?.BaseFarm;
  if (!baseFarm || baseFarm === ethers.ZeroAddress) {
    const coreAddr: string | undefined = dep.contracts?.ProtocolCore;
    if (!coreAddr) throw new Error(`Missing ProtocolCore in ${depPath}`);
    const core = await ethers.getContractAt("contracts/ProtocolCore.sol:ProtocolCore", coreAddr);
    baseFarm = await core.farmAddressOf(1);
  }
  if (!baseFarm || baseFarm === ethers.ZeroAddress) throw new Error("Could not resolve BaseFarm address (farmId=1)");
  const farm = await ethers.getContractAt("contracts/v3/farm/BaseFarm.sol:BaseFarm", baseFarm);
  const shareToken: string = await farm.shareToken();
  if (!shareToken || shareToken === ethers.ZeroAddress) throw new Error("shareToken not set on BaseFarm");
  return shareToken;
}

async function main() {
  const { ethers, network } = hre as any;
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("Network:", network.name, "Signer:", me);

  const BASE_EID = 40245;
  const ETH_SEPOLIA_EID = 40161;

  let tokenAddr: string;
  let peerEid: number;
  if (network.name === "base-sepolia") {
    tokenAddr = await resolveBaseShareToken(ethers, network.name);
    peerEid = ETH_SEPOLIA_EID;
  } else if (network.name === "sepolia") {
    tokenAddr = "0xB4806C1DcD25ca46f1bA6a3a20eb7869fcC9d8B1";
    peerEid = BASE_EID;
  } else {
    throw new Error("Run on base-sepolia or sepolia");
  }

  console.log("Token:", tokenAddr);
  const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", tokenAddr);
  
  const balance = await token.balanceOf(me);
  console.log("Balance:", balance.toString());

  const owner = await token.owner();
  console.log("Owner:", owner);

  const minter = await token.minter();
  console.log("Minter:", minter);

  try {
    const peer = await token.peers(peerEid);
    console.log(`Peer for EID ${peerEid}:`, peer);
  } catch (e: any) {
    console.log("Could not read peer:", e.message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
