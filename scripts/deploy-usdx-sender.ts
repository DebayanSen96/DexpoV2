import hre from "hardhat";

// Configure the USDX token address here or via env USDX_ADDRESS
const TOKEN_ADDRESS = process.env.USDX_ADDRESS || "0xFc411f933b84B8762d90ea699D7Ec82b10400912";

async function main() {
  const { ethers, network } = hre as any;
  console.log("Network:", (network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat");

  if (!ethers.isAddress(TOKEN_ADDRESS)) {
    throw new Error(`Invalid TOKEN_ADDRESS: ${TOKEN_ADDRESS}`);
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("Deployer:", deployerAddress);

  // Deploy USDXSender with the token address
  const SenderF = await ethers.getContractFactory("contracts/libraries/testnet/USDXSender.sol:USDXSender");
  const sender = await SenderF.deploy(TOKEN_ADDRESS);
  await sender.waitForDeployment();
  const senderAddr = await sender.getAddress();
  console.log("USDXSender deployed at:", senderAddr);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
