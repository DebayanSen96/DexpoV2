import hre from "hardhat";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// Helper to read env with defaults
function env(name: string, def?: string): string | undefined {
  return process.env[name] ?? def;
}

async function main() {
  const network: string = ((hre as any).network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat";
  const { ethers } = hre as any;

  console.log("Network:", network);

  // Configurable params via env (ASSET_TOKEN may be set after DXP deploy)
  const ASSET_TOKEN_ENV = env("ASSET_TOKEN");

  const FALLBACK_BONUS_RATIO = BigInt(env("FALLBACK_BONUS_RATIO", "70")!); // %
  const PROTOCOL_FEE_RATE = BigInt(env("PROTOCOL_FEE_RATE", "10")!); // % of farm owner slice
  const RESERVE_RATIO = BigInt(env("RESERVE_RATIO", "50")!); // % of fee kept in reserves

  // Policy defaults
  const LOCK_ENABLED = env("LOCK_ENABLED", "false") === "true";
  const LOCK_ALLOW_EARLY = env("LOCK_ALLOW_EARLY", "true") === "true";
  const LOCK_EARLY_BPS = Number(env("LOCK_EARLY_BPS", "500")); // 5%
  const LOCK_SECONDS = Number(env("LOCK_SECONDS", "604800")); // 7 days
  const LOCK_POST_MODE = Number(env("LOCK_POST_MODE", "0"));

  const PAYOUT_MODE = Number(env("PAYOUT_MODE", "0")); // 0=Stream,1=Lockup
  const PAYOUT_STREAM_BPS = Number(env("PAYOUT_STREAM_BPS", "3000")); // 30%
  const PAYOUT_COMPOUND_BPS = Number(env("PAYOUT_COMPOUND_BPS", "7000")); // 70%
  const PAYOUT_EPOCH = BigInt(env("PAYOUT_EPOCH", "86400")!); // 1 day
  const PAYOUT_MIN_HARVEST = BigInt(env("PAYOUT_MIN_HARVEST", "300")!); // 5 min
  const PAYOUT_COMPOUND_ON_LOCK = env("PAYOUT_COMPOUND_ON_LOCK", "true") === "true";

  // 1) Deploy DXPToken
  console.log("Deploying DXPToken...");
  const DXPFactory = await ethers.getContractFactory("DXPToken");
  const dxp = await DXPFactory.deploy();
  await dxp.waitForDeployment();
  const dxpAddr = await dxp.getAddress();
  console.log("DXPToken:", dxpAddr);

  // Infer deployer/owner from the first deployed contract
  const deployerAddress = await dxp.owner();
  console.log("Deployer:", deployerAddress);

  // Resolve base asset after DXP is available; default to DXP if not provided
  const ASSET_TOKEN = ASSET_TOKEN_ENV ?? dxpAddr;
  const USDC_TOKEN = env("USDC_TOKEN", ASSET_TOKEN);

  // 2) Deploy FarmFactory (for ProtocolCore constructor)
  console.log("Deploying FarmFactory...");
  const FarmFactory = await ethers.getContractFactory("FarmFactory");
  const farmFactory = await FarmFactory.deploy();
  await farmFactory.waitForDeployment();
  const farmFactoryAddr = await farmFactory.getAddress();
  console.log("FarmFactory:", farmFactoryAddr);

  // 3) Deploy ProtocolCore(address dxp, uint256 fallbackRatio, uint256 protocolFeeRate, uint256 reserveRatio, address farmFactory)
  console.log("Deploying ProtocolCore...");
  const ProtocolCore = await ethers.getContractFactory("ProtocolCore");
  const core = await ProtocolCore.deploy(
    dxpAddr,
    FALLBACK_BONUS_RATIO,
    PROTOCOL_FEE_RATE,
    RESERVE_RATIO,
    farmFactoryAddr,
  );
  await core.waitForDeployment();
  const coreAddr = await core.getAddress();
  console.log("ProtocolCore:", coreAddr);

  // Transfer DXPToken ownership to ProtocolCore so it can call emitTokens/recycle
  console.log("Transferring DXPToken ownership to ProtocolCore...");
  await (await dxp.transferOwnership(coreAddr)).wait();

  // 4) Deploy MockLiquidityManager(dxp, usdc)
  console.log("Deploying MockLiquidityManager...");
  const MockLiquidityManager = await ethers.getContractFactory("MockLiquidityManager");
  const mockLm = await MockLiquidityManager.deploy(
    dxpAddr,
    USDC_TOKEN,
  );
  await mockLm.waitForDeployment();
  const mockLmAddr = await mockLm.getAddress();
  console.log("MockLiquidityManager:", mockLmAddr);

  // Wire LiquidityManager into ProtocolCore
  console.log("Wiring LiquidityManager in ProtocolCore...");
  await (await core.setLiquidityManager(mockLmAddr)).wait();

  // Optionally approve deployer as farm owner in core (useful for tests)
  console.log("Approving deployer as farm owner in ProtocolCore...");
  await (await core.setApprovedFarmOwner(deployerAddress, true)).wait();

  // 5) Deploy StrategyRouter with the base asset
  console.log("Deploying StrategyRouter...");
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
  const router = await StrategyRouter.deploy(ASSET_TOKEN);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("StrategyRouter:", routerAddr);

  // 6) Deploy Policies
  console.log("Deploying LockupPolicy...");
  const lockCfg = {
    enabled: LOCK_ENABLED,
    allowEarlyExit: LOCK_ALLOW_EARLY,
    earlyExitBps: LOCK_EARLY_BPS,
    lockupSeconds: BigInt(LOCK_SECONDS),
    postLockMode: LOCK_POST_MODE,
  };
  const LockupPolicy = await ethers.getContractFactory("LockupPolicy");
  const lockup = await LockupPolicy.deploy(lockCfg);
  await lockup.waitForDeployment();
  const lockupAddr = await lockup.getAddress();
  console.log("LockupPolicy:", lockupAddr);

  console.log("Deploying PayoutPolicy...");
  const payoutCfg = {
    mode: PAYOUT_MODE,
    streamBps: PAYOUT_STREAM_BPS,
    compoundBps: PAYOUT_COMPOUND_BPS,
    epoch: PAYOUT_EPOCH,
    minHarvestInterval: PAYOUT_MIN_HARVEST,
    compoundLpOnLock: PAYOUT_COMPOUND_ON_LOCK,
  };
  const PayoutPolicy = await ethers.getContractFactory("PayoutPolicy");
  const payout = await PayoutPolicy.deploy(payoutCfg);
  await payout.waitForDeployment();
  const payoutAddr = await payout.getAddress();
  console.log("PayoutPolicy:", payoutAddr);

  // 7) Deploy StakeholderRegistry(core, farmId)
  // For initial setup, we use farmId=0 (Root Farm semantics) so registry can read verifiers from core.
  const FARM_ID = BigInt(env("FARM_ID", "0")!);
  console.log("Deploying StakeholderRegistry (farmId=", FARM_ID.toString(), ")...");
  const StakeholderRegistry = await ethers.getContractFactory("StakeholderRegistry");
  const stakeholders = await StakeholderRegistry.deploy(
    coreAddr,
    FARM_ID,
  );
  await stakeholders.waitForDeployment();
  const stakeholdersAddr = await stakeholders.getAddress();
  console.log("StakeholderRegistry:", stakeholdersAddr);

  // Optionally set initial splits (LP/Owner/Verifier) to 7000/2500/500
  if (env("SET_INITIAL_SPLITS", "true") === "true") {
    console.log("Setting initial splits on StakeholderRegistry...");
    await (await stakeholders.setSplits(7000, 2500, 500)).wait();
    await (await stakeholders.setOwnerRecipient(deployerAddress)).wait();
  }

  // 8) Deploy BaseVault(asset, name, symbol)
  const VAULT_NAME = env("VAULT_NAME", "Dexponent Vault Shares")!;
  const VAULT_SYMBOL = env("VAULT_SYMBOL", "dShares")!;
  console.log("Deploying BaseVault...");
  const BaseVault = await ethers.getContractFactory("BaseVault");
  const vault = await BaseVault.deploy(
    ASSET_TOKEN,
    VAULT_NAME,
    VAULT_SYMBOL,
  );
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("BaseVault:", vaultAddr);

  // 9) Wire BaseVault modules
  console.log("Wiring BaseVault modules...");
  await (await vault.setStrategyRouter(routerAddr)).wait();
  await (await vault.setPayoutPolicy(payoutAddr)).wait();
  await (await vault.setLockupPolicy(lockupAddr)).wait();
  await (await vault.setStakeholderRegistry(stakeholdersAddr)).wait();

  // Save addresses
  const addresses = {
    network,
    deployer: deployerAddress,
    contracts: {
      DXPToken: dxpAddr,
      FarmFactory: farmFactoryAddr,
      ProtocolCore: coreAddr,
      MockLiquidityManager: mockLmAddr,
      StrategyRouter: routerAddr,
      LockupPolicy: lockupAddr,
      PayoutPolicy: payoutAddr,
      StakeholderRegistry: stakeholdersAddr,
      BaseVault: vaultAddr,
    },
    params: {
      ASSET_TOKEN,
      USDC_TOKEN,
      FALLBACK_BONUS_RATIO: FALLBACK_BONUS_RATIO.toString(),
      PROTOCOL_FEE_RATE: PROTOCOL_FEE_RATE.toString(),
      RESERVE_RATIO: RESERVE_RATIO.toString(),
      LOCK_ENABLED,
      LOCK_ALLOW_EARLY,
      LOCK_EARLY_BPS,
      LOCK_SECONDS,
      LOCK_POST_MODE,
      PAYOUT_MODE,
      PAYOUT_STREAM_BPS,
      PAYOUT_COMPOUND_BPS,
      PAYOUT_EPOCH: PAYOUT_EPOCH.toString(),
      PAYOUT_MIN_HARVEST: PAYOUT_MIN_HARVEST.toString(),
      PAYOUT_COMPOUND_ON_LOCK,
      FARM_ID: FARM_ID.toString(),
      VAULT_NAME,
      VAULT_SYMBOL,
    },
  } as const;

  const outDir = join("deployments", network);
  const outFile = join(outDir, `v3-${Date.now()}.json`);
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, JSON.stringify(addresses, null, 2));

  console.log("Deployment complete. Addresses saved to:", outFile);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
