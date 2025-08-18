import hre from "hardhat";
import { readFile } from "fs/promises";
import { join } from "path";

async function expectRevert(p: Promise<any>, label: string) {
  try {
    await p;
    console.error(`FAIL: ${label} did not revert`);
    process.exitCode = 1;
  } catch (e: any) {
    console.log(`PASS: ${label} reverted as expected (${e?.shortMessage || e?.message || e})`);
  }
}

async function main() {
  const { ethers, network } = hre as any;
  console.log(`E2E on network: ${network.name}`);

  // 0) Ensure localhost deployment exists by re-running deploy script
  console.log("Redeploying contracts on localhost...");
  // The script is already run with --network localhost; no need to pass network again.
  await hre.run("run", { script: "scripts/deploy-v3.ts" });

  // 1) Load deployed addresses
  const file = join("deployments", "localhost", "localhost.json");
  const data = JSON.parse(await readFile(file, "utf8"));

  const deployer = data.deployer as string;
  const coreAddr = data.contracts.ProtocolCore as string;
  const stake = data.contracts.vaults.staking;
  const lend = data.contracts.vaults.lending;

  const [acc0, acc1] = await ethers.getSigners();
  console.log("Deployer (acc0):", acc0.address);

  const core = await ethers.getContractAt("ProtocolCore", coreAddr);

  // 2) Sanity: registry entries match saved JSON
  const stakeOnChain = await core.farmsById(BigInt(stake.FarmId));
  const lendOnChain = await core.farmsById(BigInt(lend.FarmId));

  if (
    stakeOnChain.baseFarm.toLowerCase() !== stake.BaseFarm.toLowerCase() ||
    stakeOnChain.router.toLowerCase() !== stake.StrategyRouter.toLowerCase() ||
    stakeOnChain.payoutPolicy.toLowerCase() !== stake.PayoutPolicy.toLowerCase() ||
    stakeOnChain.lockupPolicy.toLowerCase() !== stake.LockupPolicy.toLowerCase() ||
    stakeOnChain.stakeholderRegistry.toLowerCase() !== stake.StakeholderRegistry.toLowerCase()
  ) {
    console.error("FAIL: Staking modules mismatch with on-chain registry");
    process.exitCode = 1;
  } else {
    console.log("PASS: Staking modules match on-chain registry");
  }

  if (
    lendOnChain.baseFarm.toLowerCase() !== lend.BaseFarm.toLowerCase() ||
    lendOnChain.router.toLowerCase() !== lend.StrategyRouter.toLowerCase() ||
    lendOnChain.payoutPolicy.toLowerCase() !== lend.PayoutPolicy.toLowerCase() ||
    lendOnChain.lockupPolicy.toLowerCase() !== lend.LockupPolicy.toLowerCase() ||
    lendOnChain.stakeholderRegistry.toLowerCase() !== lend.StakeholderRegistry.toLowerCase()
  ) {
    console.error("FAIL: Lending modules mismatch with on-chain registry");
    process.exitCode = 1;
  } else {
    console.log("PASS: Lending modules match on-chain registry");
  }

  // 3) Only approved owners can create farms
  const isApproved = await core.approvedFarmOwners(deployer);
  if (!isApproved) {
    console.error("FAIL: Deployer not approved as farm owner");
    process.exitCode = 1;
  } else {
    console.log("PASS: Deployer is approved farm owner");
  }

  // Attempt createApprovedFarm from an unapproved account (acc1)
  const asset = data.params.ASSET_TOKEN as string;
  const badCall = core
    .connect(acc1)
    .createApprovedFarm(
      asset,
      "Bad Farm",
      "BAD",
      acc1.address,
      7000,
      2000,
      1000,
      { enabled: false, allowEarlyExit: true, earlyExitBps: 0, lockupSeconds: 0n, postLockMode: 0 },
      { mode: 0, streamBps: 5000, compoundBps: 5000, epoch: 86400n, minHarvestInterval: 60n, compoundLpOnLock: true },
      { transferable: true, transferFeeBps: 0, feeReceiver: ethers.ZeroAddress, protocolFeeReceiver: acc1.address, protocolRakeBps: 500 },
      [],
      [],
      []
    );
  await expectRevert(badCall, "createApprovedFarm by unapproved owner");

  // 4) Config validation should fail if splits don't sum to 100%
  const badSplits = core
    .connect(acc0)
    .createApprovedFarm(
      asset,
      "Invalid Farm",
      "INV",
      acc0.address,
      7000,
      3000, // sum=11000 -> revert
      1000,
      { enabled: false, allowEarlyExit: true, earlyExitBps: 0, lockupSeconds: 0n, postLockMode: 0 },
      { mode: 0, streamBps: 5000, compoundBps: 5000, epoch: 86400n, minHarvestInterval: 60n, compoundLpOnLock: true },
      { transferable: true, transferFeeBps: 0, feeReceiver: ethers.ZeroAddress, protocolFeeReceiver: acc0.address, protocolRakeBps: 500 },
      [],
      [],
      []
    );
  await expectRevert(badSplits, "createApprovedFarm with invalid splits");

  // 5) Protocol fee reporting: impersonate BaseFarm and report
  const farmId = BigInt(stake.FarmId);
  const baseFarm = stake.BaseFarm as string;
  const beforeFarm = await core.totalProtocolFeesByFarm(farmId);
  const beforeGlobal = await core.totalProtocolFees();

  // Ensure the impersonated BaseFarm has ETH to pay for gas (contract may be non-payable)
  const oneEth = ethers.parseEther("1");
  await hre.network.provider.send("hardhat_setBalance", [baseFarm, ethers.toBeHex(oneEth)]);
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [baseFarm] });
  const farmSigner = await ethers.getSigner(baseFarm);
  const reportAmount = 12345n;
  await core.connect(farmSigner).reportProtocolFee(farmId, reportAmount);
  await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [baseFarm] });

  const afterFarm = await core.totalProtocolFeesByFarm(farmId);
  const afterGlobal = await core.totalProtocolFees();

  const deltaFarm = BigInt(afterFarm) - BigInt(beforeFarm);
  const deltaGlobal = BigInt(afterGlobal) - BigInt(beforeGlobal);
  if (deltaFarm === reportAmount && deltaGlobal === reportAmount) {
    console.log("PASS: Protocol fee reporting accounted correctly");
  } else {
    console.error("FAIL: Protocol fee reporting mismatch");
    process.exitCode = 1;
  }

  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("E2E checks failed");
  }
  console.log("E2E completed successfully");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
