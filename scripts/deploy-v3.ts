import hre from "hardhat";
import "dotenv/config";
import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";

// Helper to read env with defaults
function env(name: string, def?: string): string | undefined {
  return process.env[name] ?? def;
}

// Small sleep helper
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Deployment manifest interface
interface DeploymentManifest {
  network: string;
  deployer: string;
  lastUpdated: string;
  steps: {
    [key: string]: {
      deployed: boolean;
      address?: string | null;
      txHash?: string | null;
      farmId?: string | null;
      baseFarm?: string | null;
      addresses?: { [key: string]: string };
      txHashes?: string[];
    };
  };
}

// Load deployment manifest
async function loadManifest(network: string): Promise<DeploymentManifest> {
  try {
    const manifestPath = join("scripts", "deploy-manifest.json");
    const manifestContent = await readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestContent);

    // Return existing manifest for the network or create a new one
    if (manifest.network === network) {
      return manifest;
    }
  } catch (error) {
    console.log("No existing manifest found, creating new one...");
  }

  // Create new manifest
  return {
    network,
    deployer: "0x0000000000000000000000000000000000000000",
    lastUpdated: new Date().toISOString(),
    steps: {
      DXPToken: { deployed: false, address: null, txHash: null },
      ProtocolCore: { deployed: false, address: null, txHash: null },
      WhitelistRegistry: { deployed: false, address: null, txHash: null },
      signerApproved: { deployed: false, txHash: null },
      DXPTokenOwnershipTransferred: { deployed: false, txHash: null },
      MockLiquidityManager: { deployed: false, address: null, txHash: null },
      LiquidityManagerWired: { deployed: false, txHash: null },
      BridgingAdapter: { deployed: false, address: null, txHash: null },
      FarmFactory: { deployed: false, address: null, txHash: null },
      FarmFactoryWired: { deployed: false, txHash: null },
      WhitelistRegistrySet: { deployed: false, txHash: null },
      ModuleImplementations: { deployed: false, addresses: {}, txHashes: [] },
      ImplementationsSet: { deployed: false, txHash: null },
      FarmCreationModule: { deployed: false, address: null, txHash: null },
      FarmCreationModuleWired: { deployed: false, txHash: null },
      FarmCreationModuleAuthorized: { deployed: false, txHash: null },
      DeployerApproved: { deployed: false, txHash: null },
      BluechipIndexAdapter: { deployed: false, address: null, txHash: null },
      AdapterWhitelisted: { deployed: false, txHash: null },
      BluechipIndexFarm: { deployed: false, farmId: null, baseFarm: null, txHash: null },
      // Hyperliquid testnet specific
      HyperPerpAdapter: { deployed: false, address: null, txHash: null },
      HyperPerpAdapterWhitelisted: { deployed: false, txHash: null },
      HyperPerpFarm: { deployed: false, farmId: null, baseFarm: null, txHash: null }
    }
  };
}

