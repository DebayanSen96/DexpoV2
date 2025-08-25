import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  const deploymentPath = path.join(__dirname, "..", "deployments", "localhost", "localhost.json");
  const json = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));

  const deployer = (await ethers.getSigners())[0];
  console.log("Network:", json.network);
  console.log("Deployer:", deployer.address);

  const DXP = json.contracts.DXPToken as string;
  const stakingFarm = json.contracts.vaults.staking.BaseFarm as string;

  const asset = await ethers.getContractAt("ERC20", DXP);
  const farm = await ethers.getContractAt("BaseFarm", stakingFarm);

  const amount100 = ethers.parseUnits("100", 18);
  const amount1000 = ethers.parseUnits("1000", 18);
  const amount500 = ethers.parseUnits("500", 18);

  console.log("DXP balance before:", (await asset.balanceOf(deployer.address)).toString());

  // Approve 100
  console.log("\n-- Approve 100 --");
  await (await asset.approve(stakingFarm, amount100)).wait();

  // Deposit 100
  console.log("\n-- Deposit 100 --");
  await (await farm.deposit(amount100)).wait();

  // Position after deposit
  let pos = await farm.getUserPosition(deployer.address);
  console.log("Position after deposit:");
  console.log({ shares: pos[0].toString(), assets: pos[1].toString(), claimableRewards: pos[2].toString(), lockStart: pos[3], lockEnd: pos[4], locked: pos[5] });

  // Simulate yield: transfer 1000 to farm
  console.log("\n-- Simulate yield: transfer 1000 to farm --");
  await (await asset.transfer(stakingFarm, amount1000)).wait();

  // Allocate 500 to strategies (owner-only)
  console.log("\n-- Allocate 500 to strategies --");
  await (await farm.allocateToStrategies(amount500)).wait();

  // Position after allocate
  pos = await farm.getUserPosition(deployer.address);
  console.log("Position after allocate:");
  console.log({ shares: pos[0].toString(), assets: pos[1].toString(), claimableRewards: pos[2].toString(), lockStart: pos[3], lockEnd: pos[4], locked: pos[5] });

  // Harvest (owner-only)
  console.log("\n-- Harvest --");
  await (await farm.harvest()).wait();

  // Position after harvest
  pos = await farm.getUserPosition(deployer.address);
  console.log("Position after harvest:");
  console.log({ shares: pos[0].toString(), assets: pos[1].toString(), claimableRewards: pos[2].toString(), lockStart: pos[3], lockEnd: pos[4], locked: pos[5] });

  // Withdraw shares equal to 100 assets (using convertToShares)
  console.log("\n-- WithdrawShares equivalent to 100 assets --");
  const sharesFor100 = await farm.convertToShares(amount100);
  await (await farm.withdrawShares(sharesFor100)).wait();

  // Final position
  pos = await farm.getUserPosition(deployer.address);
  console.log("Final position after withdrawing 100 assets worth of shares:");
  console.log({ shares: pos[0].toString(), assets: pos[1].toString(), claimableRewards: pos[2].toString(), lockStart: pos[3], lockEnd: pos[4], locked: pos[5] });

  console.log("\nDXP balance after:", (await asset.balanceOf(deployer.address)).toString());
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
