import hre from "hardhat";
import { readFile } from "fs/promises";
import { join } from "path";

function getEnvOrArg(name: string): string | undefined {
  // Check env first, then argv
  const envVal = process.env[name.toUpperCase()];
  if (envVal) return envVal;
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

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

  const BASE_EID = 40245; // Base Sepolia
  const ETH_SEPOLIA_EID = 40161; // Ethereum Sepolia

  if (network.name === "base-sepolia") {
    // Hardcode sepolia token for simplicity
    const sepoliaAddr = "0xB4806C1DcD25ca46f1bA6a3a20eb7869fcC9d8B1";
    const baseShareToken = await resolveBaseShareToken(ethers, network.name);
    console.log("Base share token:", baseShareToken);
    console.log("Sepolia share token:", sepoliaAddr);
    const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", baseShareToken);
    const peer = ethers.zeroPadValue(sepoliaAddr, 32);
    const tx = await token.setPeer(ETH_SEPOLIA_EID, peer);
    console.log("setPeer(base->sepolia) tx:", tx.hash);
    await tx.wait();
    console.log("setPeer on base complete");
  } else if (network.name === "sepolia") {
    // Hardcode base and sepolia token for simplicity
    const baseAddr = "0xD1a055200791584c64022d664042711b583FB93B";
    const sepoliaTokenAddr = "0xB4806C1DcD25ca46f1bA6a3a20eb7869fcC9d8B1";
    console.log("Base share token:", baseAddr);
    console.log("Sepolia share token:", sepoliaTokenAddr);
    const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", sepoliaTokenAddr);
    const peer = ethers.zeroPadValue(baseAddr, 32);
    const tx = await token.setPeer(BASE_EID, peer);
    console.log("setPeer(sepolia->base) tx:", tx.hash);
    await tx.wait();
    console.log("setPeer on sepolia complete");
  } else {
    throw new Error("Run this on base-sepolia or sepolia");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