// Save deployment manifest
async function saveManifest(manifest: DeploymentManifest): Promise<void> {
  const manifestPath = join("scripts", "deploy-manifest.json");
  manifest.lastUpdated = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

// Ensure a step key exists in manifest with a default shape
function ensureStep(manifest: DeploymentManifest, key: string, def: any) {
  if (!(manifest.steps as any)[key]) {
    (manifest.steps as any)[key] = def;
  }
}

// Try to hydrate manifest steps from deployments/{network}/{network}.json if present
async function backfillFromDeployments(network: string, manifest: DeploymentManifest) {
  try {
    const depPath = join("deployments", network, `${network}.json`);
    const raw = await readFile(depPath, "utf-8");
    const dep = JSON.parse(raw);
    const contracts = dep.contracts || {};

    const assignIf = (stepKey: string, addr: string | undefined) => {
      if (addr && !(manifest.steps as any)[stepKey]?.deployed) {
        ensureStep(manifest, stepKey, { deployed: false, address: null, txHash: null });
        (manifest.steps as any)[stepKey].deployed = true;
        (manifest.steps as any)[stepKey].address = addr;
      }
    };

    assignIf("DXPToken", contracts.DXPToken);
    assignIf("ProtocolCore", contracts.ProtocolCore);
    assignIf("WhitelistRegistry", contracts.WhitelistRegistry);
    assignIf("MockLiquidityManager", contracts.MockLiquidityManager);
    assignIf("BridgingAdapter", contracts.BridgingAdapter);
    assignIf("FarmFactory", contracts.FarmFactory);

    // Mark wiring steps as done if addresses exist and on-chain will be checked later
    if (contracts.FarmFactory) ensureStep(manifest, "FarmFactoryWired", { deployed: true, txHash: null });
  } catch {}
}

async function main() {
  const network: string = ((hre as any).network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat";
  const { ethers } = hre as any;

  console.log("Network:", network);

  // Load deployment manifest
  const manifest = await loadManifest(network);
  console.log("Loaded deployment manifest, last updated:", manifest.lastUpdated);

  // Hydrate manifest from deployments/{network}.json if present
  await backfillFromDeployments(network, manifest);
  // Ensure missing step keys exist (for manifests created before new steps were added)
  ensureStep(manifest, "BridgingAdapter", { deployed: false, address: null, txHash: null });
  ensureStep(manifest, "LiquidityManagerWired", { deployed: false, txHash: null });
  // New vault-based deployment steps
  ensureStep(manifest, "VaultFactory", { deployed: false, address: null, txHash: null });
  ensureStep(manifest, "VaultFactoryWired", { deployed: false, txHash: null });
  ensureStep(manifest, "VaultCreated", { deployed: false, address: null, txHash: null, farmId: null });
  // HyperPerp optional steps
  ensureStep(manifest, "HyperPerpAdapter", { deployed: false, address: null, txHash: null });
  ensureStep(manifest, "HyperPerpAdapterWhitelisted", { deployed: false, txHash: null });
  ensureStep(manifest, "HyperPerpFarm", { deployed: false, farmId: null, baseFarm: null, txHash: null });
  // Optionally force redeploy of HyperPerp stack on hyperliquid-testnet
  if (network === "hyperliquid-testnet" && env("FORCE_REDEPLOY_HYPERPERP", "false") === "true") {
    console.log("FORCE_REDEPLOY_HYPERPERP enabled: resetting HyperPerp steps in manifest...");
    manifest.steps.HyperPerpAdapter = { deployed: false, address: null, txHash: null } as any;
    manifest.steps.HyperPerpAdapterWhitelisted = { deployed: false, txHash: null } as any;
    manifest.steps.HyperPerpFarm = { deployed: false, farmId: null, baseFarm: null, txHash: null } as any;
  }
  await saveManifest(manifest);

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

  // Update manifest with deployer
  manifest.deployer = deployerAddress;
  await saveManifest(manifest);

  // Helper to get tx options with incrementing nonce, always syncing from chain first
  const nextTxOpts = async () => {
    const chainNonce = await ethers.provider.getTransactionCount(deployerAddress, "latest");
    if (chainNonce > nextNonce) nextNonce = chainNonce; // sync forward
    const opts = { ...(await getGasOverrides(ethers)), nonce: nextNonce };
    nextNonce += 1; // use nonce, then increment
    return opts;
  };

  // 1) Deploy DXPToken
  let dxpAddr: string;
  let dxp: any;
  if (!manifest.steps.DXPToken.deployed) {
    console.log("Deploying DXPToken...");
    const DXPFactory = await ethers.getContractFactory("DXPToken");
    dxp = await DXPFactory.deploy(await nextTxOpts());
    await dxp.waitForDeployment();
    dxpAddr = await dxp.getAddress();
    console.log("DXPToken:", dxpAddr);

    // Mint initial supply to deployer (100,000,000 DXP) with retry to avoid immediate RPC lag
    {
      let success = false;
      for (let i = 0; i < 5 && !success; i++) {
        try {
          const decimals = await dxp.decimals();
          const mintAmt = (ethers as any).parseUnits("100000000", decimals);
          console.log("Minting 100,000,000 DXP to deployer...", deployerAddress);
          const mintTx = await dxp.mint(deployerAddress, mintAmt, await nextTxOpts());
          await mintTx.wait();
          success = true;
        } catch (e) {
          if (i === 4) {
            console.warn("Warning: initial DXP mint failed after retries", e);
          } else {
            await sleep(2000);
          }
        }
      }
    }

    // Update manifest
    manifest.steps.DXPToken.deployed = true;
    manifest.steps.DXPToken.address = dxpAddr;
    manifest.steps.DXPToken.txHash = dxp.deploymentTransaction()?.hash || null;
    await saveManifest(manifest);
  } else {
    console.log("DXPToken already deployed, skipping...");
    dxpAddr = manifest.steps.DXPToken.address!;
    // Get the existing contract instance for later use
    dxp = await ethers.getContractAt("DXPToken", dxpAddr);
  }

  // Resolve base asset after DXP is available; default to DXP if not provided
  const ASSET_TOKEN = ASSET_TOKEN_ENV ?? dxpAddr;
  const USDC_TOKEN = env("USDC_TOKEN", ASSET_TOKEN);

  // 2) Legacy FarmFactory not used in vault-based flow

  // 3) Deploy ProtocolCore(address dxp, uint256 fallbackRatio, uint256 protocolFeeRate, uint256 reserveRatio)
  let coreAddr: string;
  let core: any;
  if (!manifest.steps.ProtocolCore.deployed) {
    console.log("Deploying ProtocolCore...");
    const ProtocolCore = await ethers.getContractFactory("ProtocolCore");
    core = await ProtocolCore.deploy(
      dxpAddr,
      Number(FALLBACK_BONUS_RATIO), // fallbackRatio (%)
      Number(PROTOCOL_FEE_RATE),    // protocolFeeRate (%)
      Number(RESERVE_RATIO),        // reserveRatio (%)
      await nextTxOpts()
    );
    await core.waitForDeployment();
    coreAddr = await core.getAddress();
    console.log("ProtocolCore:", coreAddr);

    // Update manifest
    manifest.steps.ProtocolCore.deployed = true;
    manifest.steps.ProtocolCore.address = coreAddr;
    manifest.steps.ProtocolCore.txHash = core.deploymentTransaction()?.hash || null;
    await saveManifest(manifest);
  } else {
    console.log("ProtocolCore already deployed, skipping...");
    coreAddr = manifest.steps.ProtocolCore.address!;
    core = await ethers.getContractAt("ProtocolCore", coreAddr);
  }

  // 3.1) WhitelistRegistry not used in minimal vault flow (artifact absent). Use zero placeholder.
  const whitelistAddr: string = (ethers as any).ZeroAddress;
  if (!manifest.steps.WhitelistRegistry.deployed) {
    manifest.steps.WhitelistRegistry.deployed = true;
    manifest.steps.WhitelistRegistry.address = whitelistAddr;
    await saveManifest(manifest);
  }

  // Approve server/deployment signer (from env) as an approved farm owner (idempotent)
  if (!manifest.steps.signerApproved.deployed) {
    try {
      const signerPk = process.env.PRIVATE_KEY
        || process.env.LOCALHOST_PRIVATE_KEY
        || process.env.BASE_SEPOLIA_PRIVATE_KEY
        || process.env.BASE_MAINNET_PRIVATE_KEY;
      if (signerPk) {
        const signerAddrForApproval = new ethers.Wallet(signerPk).address;
        console.log("Approving signer as farm owner in ProtocolCore...", signerAddrForApproval);
        const tx = await (core as any).setApprovedFarmOwner(signerAddrForApproval, true, await nextTxOpts());
        await tx.wait();
        manifest.steps.signerApproved.deployed = true;
        manifest.steps.signerApproved.txHash = tx.hash;
        await saveManifest(manifest);
      } else {
        console.log("No env signer private key found to auto-approve as farm owner.");
        // Mark as done to avoid retrying every run
        manifest.steps.signerApproved.deployed = true;
        await saveManifest(manifest);
      }
    } catch (e) {
      console.warn("Warning: failed to auto-approve signer as farm owner", e);
    }
  } else {
    console.log("Signer already approved, skipping...");
  }

  // Transfer DXPToken ownership to ProtocolCore so it can call emitTokens/recycle (idempotent)
  if (!manifest.steps.DXPTokenOwnershipTransferred.deployed) {
    try {
      // If already owned by core, skip
      const currentOwner = await (dxp as any).owner();
      if (currentOwner.toLowerCase() === coreAddr.toLowerCase()) {
        console.log("DXPToken already owned by ProtocolCore, skipping ownership transfer.");
        manifest.steps.DXPTokenOwnershipTransferred.deployed = true;
        await saveManifest(manifest);
      } else {
        console.log("Transferring DXPToken ownership to ProtocolCore...");
        const tx = await dxp.transferOwnership(coreAddr, await nextTxOpts());
        await tx.wait();
        manifest.steps.DXPTokenOwnershipTransferred.deployed = true;
        manifest.steps.DXPTokenOwnershipTransferred.txHash = tx.hash;
        await saveManifest(manifest);
      }
    } catch (e) {
      console.warn("Warning: DXPToken ownership transfer failed (might not be owner anymore)", e);
    }
  } else {
    console.log("DXPToken ownership already transferred, skipping...");
  }

  // 4) Deploy MockLiquidityManager(dxp, usdc) (idempotent)
  let mockLmAddr: string;
  let mockLm: any;
  if (!manifest.steps.MockLiquidityManager.deployed) {
    console.log("Deploying MockLiquidityManager...");
    const MockLiquidityManager = await ethers.getContractFactory("MockLiquidityManager");
    mockLm = await MockLiquidityManager.deploy(
      dxpAddr,
      USDC_TOKEN,
      await nextTxOpts()
    );
    await mockLm.waitForDeployment();
    mockLmAddr = await mockLm.getAddress();
    console.log("MockLiquidityManager:", mockLmAddr);
    manifest.steps.MockLiquidityManager.deployed = true;
    manifest.steps.MockLiquidityManager.address = mockLmAddr;
    manifest.steps.MockLiquidityManager.txHash = mockLm.deploymentTransaction()?.hash || null;
    await saveManifest(manifest);
  } else {
    console.log("MockLiquidityManager already deployed, skipping...");
    mockLmAddr = manifest.steps.MockLiquidityManager.address!;
    mockLm = await ethers.getContractAt("MockLiquidityManager", mockLmAddr);
  }

  // Wire LiquidityManager into ProtocolCore (idempotent)
  if (!manifest.steps.LiquidityManagerWired.deployed) {
    const currentLm = await core.liquidityManager();
    if (currentLm && currentLm.toLowerCase() === mockLmAddr.toLowerCase()) {
      console.log("LiquidityManager already set on ProtocolCore, skipping wiring.");
      manifest.steps.LiquidityManagerWired.deployed = true;
      await saveManifest(manifest);
    } else {
      console.log("Wiring LiquidityManager in ProtocolCore...");
      const tx = await core.setLiquidityManager(mockLmAddr, await nextTxOpts());
      await tx.wait();
      manifest.steps.LiquidityManagerWired.deployed = true;
      manifest.steps.LiquidityManagerWired.txHash = tx.hash;
      await saveManifest(manifest);
    }
  } else {
    console.log("LiquidityManager already wired, skipping...");
  }

  // 4.1) Deploy BridgingAdapter (optional; stubbed) (idempotent)
  let bridgingAdapterAddr: string;
  if (!manifest.steps.BridgingAdapter.deployed) {
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
    bridgingAdapterAddr = await bridgingAdapter.getAddress();
    console.log("BridgingAdapter:", bridgingAdapterAddr);
    manifest.steps.BridgingAdapter.deployed = true;
    manifest.steps.BridgingAdapter.address = bridgingAdapterAddr;
    manifest.steps.BridgingAdapter.txHash = bridgingAdapter.deploymentTransaction()?.hash || null;
    await saveManifest(manifest);
  } else {
    console.log("BridgingAdapter already deployed, skipping...");
    bridgingAdapterAddr = manifest.steps.BridgingAdapter.address!;
  }

  // 5) Deploy VaultFactory and wire into ProtocolCore
  let vaultFactoryAddr: string;
  let vaultFactory: any;
  if (!manifest.steps.VaultFactory.deployed) {
    console.log("Deploying VaultFactory...");
    const VaultFactoryF = await ethers.getContractFactory("contracts/v3/factories/VaultFactory.sol:VaultFactory");
    vaultFactory = await VaultFactoryF.deploy(coreAddr, await nextTxOpts());
    await vaultFactory.waitForDeployment();
    vaultFactoryAddr = await vaultFactory.getAddress();
    console.log("VaultFactory:", vaultFactoryAddr);
    manifest.steps.VaultFactory.deployed = true;
    manifest.steps.VaultFactory.address = vaultFactoryAddr;
    manifest.steps.VaultFactory.txHash = vaultFactory.deploymentTransaction()?.hash || null;
    await saveManifest(manifest);
  } else {
    console.log("VaultFactory already deployed, skipping...");
    vaultFactoryAddr = manifest.steps.VaultFactory.address!;
    vaultFactory = await ethers.getContractAt("contracts/v3/factories/VaultFactory.sol:VaultFactory", vaultFactoryAddr);
  }

  if (!manifest.steps.VaultFactoryWired.deployed) {
    console.log("Wiring VaultFactory in ProtocolCore...");
    try {
      const tx = await core.setVaultFactory(vaultFactoryAddr, await nextTxOpts());
      await tx.wait();
      manifest.steps.VaultFactoryWired.deployed = true;
      manifest.steps.VaultFactoryWired.txHash = tx.hash;
      await saveManifest(manifest);
    } catch (e) {
      console.warn("setVaultFactory failed on existing ProtocolCore. Deploying a fresh ProtocolCore for vault flow...");
      const ProtocolCore = await ethers.getContractFactory("ProtocolCore");
      const newCore = await ProtocolCore.deploy(
        dxpAddr,
        Number(FALLBACK_BONUS_RATIO),
        Number(PROTOCOL_FEE_RATE),
        Number(RESERVE_RATIO),
        await nextTxOpts()
      );
      await newCore.waitForDeployment();
      const newCoreAddr = await newCore.getAddress();
      console.log("New ProtocolCore:", newCoreAddr);
      // Wire LM (optional) and VaultFactory
      try { const tx1 = await newCore.setLiquidityManager(mockLmAddr, await nextTxOpts()); await tx1.wait(); } catch {}
      const tx2 = await newCore.setVaultFactory(vaultFactoryAddr, await nextTxOpts());
      await tx2.wait();
      core = newCore;
      coreAddr = newCoreAddr;
      manifest.steps.ProtocolCore.deployed = true;
      manifest.steps.ProtocolCore.address = newCoreAddr;
      manifest.steps.ProtocolCore.txHash = newCore.deploymentTransaction()?.hash || null;
      manifest.steps.VaultFactoryWired.deployed = true;
      manifest.steps.VaultFactoryWired.txHash = tx2.hash;
      await saveManifest(manifest);
    }
  }

  // Allow deployer to call createVault via VaultFactory coreModule
  try { const modTx = await vaultFactory.setCoreModule(deployerAddress, await nextTxOpts()); await modTx.wait(); } catch {}

  // Approve deployer as farm owner in core (useful for tests)
  if (!manifest.steps.DeployerApproved.deployed) {
    console.log("Approving deployer as farm owner in ProtocolCore...");
    const tx = await core.setApprovedFarmOwner(deployerAddress, true, await nextTxOpts());
    await tx.wait();

    // Update manifest
    manifest.steps.DeployerApproved.deployed = true;
    manifest.steps.DeployerApproved.txHash = tx.hash;
    await saveManifest(manifest);
  }

  // Create a single minimal Vault via VaultFactory

  // NOTE: Adapters/routers are not part of the new minimal vault flow.

  // No adapters to deploy/whitelist for minimal vault

  // --- Create Vault ---
  let lendFarmId: bigint = LEND_FARM_ID;
  if (!manifest.steps.VaultCreated.deployed) {
    console.log("Creating vault via VaultFactory.createVault...");
    const tx = await vaultFactory.createVault(
      ASSET_TOKEN,
      LEND_VAULT_NAME,
      LEND_VAULT_SYMBOL,
      coreAddr,
      lendFarmId,
      await nextTxOpts()
    );
    const rcpt = await tx.wait();
    // Find VaultCreated event
    const vaultEvent = rcpt.logs
      .map((l: any) => { try { return (vaultFactory.interface as any).parseLog(l); } catch { return undefined; } })
      .find((ev: any) => ev && ev.name === "VaultCreated");
    const vaultAddr = vaultEvent?.args?.vault as string;
    console.log("Vault created:", vaultAddr, "farmId=", String(lendFarmId));
    manifest.steps.VaultCreated.deployed = true;
    manifest.steps.VaultCreated.address = vaultAddr;
    manifest.steps.VaultCreated.txHash = tx.hash;
    manifest.steps.VaultCreated.farmId = String(lendFarmId);
    await saveManifest(manifest);
  } else {
    console.log("Vault already created, skipping...");
  }

  // No whitelist registry usage in minimal flow

  // Hyperliquid testnet: deploy HyperPerp adapter and create a second farm
  if (network === "hyperliquid-testnet") {
    // Required env vars:
    // - HYPER_USDC_TOKEN_ID (uint64 as string)
    // - HYPER_USDC_SYSTEM_ADDRESS (address)
    const HYPER_USDC_TOKEN_ID = BigInt(env("HYPER_USDC_TOKEN_ID", "1")!); // default 1 for local tests
    const HYPER_USDC_SYSTEM_ADDRESS = env("HYPER_USDC_SYSTEM_ADDRESS", deployerAddress)!; // placeholder
    const HYPER_USDC_BASE_ASSET = env("HYPER_USDC_BASE_ASSET", "0xd9CBEC81df392A88AEff575E962d149d57F4d6bc")!; // allow env override, default to hardcoded
    if (!ethers.isAddress(HYPER_USDC_BASE_ASSET)) {
      throw new Error(`Invalid HYPER_USDC_BASE_ASSET address: ${HYPER_USDC_BASE_ASSET}. Expected a 20-byte hex address (0x + 40 hex chars).`);
    }

    // Deploy HyperPerpAdapter
    let hyperPerpAddr: string;
    if (!manifest.steps.HyperPerpAdapter.deployed) {
      console.log("Deploying HyperPerpAdapter (Hyperliquid)...");
      const HyperPerpF = await ethers.getContractFactory("contracts/v3/adapters/HyperPerpAdapter.sol:HyperPerpAdapter");
      const hyperPerp = await HyperPerpF.deploy(
        HYPER_USDC_BASE_ASSET,     // asset (USDC, hyperliquid testnet)
        coreAddr,                  // protocolCore
        Number(HYPER_USDC_TOKEN_ID), // uint64 token id (ethers will cast down)
        HYPER_USDC_SYSTEM_ADDRESS, // system address on Core
        deployerAddress,           // initial owner (farm owner later gets ownership of router, adapter remains owned by deployer)
        await nextTxOpts()
      );
      await hyperPerp.waitForDeployment();
      hyperPerpAddr = await hyperPerp.getAddress();
      console.log("HyperPerpAdapter:", hyperPerpAddr);
      manifest.steps.HyperPerpAdapter.deployed = true;
      manifest.steps.HyperPerpAdapter.address = hyperPerpAddr;
      manifest.steps.HyperPerpAdapter.txHash = hyperPerp.deploymentTransaction()?.hash || null;
      await saveManifest(manifest);
    } else {
      console.log("HyperPerpAdapter already deployed, skipping...");
      hyperPerpAddr = manifest.steps.HyperPerpAdapter.address!;
    }

    // Skipping whitelist and legacy farm creation on hyperliquid-testnet in minimal vault flow
  }

  // Save addresses
  const addresses = {
    network,
    deployer: deployerAddress,
    contracts: {
      DXPToken: dxpAddr,
      ProtocolCore: coreAddr,
      VaultFactory: vaultFactoryAddr,
      MockLiquidityManager: mockLmAddr,
      BridgingAdapter: bridgingAdapterAddr,
      WhitelistRegistry: whitelistAddr,
      vaults: {
        bluechip: {
          Vault: manifest.steps.VaultCreated.address,
          FarmId: String(lendFarmId),
        },
      },
    },
  params: {
    ASSET_TOKEN,
    USDC_TOKEN,
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