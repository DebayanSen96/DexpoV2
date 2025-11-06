import hre from "hardhat";

async function main() {
  const { ethers, network } = hre as any;
  if (network.name !== "sepolia") {
    console.log(`Run with --network sepolia. Current: ${network.name}`);
  }
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const lzEndpoint = process.env.LZ_ENDPOINT_SEPOLIA;
  if (!lzEndpoint) throw new Error("LZ_ENDPOINT_SEPOLIA missing in .env");

  const name = "Dexponent Bluechip Vault";
  const symbol = "dBLUE";
  const F = await ethers.getContractFactory("contracts/v3/tokens/ShareTokenOFT.sol:ShareTokenOFT");
  const c = await F.deploy(name, symbol, lzEndpoint, me);
  console.log("Deploying ShareTokenOFT(sepolia)... tx=", c.deploymentTransaction()?.hash);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("ShareTokenOFT (sepolia):", addr);
}

main().catch((e) => { console.error(e); process.exit(1); });
