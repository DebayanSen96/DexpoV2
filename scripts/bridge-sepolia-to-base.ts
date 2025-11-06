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
  
  console.log("Sepolia share token:", tokenAddr);
  const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", tokenAddr);

  const balance = await token.balanceOf(me);
  console.log("Balance before:", balance.toString());

  // amount: 0.1 dBLUE (18 decimals)
  const amount = (ethers as any).parseUnits("0.1", 18);
  const to = toBytes32(me, ethers);
  
  // LayerZero executor options: type 3 + 200k gas + 0 value (matches enforced options)
  const extraOptions = "0x000300000000000000000000000000030d40000000000000000000000000000000";

  // Build SendParam struct for OFT v2
  const sendParam = {
    dstEid: BASE_EID,
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
  console.log("Sending 0.1 dBLUE from Sepolia to Base Sepolia...");
  const tx = await token.send(sendParam, { nativeFee: fee, lzTokenFee: 0 }, me, { value: fee });
  console.log("send tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("send status:", rcpt?.status);

  const balanceAfter = await token.balanceOf(me);
  console.log("Balance after:", balanceAfter.toString());
}

main().catch((e) => { console.error(e); process.exit(1); });
