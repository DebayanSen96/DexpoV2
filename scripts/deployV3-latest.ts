import { ethers, network } from "hardhat";
import type { Contract, Signer, ContractTransactionResponse } from "ethers";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

// Base Sepolia existing infrastructure
const MOCK_SWAP_ROUTER_BASE_SEPOLIA = process.env.MOCK_SWAP_ROUTER || "0x8C82f93a99518f7381BBb29Cc29128e7C5249042";

// Base Sepolia test tokens (already on MockSwapRouter)
const BASE_SEPOLIA_TOKENS = {
  USDX: process.env.BASE_SEPOLIA_USDX || "0xe50E303b29aB28181460D335a1186033Af24Bf82",
  USDC: process.env.BASE_SEPOLIA_USDC || "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4",
  USDT: process.env.BASE_SEPOLIA_USDT || "0x1D196BCE6Bbea402fEF328AB1Ac50C971497173D",
  DAI: process.env.BASE_SEPOLIA_DAI || "0x5355419854236B3D9c0675a87Fa560F230127663"
};

interface TestToken {
  name: string;
  symbol: string;
  decimals: number;
  address: string;
  priceUsd: number;
  image: string;
}

interface DeploymentState {
  network: string;
  deployer: string;
  timestamp: number;
  lastStep: string;
  dxpToken?: string;
  protocolCore?: string;
  mockSwapRouter?: string;
  moduleRegistry?: string;
  swapModule?: string;
  buySellModule?: string;
  lendModule?: string;
  borrowModule?: string;
  stakingModule?: string;
  indexSwapFactory?: string;
  testTokens?: {
    usdx: string;
    usdc: string;
    usdt: string;
    dai: string;
  };
  testVault?: {
    safe: string;
    indexSwap: string;
  };
  borrowModuleFunded?: boolean;
}

function getDeploymentPath(networkName: string): string {
  const deploymentsDir = path.join(__dirname, "..", "deployments", "v3-latest");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  return path.join(deploymentsDir, `${networkName}.json`);
}

function loadDeploymentState(networkName: string): DeploymentState | null {
  const deploymentPath = getDeploymentPath(networkName);
  if (!fs.existsSync(deploymentPath)) {
    return null;
  }

  const data = fs.readFileSync(deploymentPath, "utf8").trim();
  if (!data) {
    console.warn(`⚠️ Deployment state file ${deploymentPath} is empty. Starting fresh deployment.`);
    return null;
  }

  try {
    return JSON.parse(data);
  } catch (error) {
    console.warn(`⚠️ Failed to parse deployment state for ${networkName}: ${error}. Starting fresh deployment.`);
    return null;
  }
}

function saveDeploymentState(networkName: string, state: DeploymentState): void {
  const deploymentPath = getDeploymentPath(networkName);
  fs.writeFileSync(deploymentPath, JSON.stringify(state, null, 2));
  console.log(`💾 Saved deployment state to ${deploymentPath}`);
}

function getTestTokensPath(networkName: string): string {
  const deploymentsDir = path.join(__dirname, "..", "deployments", "v3-latest");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  return path.join(deploymentsDir, `${networkName}_test_tokens.json`);
}

function saveTestTokens(networkName: string, deployer: string, tokens: TestToken[]): void {
  const tokensPath = getTestTokensPath(networkName);
  const data = {
    network: networkName,
    mintedTo: deployer,
    tokens
  };
  fs.writeFileSync(tokensPath, JSON.stringify(data, null, 2));
  console.log(`💾 Saved test tokens to ${tokensPath}`);
}

function loadTestTokens(networkName: string): TestToken[] | null {
  const tokensPath = getTestTokensPath(networkName);
  if (!fs.existsSync(tokensPath)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
    return data.tokens;
  } catch {
    return null;
  }
}

