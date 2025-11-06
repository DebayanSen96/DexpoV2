import hre from "hardhat";

async function main() {
  const { ethers, network } = hre as any;
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("Network:", network.name, "Signer:", me);

  let tokenAddr: string;
  if (network.name === "base-sepolia") {
    tokenAddr = "0xD1a055200791584c64022d664042711b583FB93B";
  } else if (network.name === "sepolia") {
    tokenAddr = "0xB4806C1DcD25ca46f1bA6a3a20eb7869fcC9d8B1";
  } else {
    throw new Error("Run on base-sepolia or sepolia");
  }

  console.log("Token:", tokenAddr);
  const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", tokenAddr);
  
  console.log("Setting delegate to owner:", me);
  const tx = await token.setDelegate(me);
  console.log("setDelegate tx:", tx.hash);
  await tx.wait();
  console.log("Delegate set successfully");
}

main().catch((e) => { console.error(e); process.exit(1); });
