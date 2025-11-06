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

function toBytes32(addr: string, ethers: any): string {
  return ethers.zeroPadValue(addr, 32);
}

async function main() {
  const { ethers, network } = hre as any;
  if (network.name !== "base-sepolia") {
    console.log(`Run with --network base-sepolia. Current: ${network.name}`);
  }
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("Network:", network.name, "Signer:", me);

  const BASE_EID = 40245;
  const ETH_SEPOLIA_EID = 40161;

  const shareTokenAddr = await resolveBaseShareToken(ethers, network.name);
  console.log("Base share token:", shareTokenAddr);
  const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", shareTokenAddr);

  // amount: 0.1 dBLUE (18 decimals)
  const amount = (ethers as any).parseUnits("0.1", 18);
  const to = toBytes32(me, ethers);
  
  // LayerZero executor options: type 3 + 200k gas + 0 value (matches enforced options)
  const extraOptions = "0x000300000000000000000000000000030d40000000000000000000000000000000";

  // Build SendParam struct for OFT v2
  const sendParam = {
    dstEid: ETH_SEPOLIA_EID,
    to: to,
    amountLD: amount,
    minAmountLD: amount,
    extraOptions,
    composeMsg: "0x",
    oftCmd: "0x"
  };

  // Try to quote fee, if it fails use a reasonable estimate
  let fee: bigint;
  try {
    const quote = await token.quoteSend(sendParam, false);
    fee = quote.nativeFee;
    console.log("Quoted fee:", fee.toString());
  } catch (e) {
    console.log("Quote failed, using estimate of 0.001 ETH");
    fee = (ethers as any).parseEther("0.001");
  }

  // Send OFT
  const tx = await token.send(sendParam, { nativeFee: fee, lzTokenFee: 0 }, me, { value: fee });
  console.log("send tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("send status:", rcpt?.status);
}

main().catch((e) => { console.error(e); process.exit(1); });
