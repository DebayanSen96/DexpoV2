  import hre from "hardhat";
import "dotenv/config";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// Helper to read env with defaults
function env(name: string, def?: string): string | undefined {
  return process.env[name] ?? def;
}

// Attempt to enable Big Blocks for Hyperliquid via JSON-RPC (testnet/mainnet)
// Note: Big blocks are enabled automatically when using appropriate gas prices
// The evmUserModify action is not needed for RPC-based deployments
async function tryEnableHyperliquidBigBlocks(ethers: any, address: string) {
  try {
    // Allow opt-out
    if (env("HL_SKIP_BIG_BLOCK_TOGGLE", "false") === "true") return;

    console.log("Hyperliquid big blocks: using high gas price to target big blocks automatically");
    // Big blocks are automatically targeted when gasPrice is high enough
    // No manual toggle needed for RPC deployments
  } catch (e) {
    console.warn("Warning: Unable to verify Hyperliquid Big Blocks status; continuing with deployment.");
  }
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
  const MIN_SUBSCRIPTION = env("MIN_SUBSCRIPTION", "0")!; // human units of base asset

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

  // Per-vault overrides (Bluechip Index only)

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

  // If Hyperliquid testnet, try to enable Big Blocks at the account level
  if (network === "hyperliquid-testnet") {
    await tryEnableHyperliquidBigBlocks(ethers, deployerAddress);
  }

  // Helper to get tx options with incrementing nonce, always syncing from chain first
  const nextTxOpts = async () => {
    const chainNonce = await ethers.provider.getTransactionCount(deployerAddress, "latest");
    if (chainNonce > nextNonce) nextNonce = chainNonce; // sync forward
    // Hyperliquid testnet sometimes rejects EIP-1559 estimation with "intrinsic gas too low" on deployments.
    // Use explicit gasLimit and legacy gasPrice there.
    if (network === "hyperliquid-testnet") {
      // For Hyperliquid, use higher gas limit to target big blocks
      // Big blocks have 30M gas limit vs 2M for small blocks
      let baseGasPrice: bigint | undefined;
      try {
        const resp = await ethers.provider.send("bigBlockGasPrice", []);
        if (typeof resp === "string") baseGasPrice = BigInt(resp);
        else if (resp && typeof resp === "object" && typeof resp.gasPrice === "string") baseGasPrice = BigInt(resp.gasPrice);
        else if (typeof resp === "number") baseGasPrice = BigInt(resp);
      } catch {
        // Fallback to regular gas price if bigBlockGasPrice fails
        const fee = await ethers.provider.getFeeData();
        baseGasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? ethers.parseUnits("5", "gwei");
      }
      if (!baseGasPrice) {
        const fee = await ethers.provider.getFeeData();
        baseGasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? ethers.parseUnits("5", "gwei");
      }
      const ensuredBase = baseGasPrice ?? ethers.parseUnits("5", "gwei");
      const bumped = (ensuredBase * 15n) / 10n; // +50% to ensure targeting big blocks
      const gasLimit = BigInt(env("HL_DEPLOY_GAS_LIMIT", "30000000")!); // 30M for big blocks
      const opts = { nonce: nextNonce, gasLimit, gasPrice: bumped };
      nextNonce += 1;
      return opts;
    }
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

  // Mint initial supply to deployer (50,000,000 DXP) before ownership transfer
  // OnlyOwner on DXPToken is initially the deployer
  const fiftyMillion = ethers.parseUnits("50000000", 18);
  console.log("Minting 50,000,000 DXP to deployer...\n");
  // Use the same gas settings as deployment for Hyperliquid compatibility
  const mintTx = await (dxp as any).mint(deployerAddress, fiftyMillion, await nextTxOpts());
  console.log("Mint tx:", mintTx.hash);
  const mintRcpt = await mintTx.wait();
  console.log("Mint receipt status:", (mintRcpt as any)?.status);
  // Sanity checks
  const currentOwner = await (dxp as any).owner();
  console.log("DXPToken owner (pre-transfer):", currentOwner);
  const balDeployer = await (dxp as any).balanceOf(deployerAddress);
  const totalSupply = await (dxp as any).totalSupply();
  console.log(
    "Deployer balance:",
    ethers.formatUnits(balDeployer, 18),
    "DXP | Total supply:",
    ethers.formatUnits(totalSupply, 18),
    "DXP"
  );
  if (balDeployer < fiftyMillion) {
    console.warn(
      "Warning: deployer balance < 50,000,000 DXP after mint. Check gas/nonce and transaction status."
    );
  }

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

  // 3.0) Deploy FarmCreationModule and wire into ProtocolCore (shrinks Core bytecode & stack usage at create time)
  console.log("Deploying FarmCreationModule...");
  const FarmCreationModuleF = await ethers.getContractFactory("contracts/v3/core/FarmCreationModule.sol:FarmCreationModule");
  const farmCreateMod = await FarmCreationModuleF.deploy(await nextTxOpts());
  await farmCreateMod.waitForDeployment();
  const farmCreateModAddr = await farmCreateMod.getAddress();
  console.log("FarmCreationModule:", farmCreateModAddr);
  console.log("Setting FarmCreationModule in ProtocolCore...");
  await (await core.setFarmCreationModule(farmCreateModAddr, await nextTxOpts())).wait();

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

  // 4.2) Deploy MockSwapRouter (testnet oracle+swap)
  console.log("Deploying MockSwapRouter (testnet oracle+swap)...");
  const MockSwapRouterF = await ethers.getContractFactory("contracts/libraries/testnet/MockSwapRouter.sol:MockSwapRouter");
  const mockSwap = await MockSwapRouterF.deploy(
    deployerAddress, // owner
    [], // tokens
    [], // prices
    await nextTxOpts()
  );
  await mockSwap.waitForDeployment();
  const mockSwapAddr = await mockSwap.getAddress();
  console.log("MockSwapRouter:", mockSwapAddr);

  // 5) Deploy FarmFactory (v3) and wire into ProtocolCore
  console.log("Deploying v3 FarmFactory...");
  const FarmFactory = await ethers.getContractFactory("contracts/v3/factories/FarmFactory.sol:FarmFactory");
  const farmFactory = await FarmFactory.deploy(coreAddr, mockSwapAddr, await nextTxOpts());
  await farmFactory.waitForDeployment();
  const farmFactoryAddr = await farmFactory.getAddress();
  console.log("FarmFactory:", farmFactoryAddr);
  console.log("Wiring FarmFactory in ProtocolCore...");
  await (await core.setFarmFactory(farmFactoryAddr, await nextTxOpts())).wait();
  console.log("Setting whitelist registry on FarmFactory...");
  await (await farmFactory.setWhitelistRegistry(whitelistAddr, await nextTxOpts())).wait();
  console.log("Authorizing FarmCreationModule on FarmFactory...");
  await (await farmFactory.setCoreModule(farmCreateModAddr, await nextTxOpts())).wait();

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

  // 5-9) Create single Bluechip farm via ProtocolCore + FarmFactory (ensures registration & fee reporting wiring)
  // Common splits (LP/Owner/Verifier)
  const LEND_SPLITS = { lpBps: 7000, ownerBps: 2500, verifierBps: 500 } as const;

  // Helper for adapter key encoding
  const toBytes32FromAddress = (addr: string) => {
    const n = BigInt(addr);
    return ("0x" + n.toString(16).padStart(64, "0")) as string;
  };
  // NOTE: This deployment script intentionally uses dummy addresses for external endpoints.
  // These are ONLY for test farms and not meant for production routing.

  // Deploy Bluechip adapter (TEST ONLY: dummy external addresses)
  // BluechipIndexAdapter (uses a generic swapTarget)
  const BluechipF = await ethers.getContractFactory("contracts/v3/adapters/BluechipIndexAdapter.sol:BluechipIndexAdapter");
  const swapTarget = mockSwapAddr; // use MockSwapRouter as swap target and price oracle
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

  // Bluechip index farm uses BluechipIndexAdapter (test)
  const lendAdapterKeys = [toBytes32FromAddress(bluechipAddr)];
  const lendAdapterAddrs = [bluechipAddr];
  const lendAdapterBps = [10000];

  // --- Lending Farm ---
  // Adapter arrays already built above (BluechipIndexAdapter)
  console.log("Creating Bluechip Index farm via ProtocolCore...");
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
  // Choose creation path based on MIN_SUBSCRIPTION
  let lendTx;
  if (MIN_SUBSCRIPTION !== "0") {
    const erc20 = new ethers.Contract(ASSET_TOKEN, ["function decimals() view returns (uint8)"], deployerSigner);
    const decimals: number = await erc20.decimals();
    const minSubUnits = ethers.parseUnits(MIN_SUBSCRIPTION, decimals);
    // Use the WithMin overload
    lendTx = await (core as any).createApprovedFarmWithMin(
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
      minSubUnits,
      await nextTxOpts()
    );
  } else {
    // Legacy path
    lendTx = await core.createApprovedFarm(
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
  }
  const lendRcpt = await lendTx.wait();
  const lendEvent = lendRcpt.logs
    .filter((l: any) => l.address.toLowerCase() === coreAddr.toLowerCase())
    .map((l: any) => { try { return (core.interface as any).parseLog(l); } catch { return undefined; } })
    .find((ev: any) => ev && ev.name === "FarmCreated");
  const lendFarmId = lendEvent?.args?.farmId as bigint;
  const lendBaseFarm = lendEvent?.args?.baseFarm as string;
  const lendMods = await core.farmsById(lendFarmId);
  console.log("Bluechip Index Farm created:", { id: String(lendFarmId), baseFarm: lendBaseFarm });

  // Optionally set USD pricer on the farm (factory already attempts this; this is a fallback)
  try {
    const baseFarm = await ethers.getContractAt("contracts/v3/farm/BaseFarm.sol:BaseFarm", lendMods.baseFarm);
    await (await (baseFarm as any).setUsdPricer(mockSwapAddr, await nextTxOpts())).wait();
  } catch {}

  // Apply minimum subscription size if configured (>0)
  try {
    if (MIN_SUBSCRIPTION !== "0") {
      // Fetch asset decimals and parse units
      const erc20 = new ethers.Contract(ASSET_TOKEN, ["function decimals() view returns (uint8)"], deployerSigner);
      const decimals: number = await erc20.decimals();
      const minSubUnits = ethers.parseUnits(MIN_SUBSCRIPTION, decimals);
      const baseFarm = await ethers.getContractAt("contracts/v3/farm/BaseFarm.sol:BaseFarm", lendMods.baseFarm);
      await (await (baseFarm as any).setMinSubscription(minSubUnits, await nextTxOpts())).wait();
      console.log("Min subscription applied:", MIN_SUBSCRIPTION, "(units)");
    }
  } catch (e) {
    console.warn("Warning: failed to set min subscription", e);
  }

  // Whitelist registry is wired by FarmFactory; no direct adapter wiring required here

  // Save addresses (mutable; will be extended for hyperliquid section below)
  const addresses: any = {
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
      MockSwapRouter: mockSwapAddr,
      vaults: {
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
      MIN_SUBSCRIPTION,
      FALLBACK_BONUS_RATIO: FALLBACK_BONUS_RATIO.toString(),
      PROTOCOL_FEE_RATE: PROTOCOL_FEE_RATE.toString(),
      RESERVE_RATIO: RESERVE_RATIO.toString(),
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
  };

  // --- Hyperliquid Testnet: deploy Perp trading adapter + second farm ---
  if (network === "hyperliquid-testnet") {
    const USDC_TOKEN_ID = env("HL_USDC_TOKEN_ID"); // uint64 in decimal string
    const USDC_SYSTEM_ADDR = env("HL_USDC_SYSTEM_ADDR"); // 0x20.. system address for USDC token index
    if (!USDC_TOKEN || !USDC_TOKEN_ID || !USDC_SYSTEM_ADDR) {
      throw new Error("On hyperliquid-testnet, set env: USDC_TOKEN, HL_USDC_TOKEN_ID, HL_USDC_SYSTEM_ADDR");
    }

    console.log("Deploying HyperPerpAdapter (Hyperliquid Testnet)...");
    const HyperPerpF = await ethers.getContractFactory("contracts/v3/adapters/HyperPerpAdapter.sol:HyperPerpAdapter");
    const hyperPerp = await HyperPerpF.deploy(
      USDC_TOKEN,
      coreAddr,
      BigInt(USDC_TOKEN_ID),
      USDC_SYSTEM_ADDR,
      deployerAddress,
      await nextTxOpts()
    );
    await hyperPerp.waitForDeployment();
    const hyperPerpAddr = await hyperPerp.getAddress();
    console.log("HyperPerpAdapter:", hyperPerpAddr);

    // Whitelist adapter
    console.log("Whitelisting HyperPerpAdapter in WhitelistRegistry...");
    await (await whitelist.setAdapterWhitelist(hyperPerpAddr, true, await nextTxOpts())).wait();

    // Create Perp farm (USDC base), 100% allocation to HyperPerpAdapter
    const PERP_VAULT_NAME = env("PERP_VAULT_NAME", "Dexponent Hyper Perp Vault")!;
    const PERP_VAULT_SYMBOL = env("PERP_VAULT_SYMBOL", "dPERP")!;
    const perpAdapterKeys = [toBytes32FromAddress(hyperPerpAddr)];
    const perpAdapterAddrs = [hyperPerpAddr];
    const perpAdapterBps = [10000];

    const perpLockCfg = {
      enabled: false,
      allowEarlyExit: true,
      earlyExitBps: 0,
      lockupSeconds: BigInt(0),
      postLockMode: 0,
    };
    const perpPayoutCfg = {
      mode: 0,
      streamBps: 3000,
      compoundBps: 7000,
      epoch: BigInt(86400),
      minHarvestInterval: BigInt(300),
      compoundLpOnLock: true,
    };
    const perpShareCfg = {
      transferable: true,
      transferFeeBps: 0,
      feeReceiver: ethers.ZeroAddress,
      protocolFeeReceiver: deployerAddress,
      protocolRakeBps: 1000,
    };

    console.log("Creating Hyper Perp farm via ProtocolCore...");
    const perpTx = await core.createApprovedFarm(
      USDC_TOKEN,
      PERP_VAULT_NAME,
      PERP_VAULT_SYMBOL,
      deployerAddress,
      LEND_SPLITS.lpBps,
      LEND_SPLITS.ownerBps,
      LEND_SPLITS.verifierBps,
      perpLockCfg,
      perpPayoutCfg,
      perpShareCfg,
      perpAdapterKeys,
      perpAdapterAddrs,
      perpAdapterBps,
      await nextTxOpts()
    );
    const perpRcpt = await perpTx.wait();
    const perpEvent = perpRcpt.logs
      .filter((l: any) => l.address.toLowerCase() === coreAddr.toLowerCase())
      .map((l: any) => { try { return (core.interface as any).parseLog(l); } catch { return undefined; } })
      .find((ev: any) => ev && ev.name === "FarmCreated");
    const perpFarmId = perpEvent?.args?.farmId as bigint;
    const perpMods = await core.farmsById(perpFarmId);
    console.log("Hyper Perp Farm created:", { id: String(perpFarmId), baseFarm: perpMods.baseFarm });

    addresses.contracts.vaults.perp = {
      StrategyRouter: perpMods.router,
      LockupPolicy: perpMods.lockupPolicy,
      PayoutPolicy: perpMods.payoutPolicy,
      StakeholderRegistry: perpMods.stakeholderRegistry,
      BaseFarm: perpMods.baseFarm,
      FarmId: perpFarmId.toString(),
      Adapters: {
        keys: perpAdapterKeys,
        addrs: perpAdapterAddrs,
        bps: perpAdapterBps,
      },
    };

    addresses.params.PERP = {
      VAULT_NAME: PERP_VAULT_NAME,
      VAULT_SYMBOL: PERP_VAULT_SYMBOL,
      USDC_TOKEN_ID,
      USDC_SYSTEM_ADDR,
      ADAPTER: hyperPerpAddr,
    };
  }

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
