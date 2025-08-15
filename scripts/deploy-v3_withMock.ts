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

  // Per-vault overrides (staking vs lending)
  // Staking (streaming focus)
  const STAKE_VAULT_NAME = env("STAKE_VAULT_NAME", "Dexponent Staking Vault")!;
  const STAKE_VAULT_SYMBOL = env("STAKE_VAULT_SYMBOL", "dSTAKE")!;
  const STAKE_FARM_ID = BigInt(env("STAKE_FARM_ID", "1")!);
  const STAKE_LOCK_ENABLED = env("STAKE_LOCK_ENABLED", "false") === "true";
  const STAKE_LOCK_ALLOW_EARLY = env("STAKE_LOCK_ALLOW_EARLY", "true") === "true";
  const STAKE_LOCK_EARLY_BPS = Number(env("STAKE_LOCK_EARLY_BPS", "200")); // 2%
  const STAKE_LOCK_SECONDS = Number(env("STAKE_LOCK_SECONDS", "0"));
  const STAKE_LOCK_POST_MODE = Number(env("STAKE_LOCK_POST_MODE", "0"));
  const STAKE_PAYOUT_MODE = Number(env("STAKE_PAYOUT_MODE", String(PAYOUT_MODE))); // default stream
  const STAKE_PAYOUT_STREAM_BPS = Number(env("STAKE_PAYOUT_STREAM_BPS", String(PAYOUT_STREAM_BPS)));
  const STAKE_PAYOUT_COMPOUND_BPS = Number(env("STAKE_PAYOUT_COMPOUND_BPS", String(PAYOUT_COMPOUND_BPS)));
  const STAKE_PAYOUT_EPOCH = BigInt(env("STAKE_PAYOUT_EPOCH", String(PAYOUT_EPOCH))!);
  const STAKE_PAYOUT_MIN_HARVEST = BigInt(env("STAKE_PAYOUT_MIN_HARVEST", String(PAYOUT_MIN_HARVEST))!);
  const STAKE_PAYOUT_COMPOUND_ON_LOCK = env("STAKE_PAYOUT_COMPOUND_ON_LOCK", String(PAYOUT_COMPOUND_ON_LOCK)) === "true";

  // Lending (lockup focus)
  const LEND_VAULT_NAME = env("LEND_VAULT_NAME", "Dexponent Lending Vault")!;
  const LEND_VAULT_SYMBOL = env("LEND_VAULT_SYMBOL", "dLEND")!;
  const LEND_FARM_ID = BigInt(env("LEND_FARM_ID", "2")!);
  const LEND_LOCK_ENABLED = env("LEND_LOCK_ENABLED", "true") === "true";
  const LEND_LOCK_ALLOW_EARLY = env("LEND_LOCK_ALLOW_EARLY", "true") === "true";
  const LEND_LOCK_EARLY_BPS = Number(env("LEND_LOCK_EARLY_BPS", "500")); // 5%
  const LEND_LOCK_SECONDS = Number(env("LEND_LOCK_SECONDS", "1209600")); // 14 days
  const LEND_LOCK_POST_MODE = Number(env("LEND_LOCK_POST_MODE", "1"));
  const LEND_PAYOUT_MODE = Number(env("LEND_PAYOUT_MODE", "1")); // default Lockup
  const LEND_PAYOUT_STREAM_BPS = Number(env("LEND_PAYOUT_STREAM_BPS", "0"));
  const LEND_PAYOUT_COMPOUND_BPS = Number(env("LEND_PAYOUT_COMPOUND_BPS", "10000"));
  const LEND_PAYOUT_EPOCH = BigInt(env("LEND_PAYOUT_EPOCH", String(PAYOUT_EPOCH))!);
  const LEND_PAYOUT_MIN_HARVEST = BigInt(env("LEND_PAYOUT_MIN_HARVEST", String(PAYOUT_MIN_HARVEST))!);
  const LEND_PAYOUT_COMPOUND_ON_LOCK = env("LEND_PAYOUT_COMPOUND_ON_LOCK", "true") === "true";

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

  // 5-9) Deploy two vault stacks with their own routers, policies, registry, and wire them
  const StrategyRouter = await ethers.getContractFactory("StrategyRouter");
  const MockStrategyAdapter = await ethers.getContractFactory("MockStrategyAdapter");
  const LockupPolicy = await ethers.getContractFactory("LockupPolicy");
  const PayoutPolicy = await ethers.getContractFactory("PayoutPolicy");
  const StakeholderRegistry = await ethers.getContractFactory("StakeholderRegistry");
  const BaseVault = await ethers.getContractFactory("BaseVault");

  // --- Staking Vault (streaming payouts) ---
  console.log("Deploying Staking StrategyRouter...");
  const stakeRouter = await StrategyRouter.deploy(ASSET_TOKEN);
  await stakeRouter.waitForDeployment();
  const stakeRouterAddr = await stakeRouter.getAddress();
  console.log("Staking Router:", stakeRouterAddr);

  console.log("Deploying Staking MockStrategyAdapter...");
  const stakeAdapter = await MockStrategyAdapter.deploy(ASSET_TOKEN);
  await stakeAdapter.waitForDeployment();
  const stakeAdapterAddr = await stakeAdapter.getAddress();
  console.log("Staking MockAdapter:", stakeAdapterAddr);

  console.log("Deploying Staking Policies...");
  const stakeLockCfg = {
    enabled: STAKE_LOCK_ENABLED,
    allowEarlyExit: STAKE_LOCK_ALLOW_EARLY,
    earlyExitBps: STAKE_LOCK_EARLY_BPS,
    lockupSeconds: BigInt(STAKE_LOCK_SECONDS),
    postLockMode: STAKE_LOCK_POST_MODE,
  };
  const stakeLock = await LockupPolicy.deploy(stakeLockCfg);
  await stakeLock.waitForDeployment();
  const stakeLockAddr = await stakeLock.getAddress();

  const stakePayoutCfg = {
    mode: STAKE_PAYOUT_MODE,
    streamBps: STAKE_PAYOUT_STREAM_BPS,
    compoundBps: STAKE_PAYOUT_COMPOUND_BPS,
    epoch: STAKE_PAYOUT_EPOCH,
    minHarvestInterval: STAKE_PAYOUT_MIN_HARVEST,
    compoundLpOnLock: STAKE_PAYOUT_COMPOUND_ON_LOCK,
  };
  const stakePayout = await PayoutPolicy.deploy(ASSET_TOKEN, stakePayoutCfg);
  await stakePayout.waitForDeployment();
  const stakePayoutAddr = await stakePayout.getAddress();

  console.log("Deploying Staking StakeholderRegistry (farmId=", STAKE_FARM_ID.toString(), ")...");
  const stakeRegistry = await StakeholderRegistry.deploy(coreAddr, STAKE_FARM_ID);
  await stakeRegistry.waitForDeployment();
  const stakeRegistryAddr = await stakeRegistry.getAddress();
  if (env("SET_INITIAL_SPLITS", "true") === "true") {
    await (await stakeRegistry.setSplits(7000, 2500, 500)).wait();
    await (await stakeRegistry.setOwnerRecipient(deployerAddress)).wait();
  }

  console.log("Deploying Staking BaseVault...");
  const stakeVault = await BaseVault.deploy(ASSET_TOKEN, STAKE_VAULT_NAME, STAKE_VAULT_SYMBOL);
  await stakeVault.waitForDeployment();
  const stakeVaultAddr = await stakeVault.getAddress();
  console.log("Staking Vault:", stakeVaultAddr);
  console.log("Wiring Staking Vault modules...");
  await (await stakeVault.setStrategyRouter(stakeRouterAddr)).wait();
  await (await stakeVault.setPayoutPolicy(stakePayoutAddr)).wait();
  // authorize vault in payout policy for streaming accruals
  await (await stakePayout.setVault(stakeVaultAddr)).wait();
  await (await stakeVault.setLockupPolicy(stakeLockAddr)).wait();
  await (await stakeVault.setStakeholderRegistry(stakeRegistryAddr)).wait();

  // Set single-allocation to staking adapter at 100%
  console.log("Setting Staking allocations -> 100% MockAdapter...");
  await (await stakeRouter.setAllocations([
    ethers.id("STAKE_MOCK"),
  ], [
    stakeAdapterAddr,
  ], [
    10000,
  ])).wait();

  // --- Lending Vault (lockup payouts) ---
  console.log("Deploying Lending StrategyRouter...");
  const lendRouter = await StrategyRouter.deploy(ASSET_TOKEN);
  await lendRouter.waitForDeployment();
  const lendRouterAddr = await lendRouter.getAddress();
  console.log("Lending Router:", lendRouterAddr);

  console.log("Deploying Lending MockStrategyAdapter...");
  const lendAdapter = await MockStrategyAdapter.deploy(ASSET_TOKEN);
  await lendAdapter.waitForDeployment();
  const lendAdapterAddr = await lendAdapter.getAddress();
  console.log("Lending MockAdapter:", lendAdapterAddr);

  console.log("Deploying Lending Policies...");
  const lendLockCfg = {
    enabled: LEND_LOCK_ENABLED,
    allowEarlyExit: LEND_LOCK_ALLOW_EARLY,
    earlyExitBps: LEND_LOCK_EARLY_BPS,
    lockupSeconds: BigInt(LEND_LOCK_SECONDS),
    postLockMode: LEND_LOCK_POST_MODE,
  };
  const lendLock = await LockupPolicy.deploy(lendLockCfg);
  await lendLock.waitForDeployment();
  const lendLockAddr = await lendLock.getAddress();

  const lendPayoutCfg = {
    mode: LEND_PAYOUT_MODE,
    streamBps: LEND_PAYOUT_STREAM_BPS,
    compoundBps: LEND_PAYOUT_COMPOUND_BPS,
    epoch: LEND_PAYOUT_EPOCH,
    minHarvestInterval: LEND_PAYOUT_MIN_HARVEST,
    compoundLpOnLock: LEND_PAYOUT_COMPOUND_ON_LOCK,
  };
  const lendPayout = await PayoutPolicy.deploy(ASSET_TOKEN, lendPayoutCfg);
  await lendPayout.waitForDeployment();
  const lendPayoutAddr = await lendPayout.getAddress();

  console.log("Deploying Lending StakeholderRegistry (farmId=", LEND_FARM_ID.toString(), ")...");
  const lendRegistry = await StakeholderRegistry.deploy(coreAddr, LEND_FARM_ID);
  await lendRegistry.waitForDeployment();
  const lendRegistryAddr = await lendRegistry.getAddress();
  if (env("SET_INITIAL_SPLITS", "true") === "true") {
    await (await lendRegistry.setSplits(7000, 2500, 500)).wait();
    await (await lendRegistry.setOwnerRecipient(deployerAddress)).wait();
  }

  console.log("Deploying Lending BaseVault...");
  const lendVault = await BaseVault.deploy(ASSET_TOKEN, LEND_VAULT_NAME, LEND_VAULT_SYMBOL);
  await lendVault.waitForDeployment();
  const lendVaultAddr = await lendVault.getAddress();
  console.log("Lending Vault:", lendVaultAddr);
  console.log("Wiring Lending Vault modules...");
  await (await lendVault.setStrategyRouter(lendRouterAddr)).wait();
  await (await lendVault.setPayoutPolicy(lendPayoutAddr)).wait();
  await (await lendPayout.setVault(lendVaultAddr)).wait();
  await (await lendVault.setLockupPolicy(lendLockAddr)).wait();
  await (await lendVault.setStakeholderRegistry(lendRegistryAddr)).wait();

  // Set single-allocation to lending adapter at 100%
  console.log("Setting Lending allocations -> 100% MockAdapter...");
  await (await lendRouter.setAllocations([
    ethers.id("LEND_MOCK"),
  ], [
    lendAdapterAddr,
  ], [
    10000,
  ])).wait();

  // Save addresses
  const addresses = {
    network,
    deployer: deployerAddress,
    contracts: {
      DXPToken: dxpAddr,
      FarmFactory: farmFactoryAddr,
      ProtocolCore: coreAddr,
      MockLiquidityManager: mockLmAddr,
      vaults: {
        staking: {
          StrategyRouter: stakeRouterAddr,
          MockStrategyAdapter: stakeAdapterAddr,
          LockupPolicy: stakeLockAddr,
          PayoutPolicy: stakePayoutAddr,
          StakeholderRegistry: stakeRegistryAddr,
          BaseVault: stakeVaultAddr,
        },
        lending: {
          StrategyRouter: lendRouterAddr,
          MockStrategyAdapter: lendAdapterAddr,
          LockupPolicy: lendLockAddr,
          PayoutPolicy: lendPayoutAddr,
          StakeholderRegistry: lendRegistryAddr,
          BaseVault: lendVaultAddr,
        },
      },
    },
    params: {
      ASSET_TOKEN,
      USDC_TOKEN,
      FALLBACK_BONUS_RATIO: FALLBACK_BONUS_RATIO.toString(),
      PROTOCOL_FEE_RATE: PROTOCOL_FEE_RATE.toString(),
      RESERVE_RATIO: RESERVE_RATIO.toString(),
      // Staking config snapshot
      STAKE: {
        VAULT_NAME: STAKE_VAULT_NAME,
        VAULT_SYMBOL: STAKE_VAULT_SYMBOL,
        FARM_ID: STAKE_FARM_ID.toString(),
        LOCK_ENABLED: STAKE_LOCK_ENABLED,
        LOCK_ALLOW_EARLY: STAKE_LOCK_ALLOW_EARLY,
        LOCK_EARLY_BPS: STAKE_LOCK_EARLY_BPS,
        LOCK_SECONDS: STAKE_LOCK_SECONDS,
        LOCK_POST_MODE: STAKE_LOCK_POST_MODE,
        PAYOUT_MODE: STAKE_PAYOUT_MODE,
        PAYOUT_STREAM_BPS: STAKE_PAYOUT_STREAM_BPS,
        PAYOUT_COMPOUND_BPS: STAKE_PAYOUT_COMPOUND_BPS,
        PAYOUT_EPOCH: STAKE_PAYOUT_EPOCH.toString(),
        PAYOUT_MIN_HARVEST: STAKE_PAYOUT_MIN_HARVEST.toString(),
        PAYOUT_COMPOUND_ON_LOCK: STAKE_PAYOUT_COMPOUND_ON_LOCK,
      },
      // Lending config snapshot
      LEND: {
        VAULT_NAME: LEND_VAULT_NAME,
        VAULT_SYMBOL: LEND_VAULT_SYMBOL,
        FARM_ID: LEND_FARM_ID.toString(),
        LOCK_ENABLED: LEND_LOCK_ENABLED,
        LOCK_ALLOW_EARLY: LEND_LOCK_ALLOW_EARLY,
        LOCK_EARLY_BPS: LEND_LOCK_EARLY_BPS,
        LOCK_SECONDS: LEND_LOCK_SECONDS,
        LOCK_POST_MODE: LEND_LOCK_POST_MODE,
        PAYOUT_MODE: LEND_PAYOUT_MODE,
        PAYOUT_STREAM_BPS: LEND_PAYOUT_STREAM_BPS,
        PAYOUT_COMPOUND_BPS: LEND_PAYOUT_COMPOUND_BPS,
        PAYOUT_EPOCH: LEND_PAYOUT_EPOCH.toString(),
        PAYOUT_MIN_HARVEST: LEND_PAYOUT_MIN_HARVEST.toString(),
        PAYOUT_COMPOUND_ON_LOCK: LEND_PAYOUT_COMPOUND_ON_LOCK,
      },
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
