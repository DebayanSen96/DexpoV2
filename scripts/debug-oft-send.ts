import hre from "hardhat";

function toBytes32(addr: string, ethers: any): string {
  return ethers.zeroPadValue(addr, 32);
}

async function main() {
  const { ethers, network } = hre as any;
  if (network.name !== "sepolia") {
    console.log(`Run with --network sepolia. Current: ${network.name}`);
  }
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("Network:", network.name, "Signer:", me);

  const BASE_EID = 40245;
  const tokenAddr = "0xB4806C1DcD25ca46f1bA6a3a20eb7869fcC9d8B1";
  
  const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", tokenAddr);

  const amount = (ethers as any).parseUnits("0.1", 18);
  const to = toBytes32(me, ethers);
  
  const sendParam = {
    dstEid: BASE_EID,
    to: to,
    amountLD: amount,
    minAmountLD: amount,
    extraOptions: "0x",
    composeMsg: "0x",
    oftCmd: "0x"
  };

  const fee = (ethers as any).parseEther("0.001");

  // Try to call send with error decoding
  try {
    // First try a static call to get the revert reason
    await token.send.staticCall(sendParam, { nativeFee: fee, lzTokenFee: 0 }, me, { value: fee });
    console.log("Static call succeeded (shouldn't happen if reverting)");
  } catch (error: any) {
    console.log("\n=== Revert Details ===");
    console.log("Error:", error.message);
    if (error.data) {
      console.log("Error data:", error.data);
      // Try to decode if it's a custom error
      try {
        const iface = token.interface;
        const decoded = iface.parseError(error.data);
        console.log("Decoded error:", decoded);
      } catch (e) {
        console.log("Could not decode error data");
      }
    }
    if (error.reason) {
      console.log("Reason:", error.reason);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
