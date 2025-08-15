import hre from "hardhat";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

function latestDeploymentFile(network: string): string {
  const dir = join("deployments", network);
  const files = readdirSync(dir).filter(f => f.startsWith("v3-") && f.endsWith(".json"));
  if (files.length === 0) throw new Error(`No deployment files in ${dir}`);
  files.sort();
  return join(dir, files[files.length - 1]);
}

async function main() {
  const network: string = ((hre as any).network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat";
  const { ethers } = hre as any;

  const file = process.env.DEPLOY_JSON || latestDeploymentFile(network);
  const data = JSON.parse(readFileSync(file, "utf8"));
  console.log("Using deployment:", file);

  const coreAddr: string = data.contracts.ProtocolCore;
  const deployer: string = data.deployer;
  const asset: string = data.params.ASSET_TOKEN;

  const stake = data.contracts.vaults.staking;
  const lend = data.contracts.vaults.lending;

  // Helpers
  async function expectEq(actual: any, expected: any, label: string) {
    if (typeof actual === "bigint" || typeof expected === "bigint") {
      if (BigInt(actual) !== BigInt(expected)) throw new Error(`${label} mismatch: ${actual} != ${expected}`);
    } else if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
      throw new Error(`${label} mismatch: ${actual} != ${expected}`);
    }
    console.log("✔", label, "=", expected);
  }

  async function verifyVaultStack(name: string, stack: any, params: any) {
    console.log(`\nVerifying ${name} stack...`);

    const vault = await ethers.getContractAt("BaseVault", stack.BaseVault);
    const router = await ethers.getContractAt("StrategyRouter", stack.StrategyRouter);
    const payout = await ethers.getContractAt("PayoutPolicy", stack.PayoutPolicy);
    const lockup = await ethers.getContractAt("LockupPolicy", stack.LockupPolicy);
    const reg = await ethers.getContractAt("StakeholderRegistry", stack.StakeholderRegistry);

    // BaseVault wiring
    await expectEq(await vault.asset(), asset, `${name}: vault.asset`);
    await expectEq(await vault.router(), stack.StrategyRouter, `${name}: vault.router`);
    await expectEq(await vault.payoutPolicy(), stack.PayoutPolicy, `${name}: vault.payoutPolicy`);
    await expectEq(await vault.lockupPolicy(), stack.LockupPolicy, `${name}: vault.lockupPolicy`);
    await expectEq(await vault.stakeholderRegistry(), stack.StakeholderRegistry, `${name}: vault.stakeholderRegistry`);

    // Router owns no extra state to verify here; just ensure asset matches
    await expectEq(await router.asset(), asset, `${name}: router.asset`);

    // Policies
    const pcfg = await payout.getConfig();
    await expectEq(pcfg.mode, params.PAYOUT_MODE, `${name}: payout.mode`);
    await expectEq(pcfg.streamBps, params.PAYOUT_STREAM_BPS, `${name}: payout.streamBps`);
    await expectEq(pcfg.compoundBps, params.PAYOUT_COMPOUND_BPS, `${name}: payout.compoundBps`);
    await expectEq(pcfg.epoch, params.PAYOUT_EPOCH, `${name}: payout.epoch`);
    await expectEq(pcfg.minHarvestInterval, params.PAYOUT_MIN_HARVEST, `${name}: payout.minHarvestInterval`);
    await expectEq(pcfg.compoundLpOnLock, params.PAYOUT_COMPOUND_ON_LOCK, `${name}: payout.compoundLpOnLock`);

    const lcfg = await lockup.getLockConfig();
    await expectEq(lcfg.enabled, params.LOCK_ENABLED, `${name}: lock.enabled`);
    await expectEq(lcfg.allowEarlyExit, params.LOCK_ALLOW_EARLY, `${name}: lock.allowEarlyExit`);
    await expectEq(lcfg.earlyExitBps, params.LOCK_EARLY_BPS, `${name}: lock.earlyExitBps`);
    await expectEq(lcfg.lockupSeconds, params.LOCK_SECONDS, `${name}: lock.lockupSeconds`);
    await expectEq(lcfg.postLockMode, params.LOCK_POST_MODE, `${name}: lock.postLockMode`);

    // StakeholderRegistry
    await expectEq(await reg.protocolCore(), coreAddr, `${name}: registry.protocolCore`);
    await expectEq(await reg.farmId(), params.FARM_ID, `${name}: registry.farmId`);
    const splits = await reg.getSplits();
    await expectEq(splits.lpBps, 7000, `${name}: registry.splits.lpBps`);
    await expectEq(splits.ownerBps, 2500, `${name}: registry.splits.ownerBps`);
    await expectEq(splits.verifierBps, 500, `${name}: registry.splits.verifierBps`);
    await expectEq(await reg.ownerRecipient(), deployer, `${name}: registry.ownerRecipient`);

    console.log(`✔ ${name} stack verified`);
  }

  await verifyVaultStack("Staking", stake, {
    ...data.params.STAKE,
    // Coerce to BigInt for uint64/uint256 params where needed
    PAYOUT_EPOCH: BigInt(data.params.STAKE.PAYOUT_EPOCH),
    PAYOUT_MIN_HARVEST: BigInt(data.params.STAKE.PAYOUT_MIN_HARVEST),
    LOCK_SECONDS: BigInt(data.params.STAKE.LOCK_SECONDS),
    FARM_ID: BigInt(data.params.STAKE.FARM_ID),
  });

  await verifyVaultStack("Lending", lend, {
    ...data.params.LEND,
    PAYOUT_EPOCH: BigInt(data.params.LEND.PAYOUT_EPOCH),
    PAYOUT_MIN_HARVEST: BigInt(data.params.LEND.PAYOUT_MIN_HARVEST),
    LOCK_SECONDS: BigInt(data.params.LEND.LOCK_SECONDS),
    FARM_ID: BigInt(data.params.LEND.FARM_ID),
  });

  console.log("\nAll checks passed.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
