import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type TokenConfig = {
  name: string;
  symbol: string;
  decimals: number;
  address: string;
  priceUsd?: number;
  initialSupplyNative?: string;
};

type DeploymentState = {
  deployer?: string;
  dxpToken?: string;
  protocolCore?: string;
  oracle?: string;
  feeCollector?: string;
  moduleRegistry?: string;
  swapHub?: string;
  mockSwapRouter?: string;
  mockSwapAdapter?: string;
  lendingHub?: string;
  mockLendingAdapter?: string;
  indexSwapImplementation?: string;
  indexSwapFactory?: string;
  adapterIds?: {
    mockSwap?: string;
    mockLending?: string;
  };
  testVault?: {
    safe: string;
    indexSwap: string;
  };
  fundedRouterTokens?: string[];
  completedSteps?: Record<string, boolean>;
  timestamp?: string;
};

const TEST_TOKENS_PATH = path.join(__dirname, "..", "..", "contracts", "v3", "test", "base-sepolia_test_tokens.json");
const DEFAULT_PRICE_E18 = 10n ** 18n;
const MOCK_SWAP_ADAPTER_ID = ethers.keccak256(ethers.toUtf8Bytes("MOCK_SWAP"));
const MOCK_LENDING_ADAPTER_ID = ethers.keccak256(ethers.toUtf8Bytes("MOCK_LENDING"));

function loadTestTokens(): TokenConfig[] {
  const raw = JSON.parse(fs.readFileSync(TEST_TOKENS_PATH, "utf8"));
  return raw.tokens as TokenConfig[];
}

function normalizePrice(priceUsd?: number): bigint {
  if (!priceUsd || priceUsd <= 0) return DEFAULT_PRICE_E18;
  return ethers.parseUnits(priceUsd.toString(), 18);
}

