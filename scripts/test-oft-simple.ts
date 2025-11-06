import hre from "hardhat";

async function main() {
  const { ethers, network } = hre as any;
  if (network.name !== "base-sepolia") {
    console.log(`Run with --network base-sepolia. Current: ${network.name}`);
  }
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("Network:", network.name, "Signer:", me);

  const tokenAddr = "0xD1a055200791584c64022d664042711b583FB93B";
  const token = await ethers.getContractAt("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT", tokenAddr);

  const balance = await token.balanceOf(me);
  console.log("My balance:", balance.toString());

  // Try to transfer to self to verify token works
  const amount = (ethers as any).parseUnits("0.01", 18);
  console.log("Trying local transfer of 0.01 dBLUE...");
  try {
    const tx = await token.transfer(me, amount);
    await tx.wait();
    console.log("Local transfer succeeded");
  } catch (e: any) {
    console.log("Local transfer failed:", e.message);
  }

  // Check endpoint
  try {
    const endpoint = await token.endpoint();
    console.log("LZ Endpoint:", endpoint);
  } catch (e: any) {
    console.log("Could not read endpoint:", e.message);
  }

  // Check if delegate is set
  try {
    const oappCore = await ethers.getContractAt("@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol:OApp", tokenAddr);
    const delegate = await oappCore.delegate();
    console.log("Delegate:", delegate);
  } catch (e: any) {
    console.log("Could not read delegate:", e.message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
