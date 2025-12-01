import { ethers, network } from "hardhat";
import type { Contract, Signer } from "ethers";
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

type BorrowModuleWithLiquidity = Contract & {
  depositLiquidity(token: string, amount: bigint): Promise<void>;
};

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
  if (isLocalhost && !state.mockSwapRouter) {
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
  } else if (state.mockSwapRouter) {
    console.log("\nStep 0c: ✅ MockSwapRouter already deployed:", state.mockSwapRouter);
    MOCK_SWAP_ROUTER = state.mockSwapRouter;
  } else if (isBaseSepolia) {
    console.log("\nUsing existing MockSwapRouter:", MOCK_SWAP_ROUTER);
    state.mockSwapRouter = MOCK_SWAP_ROUTER;
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

  // Step 3: Register Modules
  const moduleRegistry = await ethers.getContractAt("ModuleRegistry", moduleRegistryAddress);
  
  if (state.lastStep === "borrowModule" || !state.indexSwapFactory) {
    console.log("\nStep 3: Register Modules in ModuleRegistry...");
    await moduleRegistry.setSwapModule(swapModuleAddress);
    console.log("SwapModule registered");
    
    await moduleRegistry.setBuySellModule(buySellModuleAddress);
    console.log("BuySellModule registered");
    
    await moduleRegistry.setLendModule(lendModuleAddress);
    console.log("LendModule registered");
    
    await moduleRegistry.setBorrowModule(borrowModuleAddress);
    console.log("BorrowModule registered");
    
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

  // ========== CREATE TEST VAULT ==========
  console.log("\n" + "=".repeat(60));
  console.log("CREATING TEST VAULT");
  console.log("=".repeat(60));

  let usdxAddress: string, usdcAddress: string, usdtAddress: string, daiAddress: string;
  let usdc: any, usdx: any, usdt: any, dai: any;

  // Step 6: Setup test tokens
  if (isBaseSepolia || state.testTokens) {
    if (state.testTokens) {
      console.log("\nStep 6: ✅ Using existing test tokens");
      usdxAddress = state.testTokens.usdx;
      usdcAddress = state.testTokens.usdc;
      usdtAddress = state.testTokens.usdt;
      daiAddress = state.testTokens.dai;
    } else {
      // Use existing tokens on Base Sepolia
      console.log("\nStep 6: Using existing Base Sepolia tokens...");
      usdxAddress = BASE_SEPOLIA_TOKENS.USDX;
      usdcAddress = BASE_SEPOLIA_TOKENS.USDC;
      usdtAddress = BASE_SEPOLIA_TOKENS.USDT;
      daiAddress = BASE_SEPOLIA_TOKENS.DAI;
      
      state.testTokens = {
        usdx: usdxAddress,
        usdc: usdcAddress,
        usdt: usdtAddress,
        dai: daiAddress
      };
      saveDeploymentState(network.name, state);
    }
    
    console.log("USDx:", usdxAddress);
    console.log("USDC:", usdcAddress);
    console.log("USDT:", usdtAddress);
    console.log("DAI:", daiAddress);
    
    // Get contract instances
    usdc = await ethers.getContractAt("IERC20", usdcAddress);
    usdx = await ethers.getContractAt("IERC20", usdxAddress);
    usdt = await ethers.getContractAt("IERC20", usdtAddress);
    dai = await ethers.getContractAt("IERC20", daiAddress);
    
  } else {
    // Deploy new tokens for localhost
    console.log("\nStep 6: Deploy test tokens...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    
    usdx = await MockERC20.deploy("USDx", "USDx", 18);
    await usdx.waitForDeployment();
    usdxAddress = await usdx.getAddress();
    console.log("USDx deployed:", usdxAddress);
    
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    console.log("USDC deployed:", usdcAddress);
    
    usdt = await MockERC20.deploy("Tether USD", "USDT", 6);
    await usdt.waitForDeployment();
    usdtAddress = await usdt.getAddress();
    console.log("USDT deployed:", usdtAddress);
    
    dai = await MockERC20.deploy("Dai Stablecoin", "DAI", 18);
    await dai.waitForDeployment();
    daiAddress = await dai.getAddress();
    console.log("DAI deployed:", daiAddress);

    state.testTokens = {
      usdx: usdxAddress,
      usdc: usdcAddress,
      usdt: usdtAddress,
      dai: daiAddress
    };
    state.lastStep = "testTokens";
    saveDeploymentState(network.name, state);

    console.log("\nStep 7: Configure token prices in MockSwapRouter...");
    const router = await ethers.getContractAt("MockSwapRouter", MOCK_SWAP_ROUTER);
    await router.addOrUpdateToken(usdxAddress, ethers.parseEther("1"));   // $1
    await router.addOrUpdateToken(usdcAddress, ethers.parseEther("1"));   // $1
    await router.addOrUpdateToken(usdtAddress, ethers.parseEther("1"));   // $1
    await router.addOrUpdateToken(daiAddress, ethers.parseEther("1"));    // $1
    console.log("✅ Token prices configured");

    console.log("\nStep 8: Add liquidity to MockSwapRouter...");
    await usdx.mint(MOCK_SWAP_ROUTER, ethers.parseEther("1000000"));
    await usdc.mint(MOCK_SWAP_ROUTER, ethers.parseUnits("1000000", 6));
    await usdt.mint(MOCK_SWAP_ROUTER, ethers.parseUnits("1000000", 6));
    await dai.mint(MOCK_SWAP_ROUTER, ethers.parseEther("1000000"));
    console.log("✅ Liquidity added to router");
  }

  // Step 9: Create test vault
  let safeAddress: string, indexSwapAddress: string;
  
  if (!state.testVault) {
    console.log("\nStep 9: Create test vault via ProtocolCore...");
    const portfolio = [
      { token: usdcAddress, weightBps: 4000 },  // 40% USDC
      { token: daiAddress, weightBps: 3000 },   // 30% DAI
      { token: usdtAddress, weightBps: 2000 },  // 20% USDT
      { token: usdxAddress, weightBps: 1000 }   // 10% USDx
    ];

    const LOCKUP_3_DAYS = 3 * 24 * 60 * 60;  // 3 days in seconds

    const createVaultTx = await protocolCore.createIndexSwapVault(
      [deployer.address],           // Single owner
      1,                            // 1-of-1 threshold
      "Balanced Index Fund",        // Name
      "BIF",                        // Symbol
      portfolio,                    // 40/30/20/10 portfolio
      0,                            // No farm registration
      ethers.ZeroAddress,           // Use default router
      LOCKUP_3_DAYS                 // 3 day lockup
    );

    const receipt = await createVaultTx.wait();
    
    // Parse VaultCreated event
    const vaultEvent = receipt?.logs.find((log: any) => {
      try {
        const parsed = indexSwapFactory.interface.parseLog(log);
        return parsed?.name === "VaultCreated";
      } catch {
        return false;
      }
    });

    const parsedVaultEvent = indexSwapFactory.interface.parseLog(vaultEvent!);
    safeAddress = parsedVaultEvent?.args?.safe as string;
    indexSwapAddress = parsedVaultEvent?.args?.indexSwap as string;

    console.log("✅ Test Vault Created!");
    console.log("  Safe:", safeAddress);
    console.log("  IndexSwap:", indexSwapAddress);
    
    state.testVault = {
      safe: safeAddress,
      indexSwap: indexSwapAddress
    };
    state.lastStep = "testVault";
    saveDeploymentState(network.name, state);
  } else {
    console.log("\nStep 9: ✅ Test vault already created");
    safeAddress = state.testVault.safe;
    indexSwapAddress = state.testVault.indexSwap;
    console.log("  Safe:", safeAddress);
    console.log("  IndexSwap:", indexSwapAddress);
  }

  // Note: Steps 10-18 (testing) are not idempotent and will run every time
  // Skip if you only want to deploy infrastructure
  const skipTesting = process.env.SKIP_TESTING === "true";
  
  if (skipTesting) {
    console.log("\n⏭️  Skipping testing steps (SKIP_TESTING=true)");
  } else {
    console.log("\nStep 10: Test deposit to vault...");
  }
  
  const vault = await ethers.getContractAt("IndexSwap", indexSwapAddress);
  
  // Get test wallet for deposits on Base Sepolia
  let testWallet = deployer;
  if (isBaseSepolia && process.env.TEST_WALLET_PRIVATE_KEY) {
    testWallet = new ethers.Wallet(process.env.TEST_WALLET_PRIVATE_KEY, ethers.provider);
    console.log("Using test wallet:", testWallet.address);
  }
  
  if (!skipTesting) {
    // Define deposit amounts
    const usdcAmount = ethers.parseUnits("4000", 6);   // 40% = $4000
    const daiAmount = ethers.parseEther("3000");       // 30% = $3000
    const usdtAmount = ethers.parseUnits("2000", 6);   // 20% = $2000
    const usdxAmount = ethers.parseEther("1000");      // 10% = $1000
    
    if (!isBaseSepolia) {
      // Mint tokens for localhost
      await usdc.mint(testWallet.address, usdcAmount);
      await dai.mint(testWallet.address, daiAmount);
      await usdt.mint(testWallet.address, usdtAmount);
      await usdx.mint(testWallet.address, usdxAmount);
      console.log("✅ Tokens minted to test wallet");
    }
    
    // Approve vault
    await usdc.connect(testWallet).approve(indexSwapAddress, usdcAmount);
    await dai.connect(testWallet).approve(indexSwapAddress, daiAmount);
    await usdt.connect(testWallet).approve(indexSwapAddress, usdtAmount);
    await usdx.connect(testWallet).approve(indexSwapAddress, usdxAmount);
    console.log("✅ Tokens approved");
    
    // Deposit
    const depositTx = await vault.connect(testWallet).deposit([usdcAmount, daiAmount, usdtAmount, usdxAmount]);
    await depositTx.wait();
    
    const shares = await vault.balanceOf(testWallet.address);
    console.log("✅ Deposit successful!");
    console.log("  Depositor:", testWallet.address);
    console.log("  Shares received:", ethers.formatEther(shares));

    console.log("\nStep 11: Verify vault metrics...");
    const tvl = await vault.getTotalValueUsd();
    const totalSupply = await vault.totalSupply();
    const sharePrice = tvl * ethers.parseEther("1") / totalSupply;
    
    console.log("📊 Vault Metrics:");
    console.log("  TVL:", ethers.formatEther(tvl), "USD");
    console.log("  Total Supply:", ethers.formatEther(totalSupply), "shares");
    console.log("  Share Price:", ethers.formatEther(sharePrice), "USD");

    // ========== COMPREHENSIVE TESTING ==========
    console.log("\n" + "=".repeat(60));
    console.log("COMPREHENSIVE VAULT TESTING");
    console.log("=".repeat(60));

  // Get module instances
  const buySellModuleContract = await ethers.getContractAt("BuySellModule", buySellModuleAddress);
  const lendModuleContract = await ethers.getContractAt("LendModule", lendModuleAddress);
  const borrowModuleContract = await ethers.getContractAt("BorrowModule", borrowModuleAddress);

  console.log("\nStep 12: Test Buy/Sell Operations...");
  // Approve modules to spend vault tokens
  await vault.approveToken(daiAddress, buySellModuleAddress, ethers.parseEther("500"));
  console.log("✅ Approved BuySellModule to spend DAI");
  
  // Buy 100 USDC by selling DAI
  const buyTx = await buySellModuleContract.buyToken(
    indexSwapAddress,
    daiAddress,      // Sell DAI
    usdcAddress,     // Buy USDC
    ethers.parseEther("100")  // Spend 100 DAI
  );
  await buyTx.wait();
  console.log("✅ Bought USDC with DAI");
  
  // Check new balances
  const usdcBalAfterBuy = await usdc.balanceOf(indexSwapAddress);
  const daiBalAfterBuy = await dai.balanceOf(indexSwapAddress);
  console.log("  USDC balance:", ethers.formatUnits(usdcBalAfterBuy, 6));
  console.log("  DAI balance:", ethers.formatEther(daiBalAfterBuy));

  console.log("\nStep 13: Test Lending Operations...");
  // Approve lend module
  await vault.approveToken(usdcAddress, lendModuleAddress, ethers.parseUnits("500", 6));
  console.log("✅ Approved LendModule to spend USDC");
  
  // Lend 200 USDC
  const lendTx = await lendModuleContract.lend(
    indexSwapAddress,
    usdcAddress,
    ethers.parseUnits("200", 6)
  );
  await lendTx.wait();
  console.log("✅ Lent 200 USDC");
  
  // Check lending position
  const lendPosition = await lendModuleContract.getPositionValue(indexSwapAddress, usdcAddress);
  console.log("  Lending position value:", ethers.formatEther(lendPosition), "USD");

  console.log("\nStep 14: Test Borrowing Operations...");
  // Add liquidity to borrow module for testing
  if (isBaseSepolia && !state.borrowModuleFunded) {
    console.log("⛽️ Funding BorrowModule with USDT for Base Sepolia tests...");
    await ensureBorrowModuleLiquidity(
      borrowModuleAddress,
      usdt,
      testWallet,
      ethers.parseUnits("1000", 6)
    );
    state.borrowModuleFunded = true;
    saveDeploymentState(network.name, state);
  } else if (!isBaseSepolia) {
    await usdt.mint(borrowModuleAddress, ethers.parseUnits("1000", 6));
    console.log("✅ Added liquidity to BorrowModule");
    state.borrowModuleFunded = true;
    saveDeploymentState(network.name, state);
  }
  
  // Borrow 100 USDT
  const borrowTx = await borrowModuleContract.borrow(
    indexSwapAddress,
    usdtAddress,
    ethers.parseUnits("100", 6)
  );
  await borrowTx.wait();
  console.log("✅ Borrowed 100 USDT");
  
  // Check borrow position
  const borrowPosition = await borrowModuleContract.getPositionValue(indexSwapAddress, usdtAddress);
  console.log("  Borrow position value:", ethers.formatEther(borrowPosition), "USD");

  console.log("\nStep 15: Check TVL After Operations...");
  const tvlAfterOps = await vault.getTotalValueUsd();
  console.log("  TVL before operations:", ethers.formatEther(tvl), "USD");
  console.log("  TVL after operations:", ethers.formatEther(tvlAfterOps), "USD");
  console.log("  Change:", ethers.formatEther(tvlAfterOps - tvl), "USD");

  console.log("\nStep 16: Check Portfolio Weights...");
  const portfolioAfterOps = await vault.getPortfolio();
  console.log("  Target weights (unchanged):");
  for (let i = 0; i < portfolioAfterOps.length; i++) {
    const token = portfolioAfterOps[i][0];
    const weight = portfolioAfterOps[i][1];
    const tokenContract = await ethers.getContractAt("IERC20", token);
    const balance = await tokenContract.balanceOf(indexSwapAddress);
    const tokenInfo = {
      [usdcAddress.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      [daiAddress.toLowerCase()]: { symbol: "DAI", decimals: 18 },
      [usdtAddress.toLowerCase()]: { symbol: "USDT", decimals: 6 },
      [usdxAddress.toLowerCase()]: { symbol: "USDx", decimals: 18 }
    };
    const info = tokenInfo[token.toLowerCase()];
    const actualValue = await vault.getTotalValueUsd();
    const tokenValue = (balance * ethers.parseEther("1")) / (10n ** BigInt(info.decimals));
    const actualWeight = actualValue > 0n ? (tokenValue * 10000n) / actualValue : 0n;
    console.log(`    ${info.symbol}: Target ${Number(weight)/100}%, Actual ~${Number(actualWeight)/100}%`);
  }

  console.log("\nStep 17: Test Rebalancing...");
  const rebalanceTx = await vault.rebalance();
  await rebalanceTx.wait();
  console.log("✅ Rebalanced vault");

  console.log("\nStep 18: Verify Weights After Rebalancing...");
  const tvlAfterRebalance = await vault.getTotalValueUsd();
  console.log("  TVL after rebalance:", ethers.formatEther(tvlAfterRebalance), "USD");
  
  for (let i = 0; i < portfolioAfterOps.length; i++) {
    const token = portfolioAfterOps[i][0];
    const weight = portfolioAfterOps[i][1];
    const tokenContract = await ethers.getContractAt("IERC20", token);
    const balance = await tokenContract.balanceOf(indexSwapAddress);
    const tokenInfo = {
      [usdcAddress.toLowerCase()]: { symbol: "USDC", decimals: 6 },
      [daiAddress.toLowerCase()]: { symbol: "DAI", decimals: 18 },
      [usdtAddress.toLowerCase()]: { symbol: "USDT", decimals: 6 },
      [usdxAddress.toLowerCase()]: { symbol: "USDx", decimals: 18 }
    };
    const info = tokenInfo[token.toLowerCase()];
    console.log(`    ${info.symbol}: ${ethers.formatUnits(balance, info.decimals)} (target: ${Number(weight)/100}%)`);
  }

    console.log("\n" + "=".repeat(60));
    console.log("✅ ALL TESTS PASSED!");
    console.log("=".repeat(60));
  } // End of testing block

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
  
  console.log("\n=== Factory ===");
  console.log("IndexSwapFactory:", factoryAddress);
  
  console.log("\n=== Test Tokens ===");
  console.log("USDx:", usdxAddress);
  console.log("USDC:", usdcAddress);
  console.log("USDT:", usdtAddress);
  console.log("DAI:", daiAddress);
  
  console.log("\n=== Test Vault ===");
  console.log("Safe:", safeAddress);
  console.log("IndexSwap:", indexSwapAddress);
  console.log("Portfolio: 40% USDC, 30% DAI, 20% USDT, 10% USDx");

  return {
    protocolCore: protocolCoreAddress,
    moduleRegistry: moduleRegistryAddress,
    swapModule: swapModuleAddress,
    buySellModule: buySellModuleAddress,
    lendModule: lendModuleAddress,
    borrowModule: borrowModuleAddress,
    indexSwapFactory: factoryAddress,
    mockSwapRouter: MOCK_SWAP_ROUTER,
    testTokens: {
      usdx: usdxAddress,
      usdc: usdcAddress,
      usdt: usdtAddress,
      dai: daiAddress
    },
    testVault: {
      safe: safeAddress,
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
