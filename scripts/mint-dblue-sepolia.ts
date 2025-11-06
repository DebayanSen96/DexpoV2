import hre from "hardhat";

async function main() {
  const { ethers, network } = hre as any;
  if (network.name !== "sepolia") {
    console.log(`Run with --network sepolia. Current: ${network.name}`);
  }
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("Network:", network.name, "Signer:", me);

  const tokenAddr = "0xB4806C1DcD25ca46f1bA6a3a20eb7869fcC9d8B1";
  const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", tokenAddr);

  // Set minter to self
  console.log("Setting minter to:", me);
  const tx1 = await token.setMinter(me);
  await tx1.wait();
  console.log("Minter set");

  // Mint 1 dBLUE to self
  const amount = (ethers as any).parseUnits("1", 18);
  console.log("Minting 1 dBLUE to:", me);
  const tx2 = await token.mint(me, amount);
  await tx2.wait();
  console.log("Minted successfully");

  const balance = await token.balanceOf(me);
  console.log("Balance:", balance.toString());
}

main().catch((e) => { console.error(e); process.exit(1); });
