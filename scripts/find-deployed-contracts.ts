import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  const nonce = await ethers.provider.getTransactionCount(signer.address);
  
  console.log("Checking deployed contracts from nonce 0 to", nonce - 1);
  console.log("Signer:", signer.address);
  
  for (let i = 0; i < nonce; i++) {
    const contractAddr = ethers.getCreateAddress({ from: signer.address, nonce: i });
    const code = await ethers.provider.getCode(contractAddr);
    if (code !== "0x") {
      console.log(`Nonce ${i}: ${contractAddr} (has code)`);
    }
  }
}

main().catch(console.error);