const TEST_TOKEN_CONFIGS: Omit<TestToken, "address">[] = [
  { name: "USD Coin", symbol: "USDC", decimals: 6, priceUsd: 1, image: "https://coin-images.coingecko.com/coins/images/6319/large/usdc.png?1696506694" },
  { name: "Tether USD", symbol: "USDT", decimals: 6, priceUsd: 1, image: "https://coin-images.coingecko.com/coins/images/325/large/Tether.png?1696501661" },
  { name: "Dai Stablecoin", symbol: "DAI", decimals: 18, priceUsd: 1, image: "https://coin-images.coingecko.com/coins/images/9956/large/Badge_Dai.png?1696509996" },
  { name: "Wrapped Ether", symbol: "WETH", decimals: 18, priceUsd: 3500, image: "https://coin-images.coingecko.com/coins/images/2518/large/weth.png?1696503332" },
  { name: "Wrapped Bitcoin", symbol: "WBTC", decimals: 8, priceUsd: 100000, image: "https://coin-images.coingecko.com/coins/images/7598/large/wrapped_bitcoin_wbtc.png?1696507857" },
  { name: "Chainlink", symbol: "LINK", decimals: 18, priceUsd: 15, image: "https://coin-images.coingecko.com/coins/images/877/large/chainlink-new-logo.png?1696502009" },
  { name: "Uniswap", symbol: "UNI", decimals: 18, priceUsd: 8, image: "https://coin-images.coingecko.com/coins/images/12504/large/uniswap-logo.png?1720676669" },
  { name: "Aave", symbol: "AAVE", decimals: 18, priceUsd: 250, image: "https://coin-images.coingecko.com/coins/images/12645/large/aave-token-round.png?1720472354" },
  { name: "USDx", symbol: "USDx", decimals: 18, priceUsd: 1, image: "https://dxp-bucket.sfo3.digitaloceanspaces.com/share-token-images_1758536678313_USDx--1-.png" },
  { name: "Solana", symbol: "SOL", decimals: 18, priceUsd: 180, image: "https://coin-images.coingecko.com/coins/images/4128/large/solana.png?1718769756" }
];

type BorrowModuleWithLiquidity = Contract & {
  depositLiquidity(token: string, amount: bigint): Promise<void>;
};

async function waitForTx<T extends ContractTransactionResponse>(txPromise: Promise<T>): Promise<T> {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt?.status) {
    throw new Error("Transaction failed");
  }
  return tx;
}

async function ensureBorrowModuleLiquidity(
  moduleAddress: string,
  token: Contract,
  funder: Signer,
  amount: bigint
): Promise<void> {
  if (amount <= 0n) {
    return;
  }

  const tokenAddress = await token.getAddress();
  const borrowModule = (await ethers.getContractAt("BorrowModule", moduleAddress)) as BorrowModuleWithLiquidity;
  const funderAddress = await funder.getAddress();

  await (token as any).connect(funder).approve(moduleAddress, amount);
  await borrowModule.connect(funder).depositLiquidity(tokenAddress, amount);
  console.log(`✅ BorrowModule funded with ${ethers.formatUnits(amount, 6)} USDT from ${funderAddress}`);
}

