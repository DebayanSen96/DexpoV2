import { ethers } from "ethers";

/**
 * Example: Lending operations via MockLendingAdapter
 * 
 * This demonstrates how to supply and withdraw tokens from the lending protocol.
 * In production, this would integrate with real lending protocols like Aave/Compound.
 */

// Configuration
const RPC_URL = "https://sepolia.base.org";
const LENDING_HUB = "0x8f1E7021512085C68b9664e5c68bC64cCf220e6F";
const MOCK_LENDING_ADAPTER = "0x088BEE6F9084A3269c13049214B935339116D0C2";
const PRIVATE_KEY = "YOUR_PRIVATE_KEY_HERE";

const USDC = "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)"
];

const LENDING_HUB_ABI = [
  "function supply(bytes32 adapterId, address token, uint256 amount) external",
  "function withdraw(bytes32 adapterId, address token, uint256 amount) external returns (uint256)",
  "function getSupplyBalance(bytes32 adapterId, address token, address user) external view returns (uint256)",
  "event Supply(address indexed user, bytes32 indexed adapterId, address indexed token, uint256 amount)",
  "event Withdraw(address indexed user, bytes32 indexed adapterId, address indexed token, uint256 amount)"
];

// Adapter ID for MockLendingAdapter
const MOCK_LENDING_ADAPTER_ID = "0xe4e47c0e9e61fba434e6417b61311a8dabe6df0e65a46a4608a506448c0bd5e8";

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log("User:", signer.address);
  
  // Connect to contracts
  const usdcToken = new ethers.Contract(USDC, ERC20_ABI, signer);
  const lendingHub = new ethers.Contract(LENDING_HUB, LENDING_HUB_ABI, signer);
  
  // === SUPPLY ===
  console.log("\n=== Supplying to Lending Protocol ===");
  
  const supplyAmount = ethers.parseUnits("100", 6); // 100 USDC
  
  // Approve LendingHub
  console.log("Approving USDC...");
  const approveTx = await usdcToken.approve(LENDING_HUB, supplyAmount);
  await approveTx.wait();
  
  // Supply tokens
  console.log("Supplying USDC...");
  const supplyTx = await lendingHub.supply(
    MOCK_LENDING_ADAPTER_ID,
    USDC,
    supplyAmount
  );
  await supplyTx.wait();
  console.log("Supply tx:", supplyTx.hash);
  
  // Check supply balance
  const supplyBalance = await lendingHub.getSupplyBalance(
    MOCK_LENDING_ADAPTER_ID,
    USDC,
    signer.address
  );
  console.log("Supply balance:", ethers.formatUnits(supplyBalance, 6), "USDC");
  
  // === WITHDRAW ===
  console.log("\n=== Withdrawing from Lending Protocol ===");
  
  const withdrawAmount = supplyAmount / 2n; // Withdraw 50%
  
  console.log("Withdrawing USDC...");
  const withdrawTx = await lendingHub.withdraw(
    MOCK_LENDING_ADAPTER_ID,
    USDC,
    withdrawAmount
  );
  const withdrawReceipt = await withdrawTx.wait();
  console.log("Withdraw tx:", withdrawTx.hash);
  
  // Check remaining supply balance
  const remainingBalance = await lendingHub.getSupplyBalance(
    MOCK_LENDING_ADAPTER_ID,
    USDC,
    signer.address
  );
  console.log("Remaining supply:", ethers.formatUnits(remainingBalance, 6), "USDC");
}

main().catch(console.error);
