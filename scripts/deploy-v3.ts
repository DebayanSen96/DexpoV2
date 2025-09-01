  import hre from "hardhat";
import "dotenv/config";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// Helper to read env with defaults
function env(name: string, def?: string): string | undefined {
  return process.env[name] ?? def;
}

// Helper: get EIP-1559 gas overrides with a safety bump
async function getGasOverrides(ethers: any) {
  const feeData = await ethers.provider.getFeeData();
  const fallbackMaxFee = ethers.parseUnits("20", "gwei");
  const fallbackPriority = ethers.parseUnits("1.5", "gwei");
  const maxFeePerGas = (feeData.maxFeePerGas ?? fallbackMaxFee) * 12n / 10n; // +20%
  const maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas ?? fallbackPriority) * 12n / 10n; // +20%
  return { maxFeePerGas, maxPriorityFeePerGas };
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
  // Staking (NodeSSV) — lockup focus
  const STAKE_VAULT_NAME = env("STAKE_VAULT_NAME", "Dexponent NodeSSV Vault")!; // uses NodeSsvStakingAdapter
  const STAKE_VAULT_SYMBOL = env("STAKE_VAULT_SYMBOL", "dSSV")!;
  const STAKE_FARM_ID = BigInt(env("STAKE_FARM_ID", "1")!);
  const STAKE_LOCK_ENABLED = env("STAKE_LOCK_ENABLED", "true") === "true";
  const STAKE_LOCK_ALLOW_EARLY = env("STAKE_LOCK_ALLOW_EARLY", "true") === "true";
  const STAKE_LOCK_EARLY_BPS = Number(env("STAKE_LOCK_EARLY_BPS", "500")); // 5%
  const STAKE_LOCK_SECONDS = Number(env("STAKE_LOCK_SECONDS", "1209600")); // 14 days
  const STAKE_LOCK_POST_MODE = Number(env("STAKE_LOCK_POST_MODE", "1"));
  const STAKE_PAYOUT_MODE = Number(env("STAKE_PAYOUT_MODE", "1")); // Lockup
  const STAKE_PAYOUT_STREAM_BPS = Number(env("STAKE_PAYOUT_STREAM_BPS", "0"));
  const STAKE_PAYOUT_COMPOUND_BPS = Number(env("STAKE_PAYOUT_COMPOUND_BPS", "10000"));
  const STAKE_PAYOUT_EPOCH = BigInt(env("STAKE_PAYOUT_EPOCH", String(PAYOUT_EPOCH))!);
  const STAKE_PAYOUT_MIN_HARVEST = BigInt(env("STAKE_PAYOUT_MIN_HARVEST", String(PAYOUT_MIN_HARVEST))!);
  const STAKE_PAYOUT_COMPOUND_ON_LOCK = env("STAKE_PAYOUT_COMPOUND_ON_LOCK", "true") === "true";

  // Bluechip Index (streaming focus) — uses BluechipIndexAdapter
  const LEND_VAULT_NAME = env("LEND_VAULT_NAME", "Dexponent Bluechip Vault")!; // test: BluechipIndexAdapter
  const LEND_VAULT_SYMBOL = env("LEND_VAULT_SYMBOL", "dBLUE")!;
  const LEND_FARM_ID = BigInt(env("LEND_FARM_ID", "2")!);
  const LEND_LOCK_ENABLED = env("LEND_LOCK_ENABLED", "false") === "true";
  const LEND_LOCK_ALLOW_EARLY = env("LEND_LOCK_ALLOW_EARLY", "true") === "true";
  const LEND_LOCK_EARLY_BPS = Number(env("LEND_LOCK_EARLY_BPS", "200")); // 2%
  const LEND_LOCK_SECONDS = Number(env("LEND_LOCK_SECONDS", "0"));
  const LEND_LOCK_POST_MODE = Number(env("LEND_LOCK_POST_MODE", "0"));
  const LEND_PAYOUT_MODE = Number(env("LEND_PAYOUT_MODE", "0")); // Stream
  const LEND_PAYOUT_STREAM_BPS = Number(env("LEND_PAYOUT_STREAM_BPS", "3000"));
  const LEND_PAYOUT_COMPOUND_BPS = Number(env("LEND_PAYOUT_COMPOUND_BPS", "7000"));
  const LEND_PAYOUT_EPOCH = BigInt(env("LEND_PAYOUT_EPOCH", String(PAYOUT_EPOCH))!);
  const LEND_PAYOUT_MIN_HARVEST = BigInt(env("LEND_PAYOUT_MIN_HARVEST", String(PAYOUT_MIN_HARVEST))!);
  const LEND_PAYOUT_COMPOUND_ON_LOCK = env("LEND_PAYOUT_COMPOUND_ON_LOCK", "true") === "true";

  // No env-based adapter logic. We'll deploy two standalone adapters below with dummy params for testing.

  // Prepare deployer and nonce tracking
  const [deployerSigner] = await ethers.getSigners();
  const deployerAddress = await deployerSigner.getAddress();
  let nextNonce = await ethers.provider.getTransactionCount(deployerAddress, "latest");
  console.log("Deployer:", deployerAddress);

  // Helper to get tx options with incrementing nonce, always syncing from chain first
  const nextTxOpts = async () => {
    const chainNonce = await ethers.provider.getTransactionCount(deployerAddress, "latest");
    if (chainNonce > nextNonce) nextNonce = chainNonce; // sync forward
    const opts = { ...(await getGasOverrides(ethers)), nonce: nextNonce };
    nextNonce += 1; // use nonce, then increment
    return opts;
  };

  // 1) Deploy DXPToken
  console.log("Deploying DXPToken...");
  const DXPFactory = await ethers.getContractFactory("DXPToken");
  const dxp = await DXPFactory.deploy(await nextTxOpts());
  await dxp.waitForDeployment();
  const dxpAddr = await dxp.getAddress();
  console.log("DXPToken:", dxpAddr);

  // Resolve base asset after DXP is available; default to DXP if not provided
  const ASSET_TOKEN = ASSET_TOKEN_ENV ?? dxpAddr;
  const USDC_TOKEN = env("USDC_TOKEN", ASSET_TOKEN);

  // 2) FarmFactory no longer needed (legacy farms deprecated)

  // 3) Deploy ProtocolCore(address dxp, uint256 fallbackRatio, uint256 protocolFeeRate, uint256 reserveRatio)
  console.log("Deploying ProtocolCore...");
  const ProtocolCore = await ethers.getContractFactory("ProtocolCore");
  const core = await ProtocolCore.deploy(
    dxpAddr,
    Number(FALLBACK_BONUS_RATIO), // fallbackRatio (%)
    Number(PROTOCOL_FEE_RATE),    // protocolFeeRate (%)
    Number(RESERVE_RATIO),        // reserveRatio (%)
    await nextTxOpts()
  );
  await core.waitForDeployment();
  const coreAddr = await core.getAddress();
  console.log("ProtocolCore:", coreAddr);

  // 3.1) Deploy WhitelistRegistry (owned by deployer/protocol owner for now)
  console.log("Deploying WhitelistRegistry...");
  const WhitelistRegistryF = await ethers.getContractFactory("contracts/v3/modules/WhitelistRegistry.sol:WhitelistRegistry");
  const whitelist = await WhitelistRegistryF.deploy(deployerAddress, await nextTxOpts());
  await whitelist.waitForDeployment();
  const whitelistAddr = await whitelist.getAddress();
  console.log("WhitelistRegistry:", whitelistAddr);

  // Approve server/deployment signer (from env) as an approved farm owner
  // This helps the API/server create farms without requiring manual approval.
  try {
    const signerPk = process.env.PRIVATE_KEY
      || process.env.LOCALHOST_PRIVATE_KEY
      || process.env.BASE_SEPOLIA_PRIVATE_KEY
      || process.env.BASE_MAINNET_PRIVATE_KEY;
    if (signerPk) {
      const signerAddrForApproval = new ethers.Wallet(signerPk).address;
      console.log("Approving signer as farm owner in ProtocolCore...", signerAddrForApproval);
      await (await (core as any).setApprovedFarmOwner(signerAddrForApproval, true, await nextTxOpts())).wait();
    } else {
      console.log("No env signer private key found to auto-approve as farm owner.");
    }
  } catch (e) {
    console.warn("Warning: failed to auto-approve signer as farm owner", e);
  }

  // Transfer DXPToken ownership to ProtocolCore so it can call emitTokens/recycle
  console.log("Transferring DXPToken ownership to ProtocolCore...");
  await (await dxp.transferOwnership(coreAddr, await nextTxOpts())).wait();

  // 4) Deploy MockLiquidityManager(dxp, usdc)
  console.log("Deploying MockLiquidityManager...");
  const MockLiquidityManager = await ethers.getContractFactory("MockLiquidityManager");
  const mockLm = await MockLiquidityManager.deploy(
    dxpAddr,
    USDC_TOKEN,
    await nextTxOpts()
  );
  await mockLm.waitForDeployment();
  const mockLmAddr = await mockLm.getAddress();
  console.log("MockLiquidityManager:", mockLmAddr);

  // Wire LiquidityManager into ProtocolCore
  console.log("Wiring LiquidityManager in ProtocolCore...");
  await (await core.setLiquidityManager(mockLmAddr, await nextTxOpts())).wait();

  // 4.1) Deploy BridgingAdapter (owner = deployer; external bridge addresses set to zero for now)
  console.log("Deploying BridgingAdapter...");
  const BridgingAdapterF = await ethers.getContractFactory("contracts/libraries/BridgeAdaptor.sol:BridgingAdapter");
  const bridgingAdapter = await BridgingAdapterF.deploy(
    deployerAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    await nextTxOpts()
  );
  await bridgingAdapter.waitForDeployment();
  const bridgingAdapterAddr = await bridgingAdapter.getAddress();
  console.log("BridgingAdapter:", bridgingAdapterAddr);

  // 5) Deploy FarmFactory (v3) and wire into ProtocolCore
  console.log("Deploying v3 FarmFactory...");
  const FarmFactory = await ethers.getContractFactory("contracts/v3/factories/FarmFactory.sol:FarmFactory");
  const farmFactory = await FarmFactory.deploy(coreAddr, await nextTxOpts());
  await farmFactory.waitForDeployment();
  const farmFactoryAddr = await farmFactory.getAddress();
  console.log("FarmFactory:", farmFactoryAddr);
  console.log("Wiring FarmFactory in ProtocolCore...");
  await (await core.setFarmFactory(farmFactoryAddr, await nextTxOpts())).wait();
  console.log("Setting whitelist registry on FarmFactory...");
  await (await farmFactory.setWhitelistRegistry(whitelistAddr, await nextTxOpts())).wait();

  // 5.1) Deploy implementation contracts for clone-based modules and set them in the factory
  console.log("Deploying v3 module implementations (BaseFarm, StrategyRouter, PayoutPolicy, LockupPolicy, StakeholderRegistry)...");
  const BaseFarmImplF = await ethers.getContractFactory("contracts/v3/farm/BaseFarm.sol:BaseFarm");
  const RouterImplF = await ethers.getContractFactory("contracts/v3/strategies/StrategyRouter.sol:StrategyRouter");
  const PayoutImplF = await ethers.getContractFactory("contracts/v3/modules/PayoutPolicy.sol:PayoutPolicy");
  const LockupImplF = await ethers.getContractFactory("contracts/v3/modules/LockupPolicy.sol:LockupPolicy");
  const RegistryImplF = await ethers.getContractFactory("contracts/v3/modules/StakeholderRegistry.sol:StakeholderRegistry");

  const baseFarmImpl = await BaseFarmImplF.deploy(await nextTxOpts());
  await baseFarmImpl.waitForDeployment();
  const baseFarmImplAddr = await baseFarmImpl.getAddress();

  const routerImpl = await RouterImplF.deploy(await nextTxOpts());
  await routerImpl.waitForDeployment();
  const routerImplAddr = await routerImpl.getAddress();

  const payoutImpl = await PayoutImplF.deploy(await nextTxOpts());
  await payoutImpl.waitForDeployment();
  const payoutImplAddr = await payoutImpl.getAddress();

  const lockupImpl = await LockupImplF.deploy(await nextTxOpts());
  await lockupImpl.waitForDeployment();
  const lockupImplAddr = await lockupImpl.getAddress();

  const registryImpl = await RegistryImplF.deploy(await nextTxOpts());
  await registryImpl.waitForDeployment();
  const registryImplAddr = await registryImpl.getAddress();

  console.log("Module Implementations:", {
    BaseFarm: baseFarmImplAddr,
    StrategyRouter: routerImplAddr,
    PayoutPolicy: payoutImplAddr,
    LockupPolicy: lockupImplAddr,
    StakeholderRegistry: registryImplAddr,
  });

  console.log("Setting implementations in FarmFactory...");
  await (
    await farmFactory.setImplementations(
      baseFarmImplAddr,
      routerImplAddr,
      payoutImplAddr,
      lockupImplAddr,
      registryImplAddr,
      await nextTxOpts()
    )
  ).wait();

  // Optionally approve deployer as farm owner in core (useful for tests)
  console.log("Approving deployer as farm owner in ProtocolCore...");
  await (await core.setApprovedFarmOwner(deployerAddress, true, await nextTxOpts())).wait();

  // 5-9) Create two farms via ProtocolCore + FarmFactory (ensures registration & fee reporting wiring)
  // Common staking splits (LP/Owner/Verifier)
  const STAKE_SPLITS = { lpBps: 7000, ownerBps: 2500, verifierBps: 500 } as const;
  const LEND_SPLITS = { lpBps: 7000, ownerBps: 2500, verifierBps: 500 } as const;

  // Helper for adapter key encoding
  const toBytes32FromAddress = (addr: string) => {
    const n = BigInt(addr);
    return ("0x" + n.toString(16).padStart(64, "0")) as string;
  };
  // NOTE: This deployment script intentionally uses dummy addresses for external endpoints.
  // These are ONLY for test farms and not meant for production routing.

  // Deploy two standalone adapters (TEST ONLY: dummy external addresses)
  // 1) BluechipIndexAdapter (uses Uniswap V3 router/quoter) — dummy router/quoter addrs
  const BluechipF = await ethers.getContractFactory("contracts/v3/adapters/BluechipIndexAdapter.sol:BluechipIndexAdapter");
  const swapTarget = deployerAddress; // non-zero placeholder target (e.g., 0x proxy in real usage)
  const bluechip = await BluechipF.deploy(
    ASSET_TOKEN,
    coreAddr,
    swapTarget,
    [], // initial tokens
    await nextTxOpts()
  );
  await bluechip.waitForDeployment();
  const bluechipAddr = await bluechip.getAddress();
  console.log("BluechipIndexAdapter (TEST):", bluechipAddr);

  // Whitelist the Bluechip adapter and DEX endpoints for tests
  console.log("Whitelisting adapter and DEX endpoints in WhitelistRegistry (TEST ONLY)...");
  await (await whitelist.setAdapterWhitelist(bluechipAddr, true, await nextTxOpts())).wait();
  // Note: simplified adapter uses a generic swapTarget; DEX approval not required here.

  // 2) NodeSsvStakingAdapter — dummy SSV network and token addrs, empty operators
  const NodeSsvF = await ethers.getContractFactory("contracts/v3/adapters/NodeSsvStakingAdapter.sol:NodeSsvStakingAdapter");
  const dummySsvNetwork = deployerAddress; // non-zero placeholder
  const dummySsvToken = deployerAddress;   // non-zero placeholder
  const nodeSsv = await NodeSsvF.deploy(
    ASSET_TOKEN,
    coreAddr,
    dummySsvNetwork,
    "0x0000000000000000000000000000000000000000000000000000000000000000", // withdrawal credentials
    [], // operatorIds
    dummySsvToken,
    await nextTxOpts()
  );
  await nodeSsv.waitForDeployment();
  const nodeSsvAddr = await nodeSsv.getAddress();
  console.log("NodeSsvStakingAdapter (TEST):", nodeSsvAddr);
  // Whitelist NodeSsv adapter for staking farm allocations
  await (await whitelist.setAdapterWhitelist(nodeSsvAddr, true, await nextTxOpts())).wait();

  // Staking farm uses NodeSsvStakingAdapter (test)
  const stakeAdapterKeys = [toBytes32FromAddress(nodeSsvAddr)];
  const stakeAdapterAddrs = [nodeSsvAddr];
  const stakeAdapterBps = [10000];

  // Bluechip index farm uses BluechipIndexAdapter (test)
  const lendAdapterKeys = [toBytes32FromAddress(bluechipAddr)];
  const lendAdapterAddrs = [bluechipAddr];
  const lendAdapterBps = [10000];

  // --- Staking Farm ---
  console.log("Creating Staking farm via ProtocolCore.createApprovedFarm...");
  const stakeLockCfg = {
    enabled: STAKE_LOCK_ENABLED,
    allowEarlyExit: STAKE_LOCK_ALLOW_EARLY,
    earlyExitBps: STAKE_LOCK_EARLY_BPS,
    lockupSeconds: BigInt(STAKE_LOCK_SECONDS),
    postLockMode: STAKE_LOCK_POST_MODE,
  };
  const stakePayoutCfg = {
    mode: STAKE_PAYOUT_MODE,
    streamBps: STAKE_PAYOUT_STREAM_BPS,
    compoundBps: STAKE_PAYOUT_COMPOUND_BPS,
    epoch: STAKE_PAYOUT_EPOCH,
    minHarvestInterval: STAKE_PAYOUT_MIN_HARVEST,
    compoundLpOnLock: STAKE_PAYOUT_COMPOUND_ON_LOCK,
  };
  const stakeShareCfg = {
    transferable: true,
    transferFeeBps: 0,
    feeReceiver: ethers.ZeroAddress,
    protocolFeeReceiver: deployerAddress,
    protocolRakeBps: 1000, // 10% of owner share as protocol rake
  };
  const stakeTx = await core.createApprovedFarm(
    ASSET_TOKEN,
    STAKE_VAULT_NAME,
    STAKE_VAULT_SYMBOL,
    deployerAddress,
    STAKE_SPLITS.lpBps,
    STAKE_SPLITS.ownerBps,
    STAKE_SPLITS.verifierBps,
    stakeLockCfg,
    stakePayoutCfg,
    stakeShareCfg,
    stakeAdapterKeys,
    stakeAdapterAddrs,
    stakeAdapterBps,
    await nextTxOpts()
  );
  const stakeRcpt = await stakeTx.wait();
  // Parse FarmCreated to get actual farmId and baseFarm
  const stakeEvent = stakeRcpt.logs
    .filter((l: any) => l.address.toLowerCase() === coreAddr.toLowerCase())
    .map((l: any) => {
      try { return (core.interface as any).parseLog(l); } catch { return undefined; }
    })
    .find((ev: any) => ev && ev.name === "FarmCreated");
  const stakeFarmId = stakeEvent?.args?.farmId as bigint;
  const stakeBaseFarm = stakeEvent?.args?.baseFarm as string;
  const stakeMods = await core.farmsById(stakeFarmId);
  console.log("Staking Farm created:", { id: String(stakeFarmId), baseFarm: stakeBaseFarm });

  // Whitelist registry is wired by FarmFactory; no direct router wiring required here

  // --- Lending Farm ---
  // Adapter arrays already built above (NodeSsvStakingAdapter)
  console.log("Creating Bluechip Index farm via ProtocolCore.createApprovedFarm...");
  const lendLockCfg = {
    enabled: LEND_LOCK_ENABLED,
    allowEarlyExit: LEND_LOCK_ALLOW_EARLY,
    earlyExitBps: LEND_LOCK_EARLY_BPS,
    lockupSeconds: BigInt(LEND_LOCK_SECONDS),
    postLockMode: LEND_LOCK_POST_MODE,
  };
  const lendPayoutCfg = {
    mode: LEND_PAYOUT_MODE,
    streamBps: LEND_PAYOUT_STREAM_BPS,
    compoundBps: LEND_PAYOUT_COMPOUND_BPS,
    epoch: LEND_PAYOUT_EPOCH,
    minHarvestInterval: LEND_PAYOUT_MIN_HARVEST,
    compoundLpOnLock: LEND_PAYOUT_COMPOUND_ON_LOCK,
  };
  const lendShareCfg = {
    transferable: true,
    transferFeeBps: 0,
    feeReceiver: ethers.ZeroAddress,
    protocolFeeReceiver: deployerAddress,
    protocolRakeBps: 1000,
  };
  const lendTx = await core.createApprovedFarm(
    ASSET_TOKEN,
    LEND_VAULT_NAME,
    LEND_VAULT_SYMBOL,
    deployerAddress,
    LEND_SPLITS.lpBps,
    LEND_SPLITS.ownerBps,
    LEND_SPLITS.verifierBps,
    lendLockCfg,
    lendPayoutCfg,
    lendShareCfg,
    lendAdapterKeys,
    lendAdapterAddrs,
    lendAdapterBps,
    await nextTxOpts()
  );
  const lendRcpt = await lendTx.wait();
  const lendEvent = lendRcpt.logs
    .filter((l: any) => l.address.toLowerCase() === coreAddr.toLowerCase())
    .map((l: any) => { try { return (core.interface as any).parseLog(l); } catch { return undefined; } })
    .find((ev: any) => ev && ev.name === "FarmCreated");
  const lendFarmId = lendEvent?.args?.farmId as bigint;
  const lendBaseFarm = lendEvent?.args?.baseFarm as string;
  const lendMods = await core.farmsById(lendFarmId);
  console.log("Bluechip Index Farm created:", { id: String(lendFarmId), baseFarm: lendBaseFarm });

  // Whitelist registry is wired by FarmFactory; no direct adapter wiring required here

  // Save addresses
  const addresses = {
    network,
    deployer: deployerAddress,
    contracts: {
      DXPToken: dxpAddr,
      ProtocolCore: coreAddr,
      FarmFactory: farmFactoryAddr,
      implementations: {
        BaseFarm: baseFarmImplAddr,
        StrategyRouter: routerImplAddr,
        PayoutPolicy: payoutImplAddr,
        LockupPolicy: lockupImplAddr,
        StakeholderRegistry: registryImplAddr,
      },
      MockLiquidityManager: mockLmAddr,
      BridgingAdapter: bridgingAdapterAddr,
      WhitelistRegistry: whitelistAddr,
      vaults: {
        staking: {
          StrategyRouter: stakeMods.router,
          LockupPolicy: stakeMods.lockupPolicy,
          PayoutPolicy: stakeMods.payoutPolicy,
          StakeholderRegistry: stakeMods.stakeholderRegistry,
          BaseFarm: stakeMods.baseFarm,
          FarmId: stakeFarmId.toString(),
          Adapters: {
            keys: stakeAdapterKeys,
            addrs: stakeAdapterAddrs,
            bps: stakeAdapterBps,
          },
        },
        bluechip: {
          StrategyRouter: lendMods.router,
          LockupPolicy: lendMods.lockupPolicy,
          PayoutPolicy: lendMods.payoutPolicy,
          StakeholderRegistry: lendMods.stakeholderRegistry,
          BaseFarm: lendMods.baseFarm,
          FarmId: lendFarmId.toString(),
          Adapters: {
            keys: lendAdapterKeys,
            addrs: lendAdapterAddrs,
            bps: lendAdapterBps,
          },
        },
      },
    },
  params: {
    ASSET_TOKEN,
    USDC_TOKEN,
    FALLBACK_BONUS_RATIO: FALLBACK_BONUS_RATIO.toString(),
    PROTOCOL_FEE_RATE: PROTOCOL_FEE_RATE.toString(),
    RESERVE_RATIO: RESERVE_RATIO.toString(),
    // Staking (NodeSSV) config snapshot
    STAKE: {
      VAULT_NAME: STAKE_VAULT_NAME,
      VAULT_SYMBOL: STAKE_VAULT_SYMBOL,
      FARM_ID: stakeFarmId.toString(),
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
    // Bluechip Index config snapshot
    BLUECHIP: {
      VAULT_NAME: LEND_VAULT_NAME,
      VAULT_SYMBOL: LEND_VAULT_SYMBOL,
      FARM_ID: lendFarmId.toString(),
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
const outFile = join(outDir, `${network}.json`);
await mkdir(outDir, { recursive: true });
await writeFile(outFile, JSON.stringify(addresses, null, 2));

  console.log("Deployment complete. Addresses saved to:", outFile);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