function uniqueTokens(tokens: TokenConfig[]): TokenConfig[] {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = token.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickPortfolio(tokens: TokenConfig[]): Array<{ token: string; weightBps: number }> {
  const stable = tokens.find((t) => t.symbol.toUpperCase() === "USDC") ?? tokens[0];
  const growth = tokens.find((t) => t.symbol.toUpperCase() === "WETH") ?? tokens.find((t) => t.address !== stable.address) ?? tokens[0];
  if (stable.address.toLowerCase() === growth.address.toLowerCase()) {
    return [{ token: stable.address, weightBps: 10000 }];
  }
  return [
    { token: stable.address, weightBps: 5000 },
    { token: growth.address, weightBps: 5000 }
  ];
}

function getStatePath(): string {
  const deploymentsDir = path.join(__dirname, "..", "deployments", "v3-latest");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  return path.join(deploymentsDir, `${network.name}.json`);
}

function loadState(): DeploymentState {
  const statePath = getStatePath();
  if (fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  }
  return {};
}

function saveState(state: DeploymentState): void {
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

function markStep(state: DeploymentState, step: string): void {
  if (!state.completedSteps) state.completedSteps = {};
  state.completedSteps[step] = true;
  saveState(state);
}

async function waitForNonce(deployer: any, expectedNonce: number, maxRetries = 10): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const currentNonce = await deployer.getNonce();
    if (currentNonce >= expectedNonce) return;
    console.log(`  ⏳ Waiting for nonce ${expectedNonce} (current: ${currentNonce})...`);
    await delay(2000);
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTxAndWait(deployer: any, label: string, txBuilder: (nonce?: number) => Promise<any>): Promise<any> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tx = await txBuilder();
      console.log(`  -> ${label} tx: ${tx.hash}`);
      const receipt = await tx.wait(1, 180000);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`${label} failed: ${tx.hash}`);
      }
      return receipt;
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || String(err);
      if (msg.includes("nonce too low") && attempt < 3) {
        console.log(`  ⚠ ${label} nonce issue, retrying (attempt ${attempt}/3)...`);
        await delay(3000);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after 3 attempts`);
}

async function deployContract(
  deployer: any,
  name: string,
  factoryPath: string,
  args: any[],
  state: DeploymentState,
  stateKey: keyof DeploymentState
): Promise<string> {
  if (state[stateKey]) {
    console.log(`  ✓ ${name} already deployed: ${state[stateKey]}`);
    return state[stateKey] as string;
  }

  const latestNonce = await deployer.getNonce("latest");
  const pendingNonce = await deployer.getNonce("pending");
  const forcedNonce = process.env.FORCE_NONCE ? Number(process.env.FORCE_NONCE) : null;
  const nonceBefore = forcedNonce ?? latestNonce;
  console.log(`  Deploying ${name}... (nonce: ${nonceBefore}, latest: ${latestNonce}, pending: ${pendingNonce})`);
  if (pendingNonce > latestNonce) {
    console.log(`  ⚠ Pending nonce gap detected (${pendingNonce - latestNonce}). Using latest nonce to avoid RPC pending nonce drift.`);
  }

  const Factory = await ethers.getContractFactory(factoryPath);
  let contract: any;
  let address = "";
  let lastErr: any;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const attemptNonce = attempt === 1 ? nonceBefore : await deployer.getNonce("latest");
      contract = await Factory.deploy(...args, { nonce: attemptNonce });
      const deploymentTx = contract.deploymentTransaction();
      if (!deploymentTx) {
        throw new Error(`Deployment tx missing for ${name}`);
      }
      console.log(`  ↳ tx: ${deploymentTx.hash} (attempt ${attempt}/3, nonce ${attemptNonce})`);
      const receipt = await deploymentTx.wait(1, 180000);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`${name} deployment failed or timed out: ${deploymentTx.hash}`);
      }
      address = await contract.getAddress();
      break;
    } catch (err: any) {
      lastErr = err;
      const msg = err?.shortMessage || err?.message || String(err);
      console.log(`  ⚠ ${name} deploy attempt ${attempt} failed: ${msg}`);
      if (attempt < 3) {
        console.log("  ↻ Retrying deployment...");
        await delay(3000);
      }
    }
  }

  if (!address) {
    throw lastErr || new Error(`${name} deployment failed after retries`);
  }

  console.log(`  ✅ ${name}: ${address}`);
  (state as any)[stateKey] = address;
  saveState(state);
  await waitForNonce(deployer, nonceBefore + 1);
  await delay(1500);
  return address;
}

async function tryFundRouter(deployer: any, routerAddress: string, tokens: TokenConfig[], state: DeploymentState) {
  const MINT_AMOUNT = 10_000n;
  const funded = new Set((state.fundedRouterTokens || []).map((t) => t.toLowerCase()));
  const nm = new ethers.NonceManager(deployer);
  for (const token of tokens) {
    if (funded.has(token.address.toLowerCase())) continue;
    const erc20 = new ethers.Contract(token.address, ["function mint(address,uint256) external"], nm);
    const amount = MINT_AMOUNT * 10n ** BigInt(token.decimals);
    try {
      const tx = await erc20.mint(routerAddress, amount);
      await tx.wait(1);
      funded.add(token.address.toLowerCase());
      state.fundedRouterTokens = Array.from(funded);
      saveState(state);
      console.log(`  ✅ Minted ${MINT_AMOUNT} ${token.symbol} to router`);
    } catch (e: any) {
      console.log(`  ⚠ ${token.symbol} mint failed: ${e.message?.slice(0, 60)}`);
    }
  }
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("DEXPONENT PROTOCOL - TESTNET DEPLOYMENT");
  console.log("=".repeat(70));
  console.log("Network:", network.name);
  console.log("Timestamp:", new Date().toISOString());

  const [deployer] = await ethers.getSigners();
  console.log("\nDeployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const tokens = uniqueTokens(loadTestTokens());
  const tokenAddresses = tokens.map((token) => token.address);
  const tokenPrices = tokens.map((token) => normalizePrice(token.priceUsd));
  const portfolio = pickPortfolio(tokens);

  let state = loadState();
  state.deployer = deployer.address;
  state.timestamp = new Date().toISOString();
  state.adapterIds = state.adapterIds || {};
  saveState(state);

  console.log("\n[1/11] DXP Token");
  const dxpToken = await deployContract(deployer, "DXPToken", "contracts/DXPToken.sol:DXPToken", [], state, "dxpToken");

  console.log("\n[2/11] Protocol Core");
  const protocolCore = await deployContract(deployer, "ProtocolCore", "contracts/ProtocolCore.sol:ProtocolCore", [dxpToken, 100, 10, 20], state, "protocolCore");

  console.log("\n[3/11] Mock Oracle");
  const oracle = await deployContract(deployer, "MockOracle", "contracts/v3/test/MockOracle.sol:MockOracle", [], state, "oracle");
  if (!state.completedSteps?.oracleConfigured) {
    const nm = new ethers.NonceManager(deployer);
    const mockOracle = new ethers.Contract(oracle, ["function setPrice(address,uint256) external"], nm);
    for (const token of tokens) {
      try {
        const tx = await mockOracle.setPrice(token.address, normalizePrice(token.priceUsd));
        await tx.wait(1);
        console.log(`  -> oracle.setPrice ${token.symbol} ✓`);
      } catch (e: any) {
        console.log(`  ⚠ oracle.setPrice ${token.symbol}: ${e.message?.slice(0, 60)}`);
      }
    }
    markStep(state, "oracleConfigured");
  }

  console.log("\n[4/11] Fee Collector");
  const feeCollector = await deployContract(deployer, "FeeCollector", "contracts/v3/mainnet/core/FeeCollector.sol:FeeCollector", [protocolCore, deployer.address], state, "feeCollector");

  console.log("\n[5/11] Module Registry");
  const moduleRegistry = await deployContract(deployer, "ModuleRegistry", "contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry", [], state, "moduleRegistry");
  if (!state.completedSteps?.registryOracleSet) {
    await delay(3000);
    const nm = new ethers.NonceManager(deployer);
    const registry = (await ethers.getContractAt("contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry", moduleRegistry)).connect(nm);
    const tx = await registry.setOracle(oracle);
    await tx.wait(1);
    console.log("  -> registry.setOracle ✓");
    markStep(state, "registryOracleSet");
  }

  console.log("\n[6/11] Swap Infra");
  const swapHub = await deployContract(deployer, "SwapHub", "contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub", [protocolCore, oracle], state, "swapHub");
  const mockSwapRouter = await deployContract(deployer, "MockSwapRouter", "contracts/libraries/testnet/MockSwapRouter.sol:MockSwapRouter", [deployer.address, tokenAddresses, tokenPrices], state, "mockSwapRouter");
  const mockSwapAdapter = await deployContract(deployer, "MockSwapAdapter", "contracts/v3/test/MockSwapAdapter.sol:MockSwapAdapter", [mockSwapRouter], state, "mockSwapAdapter");
  if (!state.adapterIds?.mockSwap) {
    const nm = new ethers.NonceManager(deployer);
    const adapter = (await ethers.getContractAt("contracts/v3/test/MockSwapAdapter.sol:MockSwapAdapter", mockSwapAdapter)).connect(nm);
    const hub = (await ethers.getContractAt("contracts/v3/mainnet/modules/swap/SwapHub.sol:SwapHub", swapHub)).connect(nm);
    let tx = await adapter.setSwapHub(swapHub); await tx.wait(1); console.log("  -> mockSwap.setSwapHub ✓");
    tx = await hub.addAdapter(MOCK_SWAP_ADAPTER_ID, mockSwapAdapter); await tx.wait(1); console.log("  -> swapHub.addAdapter ✓");
    tx = await hub.setDefaultAdapter(MOCK_SWAP_ADAPTER_ID); await tx.wait(1); console.log("  -> swapHub.setDefaultAdapter ✓");
    state.adapterIds.mockSwap = MOCK_SWAP_ADAPTER_ID;
    saveState(state);
  }
  if (!state.completedSteps?.routerFunded) {
    await tryFundRouter(deployer, mockSwapRouter, tokens, state);
    markStep(state, "routerFunded");
  }

  console.log("\n[7/11] Lending Infra");
  const lendingHub = await deployContract(deployer, "LendingHub", "contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub", [protocolCore, oracle], state, "lendingHub");
  const mockLendingAdapter = await deployContract(deployer, "MockLendingAdapter", "contracts/v3/test/MockLendingAdapter.sol:MockLendingAdapter", [], state, "mockLendingAdapter");
  if (!state.adapterIds?.mockLending) {
    const nm = new ethers.NonceManager(deployer);
    const adapter = await ethers.getContractAt("contracts/v3/test/MockLendingAdapter.sol:MockLendingAdapter", mockLendingAdapter);
    const hub = await ethers.getContractAt("contracts/v3/mainnet/modules/lending/LendingHub.sol:LendingHub", lendingHub);
    const adapterNm = adapter.connect(nm) as typeof adapter;
    const hubNm = hub.connect(nm) as typeof hub;
    let setHubTx = await adapterNm.setLendingHub(lendingHub);
    await setHubTx.wait(1);
    console.log("  -> mockLending.setLendingHub ✓");
    for (const token of tokens) {
      try {
        const tx1 = await adapterNm.addSupportedToken(token.address, `Mock Lent ${token.symbol}`, `ml${token.symbol}`);
        await tx1.wait(1);
        const tx2 = await adapterNm.setTokenRate(token.address, ethers.parseUnits("1", 18));
        await tx2.wait(1);
        console.log(`  -> mockLending ${token.symbol} ✓`);
      } catch (e: any) {
        console.log(`  ⚠ mockLending ${token.symbol}: ${e.message?.slice(0, 60)}`);
      }
    }
    let addTx = await hubNm.addAdapter(MOCK_LENDING_ADAPTER_ID, mockLendingAdapter);
    await addTx.wait(1);
    console.log("  -> lendingHub.addAdapter ✓");
    state.adapterIds.mockLending = MOCK_LENDING_ADAPTER_ID;
    saveState(state);
  }

  console.log("\n[8/11] Register Modules");
  if (!state.completedSteps?.modulesRegistered) {
    await delay(3000);
    const nm = new ethers.NonceManager(deployer);
    const registry = (await ethers.getContractAt("contracts/v3/mainnet/core/ModuleRegistry.sol:ModuleRegistry", moduleRegistry)).connect(nm);
    let tx = await registry.setSwapModule(swapHub); await tx.wait(1); console.log("  -> registry.setSwapModule ✓");
    tx = await registry.setLendModule(lendingHub); await tx.wait(1); console.log("  -> registry.setLendModule ✓");
    markStep(state, "modulesRegistered");
  }

  console.log("\n[9/11] IndexSwapV3 Implementation");
  const indexSwapImplementation = await deployContract(deployer, "IndexSwapV3 (Implementation)", "contracts/v3/mainnet/vault/IndexSwapV3.sol:IndexSwapV3", [], state, "indexSwapImplementation");

  console.log("\n[10/11] Index Swap Factory");
  const indexSwapFactory = await deployContract(deployer, "IndexSwapFactory", "contracts/v3/factories/IndexSwapFactory.sol:IndexSwapFactory", [protocolCore, moduleRegistry, indexSwapImplementation, feeCollector], state, "indexSwapFactory");
  if (!state.completedSteps?.factoryRegistered) {
    await delay(3000);
    const nm = new ethers.NonceManager(deployer);
    const core = (await ethers.getContractAt("contracts/ProtocolCore.sol:ProtocolCore", protocolCore)).connect(nm);
    let tx = await core.setIndexSwapFactory(indexSwapFactory); await tx.wait(1); console.log("  -> core.setIndexSwapFactory ✓");
    tx = await core.setFeeCollector(feeCollector); await tx.wait(1); console.log("  -> core.setFeeCollector ✓");
    markStep(state, "factoryRegistered");
  }

  console.log("\n[11/11] Test Vault via ProtocolCore");
  if (!state.testVault) {
    await delay(3000);
    const nm = new ethers.NonceManager(deployer);
    const core = (await ethers.getContractAt("contracts/ProtocolCore.sol:ProtocolCore", protocolCore)).connect(nm);
    const tx = await core.createIndexSwapVault(deployer.address, "Test Index Vault", "TIV", portfolio, 0, 1000);
    await tx.wait(1);
    const factory = await ethers.getContractAt("contracts/v3/factories/IndexSwapFactory.sol:IndexSwapFactory", indexSwapFactory);
    const vaultCount = await factory.vaultCount();
    const vaultAddress = await factory.vaults(vaultCount - 1n);
    state.testVault = { safe: deployer.address, indexSwap: vaultAddress };
    saveState(state);
    console.log("  ✅ IndexSwapV3 (clone):", vaultAddress);
  }

  markStep(state, "complete");

  console.log("\n" + "=".repeat(70));
  console.log("TESTNET DEPLOYMENT COMPLETE");
  console.log("=".repeat(70));
  console.log("\n Core Contracts:");
  console.log("  DXPToken:           ", state.dxpToken);
  console.log("  ProtocolCore:       ", state.protocolCore);
  console.log("  MockOracle:         ", state.oracle);
  console.log("  FeeCollector:       ", state.feeCollector);
  console.log("  ModuleRegistry:     ", state.moduleRegistry);
  console.log("\n Swap Infrastructure:");
  console.log("  SwapHub:            ", state.swapHub);
  console.log("  MockSwapRouter:     ", state.mockSwapRouter);
  console.log("  MockSwapAdapter:    ", state.mockSwapAdapter);
  console.log("  MockSwap ID:        ", state.adapterIds?.mockSwap);
  console.log("\n Lending Infrastructure:");
  console.log("  LendingHub:         ", state.lendingHub);
  console.log("  MockLendingAdapter: ", state.mockLendingAdapter);
  console.log("  MockLending ID:     ", state.adapterIds?.mockLending);
  console.log("\n Factory & Implementation:");
  console.log("  IndexSwapV3 Impl:   ", state.indexSwapImplementation);
  console.log("  IndexSwapFactory:   ", state.indexSwapFactory);
  console.log("\n Test Vault:");
  console.log("  VaultOwner:         ", state.testVault?.safe);
  console.log("  IndexSwapV3:        ", state.testVault?.indexSwap);
  console.log("\n Supported Test Tokens:");
  for (const token of tokens) {
    console.log(`  ${token.symbol.padEnd(8)} ${token.address} [MockOracle+MockSwap+MockLending]`);
  }
  console.log("\n State saved to:", getStatePath());
  console.log("=".repeat(70));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
