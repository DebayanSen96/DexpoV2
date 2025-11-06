import hre from "hardhat";

const BASE_EID = 40245; // Base Sepolia
const SEPOLIA_TOKEN = "0xB4806C1DcD25ca46f1bA6a3a20eb7869fcC9d8B1";
const BASE_TOKEN = "0xD1a055200791584c64022d664042711b583FB93B";

const ENDPOINT_ABI = [
  "function getSendLibrary(address oapp, uint32 eid) view returns (address)",
  "function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)",
  "function getReceiveLibrary(address oapp, uint32 eid) view returns (address)"
];

const SHARE_TOKEN_ABI = [
  "function peers(uint32 eid) view returns (bytes32)"
];

async function main() {
  const { ethers, network } = hre as any;
  if (network.name !== "sepolia") {
    console.log(`Run with --network sepolia. Current: ${network.name}`);
    return;
  }

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("\n=== DIAGNOSTIC SCRIPT ===");
  console.log("Network:", network.name);
  console.log("Signer:", me);
  console.log("");

  const token = new ethers.Contract(SEPOLIA_TOKEN, SHARE_TOKEN_ABI, signer);
  const peer = await token.peers(BASE_EID);
  const expectedPeer = ethers.zeroPadValue(BASE_TOKEN, 32);
  console.log("=== PEER CONFIGURATION ===");
  console.log(`Stored peer for EID ${BASE_EID}:`, peer);
  console.log("Expected:", expectedPeer);
  console.log("Match:", peer.toLowerCase() === expectedPeer.toLowerCase());
  console.log("");

  const endpointAddr = process.env.LZ_ENDPOINT_SEPOLIA ?? "0x6EDCE65403992e310A62460808c4b910D972f10f";
  const endpoint = new ethers.Contract(endpointAddr, ENDPOINT_ABI, signer);
  const sendLib = await endpoint.getSendLibrary(SEPOLIA_TOKEN, BASE_EID);
  const recvLib = await endpoint.getReceiveLibrary(SEPOLIA_TOKEN, BASE_EID);
  console.log("=== LIBRARIES ===");
  console.log("Send library:", sendLib);
  console.log("Receive library:", recvLib);

  const CONFIG_TYPE_ULN = 2;
  const configBytes = await endpoint.getConfig(SEPOLIA_TOKEN, sendLib, BASE_EID, CONFIG_TYPE_ULN);
  console.log("");
  console.log("=== DVN CONFIG ===");
  if (configBytes && configBytes !== "0x") {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint64", "uint8", "uint8", "uint8", "address[]", "address[]"],
      configBytes
    );
    const confirmations = decoded[0];
    const requiredDVNs: string[] = decoded[4];
    const optionalDVNs: string[] = decoded[5];
    console.log("Confirmations:", confirmations.toString());
    console.log("Required DVNs:", requiredDVNs);
    console.log("Optional DVNs:", optionalDVNs);
    const dead = "0x000000000000000000000000000000000000dEaD";
    const all = [...requiredDVNs, ...optionalDVNs];
    console.log("Includes LzDeadDVN:", all.some((addr) => addr.toLowerCase() === dead.toLowerCase()));
    console.log("DVN count:", all.length);
  } else {
    console.log("No DVN config set (bytes empty)");
  }
  console.log("");

  console.log("=== QUOTE TEST ===");
  const amount = ethers.parseUnits("0.1", 18);
  const sendParam = {
    dstEid: BASE_EID,
    to: ethers.zeroPadValue(me, 32),
    amountLD: amount,
    minAmountLD: amount,
    extraOptions: "0x000300000000000000000000000000030d40000000000000000000000000000000",
    composeMsg: "0x",
    oftCmd: "0x"
  };

  try {
    const quote = await token.quoteSend(sendParam, false);
    console.log("Quote success. Native fee:", ethers.formatEther(quote.nativeFee), "ETH");
  } catch (err: any) {
    console.log("Quote failed:", err?.message ?? err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
