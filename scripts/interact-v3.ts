import hre from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const { ethers, network } = hre as any;
  const [deployer] = await ethers.getSigners();

  const deploymentsFile = process.env.DEPLOY_JSON || (() => {
    const dir = join("deployments", network.name || "localhost");
    const files = require("fs").readdirSync(dir).filter((f: string) => f.startsWith("v3-") && f.endsWith(".json"));
    files.sort();
    return join(dir, files[files.length - 1]);
  })();

  const data = JSON.parse(readFileSync(deploymentsFile, "utf8"));
  console.log("Using deployment:", deploymentsFile);

  const dxpAddr: string = data.contracts.DXPToken;
  const staking = data.contracts.vaults.staking;
  const lending = data.contracts.vaults.lending;

  const asset = await ethers.getContractAt("ERC20", dxpAddr);
  const stakeVault = await ethers.getContractAt("BaseVault", staking.BaseVault);
  const lendVault = await ethers.getContractAt("BaseVault", lending.BaseVault);
  const stakeLock = await ethers.getContractAt("LockupPolicy", staking.LockupPolicy);
  const lendLock = await ethers.getContractAt("LockupPolicy", lending.LockupPolicy);

  const amount = ethers.parseUnits("1000", 18);

  console.log("Deployer:", deployer.address);
  console.log("DXP balance before:", (await asset.balanceOf(deployer.address)).toString());

  // Approvals
  await (await asset.approve(stakeVault.getAddress(), amount)).wait();
  await (await asset.approve(lendVault.getAddress(), amount)).wait();

  // Deposit into staking (no lock)
  console.log("\n-- Staking: deposit --");
  await (await stakeVault.deposit(amount, deployer.address)).wait();
  const stakeShareAddr = await stakeVault.shareToken();
  const stakeShare = await ethers.getContractAt("ERC20", stakeShareAddr);
  console.log("stake shares minted:", (await stakeShare.balanceOf(deployer.address)).toString());
  const stakeLockInfo = await stakeLock.lockInfo(deployer.address);
  console.log("stake lock info:", stakeLockInfo);

  // Deposit into lending (locked)
  console.log("\n-- Lending: deposit --");
  await (await lendVault.deposit(amount, deployer.address)).wait();
  const lendShareAddr = await lendVault.shareToken();
  const lendShare = await ethers.getContractAt("ERC20", lendShareAddr);
  console.log("lend shares minted:", (await lendShare.balanceOf(deployer.address)).toString());
  const lendLockInfoBefore = await lendLock.lockInfo(deployer.address);
  console.log("lend lock info (before):", lendLockInfoBefore);

  // Early withdraw from lending with penalty (withdraw 400)
  const withdrawAssets = ethers.parseUnits("400", 18);
  console.log("\n-- Lending: early withdraw 400 (expect 5% penalty) --");
  const balBefore = await asset.balanceOf(deployer.address);
  await (await lendVault.withdraw(withdrawAssets, deployer.address, deployer.address)).wait();
  const balAfter = await asset.balanceOf(deployer.address);
  const received = balAfter - balBefore;
  console.log("Received:", received.toString());
  const expectedNoPenalty = withdrawAssets;
  const penalty = expectedNoPenalty - received;
  console.log("Implied penalty:", penalty.toString());

  // Withdraw from staking (no penalty) 300
  console.log("\n-- Staking: withdraw 300 (no penalty) --");
  const balBeforeStake = await asset.balanceOf(deployer.address);
  await (await stakeVault.withdraw(ethers.parseUnits("300", 18), deployer.address, deployer.address)).wait();
  const balAfterStake = await asset.balanceOf(deployer.address);
  console.log("Received:", (balAfterStake - balBeforeStake).toString());

  const lendLockInfoAfter = await lendLock.lockInfo(deployer.address);
  console.log("lend lock info (after):", lendLockInfoAfter);

  console.log("\nDXP balance after:", (await asset.balanceOf(deployer.address)).toString());
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
