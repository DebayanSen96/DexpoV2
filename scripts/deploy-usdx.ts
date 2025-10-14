import hre from "hardhat";

async function main() {
  const { ethers, network } = hre as any;

  console.log("Network:", (network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat");

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("Deployer:", deployerAddress);

  const USDXFactory = await ethers.getContractFactory("USDX");
  const usdx = await USDXFactory.deploy();
  await usdx.waitForDeployment();
  const usdxAddr = await usdx.getAddress();
  console.log("USDX deployed:", usdxAddr);

  const decimals: bigint = await usdx.decimals();
  const amount = ethers.parseUnits("100000000", Number(decimals));
  console.log("Minting 100,000,000 USDx to deployer...");
  const mintTx = await usdx.mint(deployerAddress, amount);
  await mintTx.wait();
  console.log("Mint tx:", mintTx.hash);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
