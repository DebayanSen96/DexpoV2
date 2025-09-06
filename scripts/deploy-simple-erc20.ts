import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Network:", (await ethers.provider.getNetwork()).name);
  console.log("Deployer:", deployer.address);

  // 1. Deploy SimpleERC20
  const name = "Test Token";
  const symbol = "TST";
  const SimpleERC20 = await ethers.getContractFactory("SimpleERC20");
  const token = await SimpleERC20.deploy(name, symbol);
  await token.waitForDeployment();

  const tokenAddress = await token.getAddress();
  console.log("SimpleERC20 deployed at:", tokenAddress);

  // 2. Mint 1,000,000 tokens (18 decimals) to the first account (account 0)
  const mintAmount = ethers.parseUnits("1000000", 18);
  const tx = await token.mint(deployer.address, mintAmount);
  await tx.wait();

  const balance = await token.balanceOf(deployer.address);
  console.log("Minted balance:", balance.toString());

  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