async function main() {
  const isLocalhost = network.name === "hardhat" || network.name === "localhost";
  const isBaseSepolia = network.name === "baseSepolia" || network.name === "base-sepolia";
  const isHoodiNetwork = network.name.toLowerCase().includes("hoodi");
  
  let MOCK_SWAP_ROUTER = MOCK_SWAP_ROUTER_BASE_SEPOLIA;
  
  const [deployer] = await ethers.getSigners();
  console.log("Network:", network.name);
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // Load existing deployment state
  let state = loadDeploymentState(network.name);
  if (state) {
    console.log("📂 Found existing deployment from", new Date(state.timestamp).toLocaleString());
    console.log("   Last completed step:", state.lastStep);
    console.log("   Resuming deployment...\n");
  } else {
    console.log("🆕 Starting fresh deployment...\n");
    state = {
      network: network.name,
      deployer: deployer.address,
      timestamp: Date.now(),
      lastStep: "init"
    };
  }
  
  let protocolCoreAddress = state.protocolCore || ethers.ZeroAddress;
  let dxpAddress = state.dxpToken || ethers.ZeroAddress;
  
  // Step 0a: Deploy DXPToken
  if (!state.dxpToken) {
    console.log("Step 0a: Deploy DXPToken...");
    const DXPToken = await ethers.getContractFactory("DXPToken");
    const dxpToken = await DXPToken.deploy();
    await dxpToken.waitForDeployment();
    dxpAddress = await dxpToken.getAddress();
    console.log("DXPToken deployed to:", dxpAddress);
    
    state.dxpToken = dxpAddress;
    state.lastStep = "dxpToken";
    saveDeploymentState(network.name, state);
  } else {
    console.log("Step 0a: ✅ DXPToken already deployed:", state.dxpToken);
    dxpAddress = state.dxpToken;
  }
  
  // Step 0b: Deploy ProtocolCore
  if (!state.protocolCore) {
    console.log("\nStep 0b: Deploy ProtocolCore...");
    const ProtocolCore = await ethers.getContractFactory("ProtocolCore");
    const protocolCore = await ProtocolCore.deploy(
      dxpAddress,
      70,
      10,
      30
    );
    await protocolCore.waitForDeployment();
    protocolCoreAddress = await protocolCore.getAddress();
    console.log("ProtocolCore deployed to:", protocolCoreAddress);
    
    state.protocolCore = protocolCoreAddress;
    state.lastStep = "protocolCore";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\nStep 0b: ✅ ProtocolCore already deployed:", state.protocolCore);
    protocolCoreAddress = state.protocolCore;
  }
  
  // Step 0c: Deploy or use MockSwapRouter
  if (state.mockSwapRouter) {
    console.log("\nStep 0c: ✅ MockSwapRouter already deployed:", state.mockSwapRouter);
    MOCK_SWAP_ROUTER = state.mockSwapRouter;
  } else if (isBaseSepolia) {
    console.log("\nUsing existing MockSwapRouter:", MOCK_SWAP_ROUTER);
    state.mockSwapRouter = MOCK_SWAP_ROUTER;
  } else {
    console.log("\nStep 0c: Deploy MockSwapRouter...");
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
    const mockRouter = await MockSwapRouter.deploy(
      deployer.address,
      [],
      []
    );
    await mockRouter.waitForDeployment();
    MOCK_SWAP_ROUTER = await mockRouter.getAddress();
    console.log("MockSwapRouter deployed to:", MOCK_SWAP_ROUTER);
    
    state.mockSwapRouter = MOCK_SWAP_ROUTER;
    state.lastStep = "mockSwapRouter";
    saveDeploymentState(network.name, state);
  }
  
  console.log("\nDeploying IndexSwap System...\n");

  // Step 1: Deploy ModuleRegistry
  let moduleRegistryAddress = state.moduleRegistry || ethers.ZeroAddress;
  if (!state.moduleRegistry) {
    console.log("Step 1: Deploy ModuleRegistry...");
    const ModuleRegistry = await ethers.getContractFactory("ModuleRegistry");
    const moduleRegistry = await ModuleRegistry.deploy();
    await moduleRegistry.waitForDeployment();
    moduleRegistryAddress = await moduleRegistry.getAddress();
    console.log("ModuleRegistry deployed to:", moduleRegistryAddress);
    
    state.moduleRegistry = moduleRegistryAddress;
    state.lastStep = "moduleRegistry";
    saveDeploymentState(network.name, state);
  } else {
    console.log("Step 1: ✅ ModuleRegistry already deployed:", state.moduleRegistry);
    moduleRegistryAddress = state.moduleRegistry;
  }

  console.log("\nStep 2: Deploy Shared Modules...");
  
  // Deploy SwapModule
  let swapModuleAddress = state.swapModule || ethers.ZeroAddress;
  if (!state.swapModule) {
    const SwapModule = await ethers.getContractFactory("SwapModule");
    const swapModule = await SwapModule.deploy(
      protocolCoreAddress,
      MOCK_SWAP_ROUTER
    );
    await swapModule.waitForDeployment();
    swapModuleAddress = await swapModule.getAddress();
    console.log("SwapModule deployed to:", swapModuleAddress);
    
    state.swapModule = swapModuleAddress;
    state.lastStep = "swapModule";
    saveDeploymentState(network.name, state);
  } else {
    console.log("✅ SwapModule already deployed:", state.swapModule);
    swapModuleAddress = state.swapModule;
  }

  // Deploy BuySellModule
  let buySellModuleAddress = state.buySellModule || ethers.ZeroAddress;
  if (!state.buySellModule) {
    const BuySellModule = await ethers.getContractFactory("BuySellModule");
    const buySellModule = await BuySellModule.deploy(
      protocolCoreAddress,
      MOCK_SWAP_ROUTER
    );
    await buySellModule.waitForDeployment();
    buySellModuleAddress = await buySellModule.getAddress();
    console.log("BuySellModule deployed to:", buySellModuleAddress);
    
    state.buySellModule = buySellModuleAddress;
    state.lastStep = "buySellModule";
    saveDeploymentState(network.name, state);
  } else {
    console.log("✅ BuySellModule already deployed:", state.buySellModule);
    buySellModuleAddress = state.buySellModule;
  }

  // Deploy LendModule
  let lendModuleAddress = state.lendModule || ethers.ZeroAddress;
  if (!state.lendModule) {
    const LendModule = await ethers.getContractFactory("LendModule");
    const lendModule = await LendModule.deploy(
      protocolCoreAddress,
      MOCK_SWAP_ROUTER
    );
    await lendModule.waitForDeployment();
    lendModuleAddress = await lendModule.getAddress();
    console.log("LendModule deployed to:", lendModuleAddress);
    
    state.lendModule = lendModuleAddress;
    state.lastStep = "lendModule";
    saveDeploymentState(network.name, state);
  } else {
    console.log("✅ LendModule already deployed:", state.lendModule);
    lendModuleAddress = state.lendModule;
  }

  // Deploy BorrowModule
  let borrowModuleAddress = state.borrowModule || ethers.ZeroAddress;
  if (!state.borrowModule) {
    const BorrowModule = await ethers.getContractFactory("BorrowModule");
    const borrowModule = await BorrowModule.deploy(
      protocolCoreAddress,
      MOCK_SWAP_ROUTER
    );
    await borrowModule.waitForDeployment();
    borrowModuleAddress = await borrowModule.getAddress();
    console.log("BorrowModule deployed to:", borrowModuleAddress);
    
    state.borrowModule = borrowModuleAddress;
    state.lastStep = "borrowModule";
    saveDeploymentState(network.name, state);
  } else {
    console.log("✅ BorrowModule already deployed:", state.borrowModule);
    borrowModuleAddress = state.borrowModule;
  }

  // Deploy StakingModule (only on eth-hoodi or if explicitly enabled)
  const DEPLOY_STAKING = process.env.DEPLOY_STAKING_MODULE === "true" || isHoodiNetwork;
  
  let stakingModuleAddress = state.stakingModule || ethers.ZeroAddress;
  if (DEPLOY_STAKING && !state.stakingModule) {
    console.log("\nDeploying StakingModule (ETH Validator Staking via SSV)...");
    
    // ETH 2.0 Deposit Contract addresses
    // Mainnet: 0x00000000219ab540356cBB839Cbe05303d7705Fa
    // Hoodi testnet: 0x00000000219ab540356cBB839Cbe05303d7705Fa (same)
    const ETH_DEPOSIT_CONTRACT = process.env.ETH_DEPOSIT_CONTRACT || "0x00000000219ab540356cBB839Cbe05303d7705Fa";
    
    // SSV Network addresses (mainnet defaults, override via env for testnet)
    const SSV_NETWORK = process.env.SSV_NETWORK || "0xDD9BC35aE942eF0cFa76930954a156B3fF30a4E1";
    const SSV_TOKEN = process.env.SSV_TOKEN || "0x9D65fF81a3c488d585bBfb0Bfe3c7707c7917f54";
    
    console.log("  ETH Deposit Contract:", ETH_DEPOSIT_CONTRACT);
    console.log("  SSV Network:", SSV_NETWORK);
    console.log("  SSV Token:", SSV_TOKEN);
    
    const StakingModule = await ethers.getContractFactory("StakingModule");
    const stakingModule = await StakingModule.deploy(
      protocolCoreAddress,
      ETH_DEPOSIT_CONTRACT,
      SSV_NETWORK,
      SSV_TOKEN
    );
    await stakingModule.waitForDeployment();
    stakingModuleAddress = await stakingModule.getAddress();
    console.log("StakingModule deployed to:", stakingModuleAddress);
    
    state.stakingModule = stakingModuleAddress;
    state.lastStep = "stakingModule";
    saveDeploymentState(network.name, state);
  } else if (state.stakingModule) {
    console.log("✅ StakingModule already deployed:", state.stakingModule);
    stakingModuleAddress = state.stakingModule;
  } else if (!DEPLOY_STAKING) {
    console.log("⏭️  Skipping StakingModule (not eth-hoodi network, set DEPLOY_STAKING_MODULE=true to deploy)");
  }

  // Step 3: Register Modules
  const moduleRegistry = await ethers.getContractAt("ModuleRegistry", moduleRegistryAddress);
  
  if (state.lastStep === "borrowModule" || state.lastStep === "stakingModule" || !state.indexSwapFactory) {
    console.log("\nStep 3: Register Modules in ModuleRegistry...");
    await waitForTx(moduleRegistry.setSwapModule(swapModuleAddress));
    console.log("SwapModule registered");
    
    await waitForTx(moduleRegistry.setBuySellModule(buySellModuleAddress));
    console.log("BuySellModule registered");
    
    await waitForTx(moduleRegistry.setLendModule(lendModuleAddress));
    console.log("LendModule registered");
    
    await waitForTx(moduleRegistry.setBorrowModule(borrowModuleAddress));
    console.log("BorrowModule registered");
    
    if (stakingModuleAddress !== ethers.ZeroAddress) {
      await waitForTx(moduleRegistry.setStakingModule(stakingModuleAddress));
      console.log("StakingModule registered");
    }
    
    state.lastStep = "modulesRegistered";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\nStep 3: ✅ Modules already registered");
  }

  // Step 4: Deploy IndexSwapFactory
  let factoryAddress = state.indexSwapFactory || ethers.ZeroAddress;
  if (!state.indexSwapFactory) {
    console.log("\nStep 4: Deploy IndexSwapFactory...");
    const IndexSwapFactory = await ethers.getContractFactory("IndexSwapFactory");
    const indexSwapFactory = await IndexSwapFactory.deploy(
      protocolCoreAddress,
      moduleRegistryAddress,
      MOCK_SWAP_ROUTER
    );
    await indexSwapFactory.waitForDeployment();
    factoryAddress = await indexSwapFactory.getAddress();
    console.log("IndexSwapFactory deployed to:", factoryAddress);
    
    state.indexSwapFactory = factoryAddress;
    state.lastStep = "indexSwapFactory";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\nStep 4: ✅ IndexSwapFactory already deployed:", state.indexSwapFactory);
    factoryAddress = state.indexSwapFactory;
  }

  // Step 5: Register Factory with ProtocolCore
  const protocolCore = await ethers.getContractAt("ProtocolCore", protocolCoreAddress);
  const indexSwapFactory = await ethers.getContractAt("IndexSwapFactory", factoryAddress);
  
  if (state.lastStep === "indexSwapFactory") {
    console.log("\nStep 5: Register IndexSwapFactory with ProtocolCore...");
    const registerTx = await protocolCore.setIndexSwapFactory(factoryAddress);
    await registerTx.wait();
    console.log("✅ IndexSwapFactory registered with ProtocolCore");
    
    state.lastStep = "factoryRegistered";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\nStep 5: ✅ IndexSwapFactory already registered");
  }

  // ========== DEPLOY TEST TOKENS ==========
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYING TEST TOKENS (10 tokens)");
  console.log("=".repeat(60));

  let deployedTokens: TestToken[] = [];
  const existingTokens = loadTestTokens(network.name);
  
  if (existingTokens && existingTokens.length >= 10) {
    console.log("\nStep 6: ✅ Using existing test tokens");
    deployedTokens = existingTokens;
    for (const token of deployedTokens) {
      console.log(`  ${token.symbol}: ${token.address} ($${token.priceUsd})`);
    }
  } else if (isBaseSepolia) {
    console.log("\nStep 6: Using existing Base Sepolia tokens...");
    deployedTokens = [
      { name: "USD Coin", symbol: "USDC", decimals: 6, address: BASE_SEPOLIA_TOKENS.USDC, priceUsd: 1, image: "https://coin-images.coingecko.com/coins/images/6319/large/usdc.png?1696506694" },
      { name: "Tether USD", symbol: "USDT", decimals: 6, address: BASE_SEPOLIA_TOKENS.USDT, priceUsd: 1, image: "https://coin-images.coingecko.com/coins/images/325/large/Tether.png?1696501661" },
      { name: "Dai Stablecoin", symbol: "DAI", decimals: 18, address: BASE_SEPOLIA_TOKENS.DAI, priceUsd: 1, image: "https://coin-images.coingecko.com/coins/images/9956/large/Badge_Dai.png?1696509996" },
      { name: "USDx", symbol: "USDx", decimals: 18, address: BASE_SEPOLIA_TOKENS.USDX, priceUsd: 1, image: "https://dxp-bucket.sfo3.digitaloceanspaces.com/share-token-images_1758536678313_USDx--1-.png" }
    ];
    saveTestTokens(network.name, deployer.address, deployedTokens);
  } else {
    console.log("\nStep 6: Deploy 10 test tokens...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const router = await ethers.getContractAt("MockSwapRouter", MOCK_SWAP_ROUTER);
    
    for (const config of TEST_TOKEN_CONFIGS) {
      const token = await MockERC20.deploy(config.name, config.symbol, config.decimals);
      await token.waitForDeployment();
      const tokenAddress = await token.getAddress();
      
      deployedTokens.push({
        ...config,
        address: tokenAddress
      });
      console.log(`  ${config.symbol} deployed: ${tokenAddress} ($${config.priceUsd})`);
      
      const priceE18 = ethers.parseEther(config.priceUsd.toString());
      await waitForTx(router.addOrUpdateToken(tokenAddress, priceE18));
      
      const liquidityAmount = config.decimals === 18 
        ? ethers.parseEther("1000000")
        : ethers.parseUnits("1000000", config.decimals);
      await waitForTx(token.mint(MOCK_SWAP_ROUTER, liquidityAmount));
    }
    
    saveTestTokens(network.name, deployer.address, deployedTokens);
    console.log("✅ All 10 tokens deployed, prices configured, and liquidity added");
  }

  const findToken = (symbol: string) => deployedTokens.find(t => t.symbol === symbol)!;
  const usdcAddress = findToken("USDC").address;
  const usdtAddress = findToken("USDT").address;
  const daiAddress = findToken("DAI").address;
  const usdxAddress = findToken("USDx").address;
  
  state.testTokens = { usdx: usdxAddress, usdc: usdcAddress, usdt: usdtAddress, dai: daiAddress };
  saveDeploymentState(network.name, state);

  // ========== CREATE VAULT SAFE & TEST VAULT ==========
  console.log("\n" + "=".repeat(60));
  console.log("CREATING VAULT SAFE & TEST VAULT");
  console.log("=".repeat(60));

  let vaultSafeAddress: string;
  let indexSwapAddress: string;
  
  if (!state.testVault) {
    console.log("\nStep 7: Deploy VaultSafe...");
    const VaultSafe = await ethers.getContractFactory("VaultSafe");
    const vaultSafe = await VaultSafe.deploy(
      protocolCoreAddress,
      [deployer.address],
      1
    );
    await vaultSafe.waitForDeployment();
    vaultSafeAddress = await vaultSafe.getAddress();
    console.log("✅ VaultSafe deployed:", vaultSafeAddress);
    console.log("  Owners:", [deployer.address]);
    console.log("  Threshold: 1");

    console.log("\nStep 8: Create test vault via ProtocolCore with VaultSafe as owner...");
    const portfolio = [
      { token: usdcAddress, weightBps: 4000 },
      { token: daiAddress, weightBps: 3000 },
      { token: usdtAddress, weightBps: 2000 },
      { token: usdxAddress, weightBps: 1000 }
    ];

    const LOCKUP_ZERO = 0;

    const createVaultTx = await protocolCore.createIndexSwapVault(
      vaultSafeAddress,
      "Balanced Index Fund",
      "BIF",
      portfolio,
      ethers.ZeroAddress,
      LOCKUP_ZERO
    );

    const receipt = await createVaultTx.wait();
    
    const vaultEvent = receipt?.logs.find((log: any) => {
      try {
        const parsed = indexSwapFactory.interface.parseLog(log);
        return parsed?.name === "VaultCreated";
      } catch {
        return false;
      }
    });

    const parsedVaultEvent = indexSwapFactory.interface.parseLog(vaultEvent!);
    indexSwapAddress = parsedVaultEvent?.args?.indexSwap as string;

    console.log("✅ Test Vault Created!");
    console.log("  VaultSafe (Owner):", vaultSafeAddress);
    console.log("  IndexSwap:", indexSwapAddress);
    
    state.testVault = {
      safe: vaultSafeAddress,
      indexSwap: indexSwapAddress
    };
    state.lastStep = "testVault";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\nStep 7-8: ✅ VaultSafe and test vault already created");
    vaultSafeAddress = state.testVault.safe;
    indexSwapAddress = state.testVault.indexSwap;
    console.log("  VaultSafe:", vaultSafeAddress);
    console.log("  IndexSwap:", indexSwapAddress);
  }

  // Note: Testing steps are not idempotent and will run every time
  // Skip if you only want to deploy infrastructure
  const skipTesting = process.env.SKIP_TESTING === "true" || isHoodiNetwork;
  
  if (skipTesting) {
    console.log("\n⏭️  Skipping testing steps (SKIP_TESTING=true)");
  }
  
  const vault = await ethers.getContractAt("IndexSwap", indexSwapAddress);
  const vaultSafe = await ethers.getContractAt("VaultSafe", vaultSafeAddress);
  
  const usdc = await ethers.getContractAt("MockERC20", usdcAddress);
  const usdt = await ethers.getContractAt("MockERC20", usdtAddress);
  const dai = await ethers.getContractAt("MockERC20", daiAddress);
  const usdx = await ethers.getContractAt("MockERC20", usdxAddress);
  
  if (!skipTesting) {
    console.log("\n" + "=".repeat(60));
    console.log("TESTING VAULT VIA VAULTSAFE");
    console.log("=".repeat(60));

    console.log("\nStep 9: Test deposit to vault...");
    const usdcAmount = ethers.parseUnits("4000", 6);
    const daiAmount = ethers.parseEther("3000");
    const usdtAmount = ethers.parseUnits("2000", 6);
    const usdxAmount = ethers.parseEther("1000");
    
    if (!isBaseSepolia) {
      await usdc.mint(deployer.address, usdcAmount);
      await dai.mint(deployer.address, daiAmount);
      await usdt.mint(deployer.address, usdtAmount);
      await usdx.mint(deployer.address, usdxAmount);
      console.log("✅ Tokens minted to deployer");
    }
    
    await usdc.approve(indexSwapAddress, usdcAmount);
    await dai.approve(indexSwapAddress, daiAmount);
    await usdt.approve(indexSwapAddress, usdtAmount);
    await usdx.approve(indexSwapAddress, usdxAmount);
    console.log("✅ Tokens approved for vault");
    
    const depositTx = await vault.deposit([usdcAmount, daiAmount, usdtAmount, usdxAmount]);
    await depositTx.wait();
    
    const shares = await vault.balanceOf(deployer.address);
    console.log("✅ Deposit successful!");
    console.log("  Depositor:", deployer.address);
    console.log("  Shares received:", ethers.formatEther(shares));

    console.log("\nStep 10: Verify vault metrics...");
    const tvl = await vault.getTotalValueUsd();
    const totalSupply = await vault.totalSupply();
    const sharePrice = tvl * ethers.parseEther("1") / totalSupply;
    
    console.log("📊 Vault Metrics:");
    console.log("  TVL:", ethers.formatEther(tvl), "USD");
    console.log("  Total Supply:", ethers.formatEther(totalSupply), "shares");
    console.log("  Share Price:", ethers.formatEther(sharePrice), "USD");

    console.log("\nStep 11: Test VaultSafe operations (approveToken via submitTransaction)...");
    const approveCalldata = vault.interface.encodeFunctionData("approveToken", [
      daiAddress,
      buySellModuleAddress,
      ethers.parseEther("500")
    ]);
    
    const submitTx = await vaultSafe.submitTransaction(indexSwapAddress, 0, approveCalldata);
    await submitTx.wait();
    console.log("✅ VaultSafe executed approveToken via submitTransaction");

    const buySellModuleContract = await ethers.getContractAt("BuySellModule", buySellModuleAddress);
    const lendModuleContract = await ethers.getContractAt("LendModule", lendModuleAddress);
    const borrowModuleContract = await ethers.getContractAt("BorrowModule", borrowModuleAddress);

    console.log("\nStep 12: Test Buy/Sell Operations...");
    const buyTx = await buySellModuleContract.buyToken(
      indexSwapAddress,
      daiAddress,
      usdcAddress,
      ethers.parseEther("100")
    );
    await buyTx.wait();
    console.log("✅ Bought USDC with DAI");
    
    const usdcBalAfterBuy = await usdc.balanceOf(indexSwapAddress);
    const daiBalAfterBuy = await dai.balanceOf(indexSwapAddress);
    console.log("  USDC balance:", ethers.formatUnits(usdcBalAfterBuy, 6));
    console.log("  DAI balance:", ethers.formatEther(daiBalAfterBuy));

    console.log("\nStep 13: Test Lending Operations...");
    const approveLendCalldata = vault.interface.encodeFunctionData("approveToken", [
      usdcAddress,
      lendModuleAddress,
      ethers.parseUnits("500", 6)
    ]);
    await (await vaultSafe.submitTransaction(indexSwapAddress, 0, approveLendCalldata)).wait();
    console.log("✅ VaultSafe approved LendModule to spend USDC");
    
    const lendTx = await lendModuleContract.lend(
      indexSwapAddress,
      usdcAddress,
      ethers.parseUnits("200", 6)
    );
    await lendTx.wait();
    console.log("✅ Lent 200 USDC");
    
    const lendPosition = await lendModuleContract.getPositionValue(indexSwapAddress, usdcAddress);
    console.log("  Lending position value:", ethers.formatEther(lendPosition), "USD");

    console.log("\nStep 14: Test Borrowing Operations...");
    if (!isBaseSepolia) {
      await usdt.mint(borrowModuleAddress, ethers.parseUnits("1000", 6));
      console.log("✅ Added liquidity to BorrowModule");
    }
    
    const borrowTx = await borrowModuleContract.borrow(
      indexSwapAddress,
      usdtAddress,
      ethers.parseUnits("100", 6)
    );
    await borrowTx.wait();
    console.log("✅ Borrowed 100 USDT");
    
    const borrowPosition = await borrowModuleContract.getPositionValue(indexSwapAddress, usdtAddress);
    console.log("  Borrow position value:", ethers.formatEther(borrowPosition), "USD");

    console.log("\nStep 15: Check TVL After Operations...");
    const tvlAfterOps = await vault.getTotalValueUsd();
    console.log("  TVL before operations:", ethers.formatEther(tvl), "USD");
    console.log("  TVL after operations:", ethers.formatEther(tvlAfterOps), "USD");

    console.log("\nStep 16: Test Rebalancing via VaultSafe...");
    const rebalanceCalldata = vault.interface.encodeFunctionData("rebalance");
    await (await vaultSafe.submitTransaction(indexSwapAddress, 0, rebalanceCalldata)).wait();
    console.log("✅ VaultSafe executed rebalance");

    console.log("\nStep 17: Test Withdrawal...");
    const sharesToWithdraw = ethers.parseEther("1000");
    const withdrawTx = await vault.withdraw(sharesToWithdraw);
    await withdrawTx.wait();
    console.log("✅ Withdrew", ethers.formatEther(sharesToWithdraw), "shares");
    
    const sharesAfterWithdraw = await vault.balanceOf(deployer.address);
    console.log("  Remaining shares:", ethers.formatEther(sharesAfterWithdraw));

    console.log("\n" + "=".repeat(60));
    console.log("✅ ALL TESTS PASSED!");
    console.log("=".repeat(60));
  }

  // ========== DEPLOYMENT SUMMARY ==========
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  
  console.log("\n📋 Deployment saved to:", getDeploymentPath(network.name));
  console.log("   Network:", network.name);
  console.log("   Deployer:", deployer.address);
  console.log("   Timestamp:", new Date(state.timestamp).toLocaleString());
  
  console.log("\n=== Core Infrastructure ===");
  console.log("DXPToken:", dxpAddress);
  console.log("ProtocolCore:", protocolCoreAddress);
  console.log("MockSwapRouter:", MOCK_SWAP_ROUTER);
  
  console.log("\n=== Module System ===");
  console.log("ModuleRegistry:", moduleRegistryAddress);
  console.log("SwapModule:", swapModuleAddress);
  console.log("BuySellModule:", buySellModuleAddress);
  console.log("LendModule:", lendModuleAddress);
  console.log("BorrowModule:", borrowModuleAddress);
  if (stakingModuleAddress !== ethers.ZeroAddress) {
    console.log("StakingModule:", stakingModuleAddress);
  }
  
  console.log("\n=== Factory ===");
  console.log("IndexSwapFactory:", factoryAddress);
  
  console.log("\n=== Test Tokens ===");
  console.log("Tokens file:", getTestTokensPath(network.name));
  console.log("Total tokens:", deployedTokens.length);
  for (const token of deployedTokens) {
    console.log(`  ${token.symbol}: ${token.address} ($${token.priceUsd})`);
  }
  
  console.log("\n=== Test Vault ===");
  console.log("VaultSafe:", vaultSafeAddress);
  console.log("IndexSwap:", indexSwapAddress);
  console.log("Portfolio: 40% USDC, 30% DAI, 20% USDT, 10% USDx");

  return {
    protocolCore: protocolCoreAddress,
    moduleRegistry: moduleRegistryAddress,
    swapModule: swapModuleAddress,
    buySellModule: buySellModuleAddress,
    lendModule: lendModuleAddress,
    borrowModule: borrowModuleAddress,
    stakingModule: stakingModuleAddress !== ethers.ZeroAddress ? stakingModuleAddress : undefined,
    indexSwapFactory: factoryAddress,
    mockSwapRouter: MOCK_SWAP_ROUTER,
    testTokens: deployedTokens,
    testVault: {
      vaultSafe: vaultSafeAddress,
      indexSwap: indexSwapAddress
    }
  };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
