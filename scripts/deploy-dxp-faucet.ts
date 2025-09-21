import hre from "hardhat";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

async function main() {
  const network: string = ((hre as any).network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat";
  const { ethers } = hre as any;

  console.log("Network:", network);

  // Load existing deployment addresses for the network to find DXP token
  const deploymentsDir = join("deployments", network);
  const deploymentsFile = join(deploymentsDir, `${network}.json`);
  const jsonRaw = await readFile(deploymentsFile, { encoding: "utf-8" });
  const deployed = JSON.parse(jsonRaw);

  const dxpAddr: string | undefined = deployed?.contracts?.DXPToken;
  if (!dxpAddr) {
    throw new Error(`DXPToken address not found in ${deploymentsFile}`);
  }

  // Parameters
  const decimals = 18;
  const claimAmount = ethers.parseUnits("100", decimals); // 100 DXP
  const cooldown = 8 * 60 * 60; // 8 hours in seconds
  const faucetFundAmount = ethers.parseUnits("1000000", decimals); // 1,000,000 DXP

  // Signer
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("Deployer:", deployerAddress);

  // Deploy faucet
  console.log("Deploying DXPFaucet...");
  const FaucetF = await ethers.getContractFactory("contracts/libraries/testnet/DXPFaucet.sol:DXPFaucet");
  const faucet = await FaucetF.deploy(dxpAddr, claimAmount, cooldown);
  await faucet.waitForDeployment();
  const faucetAddr = await faucet.getAddress();
  console.log("DXPFaucet deployed at:", faucetAddr);

  // Fund faucet with 1,000,000 DXP from signer
  console.log("Funding faucet with 1,000,000 DXP...");
  // Use DXPToken ABI to ensure transfer function availability
  const dxp = await ethers.getContractAt("contracts/DXPToken.sol:DXPToken", dxpAddr);

  const balBefore = await (dxp as any).balanceOf(faucetAddr);
  const tx = await (dxp as any).transfer(faucetAddr, faucetFundAmount);
  console.log("Transfer tx:", tx.hash);
  await tx.wait();
  const balAfter = await (dxp as any).balanceOf(faucetAddr);
  console.log(
    "Faucet funded. Balance before:",
    ethers.formatUnits(balBefore, decimals),
    "DXP | after:",
    ethers.formatUnits(balAfter, decimals),
    "DXP"
  );

  // Persist faucet info back to deployments JSON
  const updated = { ...deployed };
  updated.contracts = { ...(updated.contracts || {}), DXPFaucet: faucetAddr };
  updated.params = {
    ...(updated.params || {}),
    FAUCET: {
      DXP: dxpAddr,
      CLAIM_AMOUNT: claimAmount.toString(),
      COOLDOWN_SECONDS: cooldown,
      FUND_AMOUNT: faucetFundAmount.toString(),
    },
  };

  await mkdir(deploymentsDir, { recursive: true });
  await writeFile(deploymentsFile, JSON.stringify(updated, null, 2));
  console.log("Saved faucet address to:", deploymentsFile);

  console.log("All done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
