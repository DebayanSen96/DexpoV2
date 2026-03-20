import { ethers } from "ethers";

/**
 * Example: Deposit and withdraw from an IndexSwapV3 vault
 * 
 * This demonstrates the basic vault interaction flow:
 * 1. Approve tokens
 * 2. Deposit tokens to get vault shares
 * 3. Withdraw tokens by burning vault shares
 */

// Configuration
const RPC_URL = "https://sepolia.base.org";
const VAULT_ADDRESS = "0xA33456CB60642ccD22faf98916dab6Bedd1F7702"; // Example vault
const PRIVATE_KEY = "YOUR_PRIVATE_KEY_HERE";

// Tokens in the vault portfolio
const USDC = "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4";
const WETH = "0x3aAbBC9464fAA82B99c92b69A021FC8B4b639c4F";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

const VAULT_ABI = [
  "function deposit(uint256[] memory amounts) external returns (uint256 shares)",
  "function withdraw(uint256 shares) external returns (uint256[] memory amounts)",
  "function getPortfolio() external view returns (address[] memory tokens, uint256[] memory weights)",
  "function balanceOf(address account) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "event Deposit(address indexed user, uint256[] amounts, uint256 shares)",
  "event Withdraw(address indexed user, uint256 shares, uint256[] amounts)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log("User:", signer.address);
  
  // Connect to vault
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
  
  // Get portfolio composition
  console.log("\n=== Vault Portfolio ===");
  const [tokens, weights] = await vault.getPortfolio();
  for (let i = 0; i < tokens.length; i++) {
    console.log(`${tokens[i]}: ${weights[i] / 100}%`);
  }
  
  // === DEPOSIT ===
  console.log("\n=== Depositing ===");
  
  // Amounts to deposit (proportional to weights)
  const depositAmounts = [
    ethers.parseUnits("100", 6),  // 100 USDC
    ethers.parseEther("0.02")     // 0.02 WETH
  ];
  
  // Approve tokens
  for (let i = 0; i < tokens.length; i++) {
    const token = new ethers.Contract(tokens[i], ERC20_ABI, signer);
    console.log(`Approving ${tokens[i]}...`);
    const approveTx = await token.approve(VAULT_ADDRESS, depositAmounts[i]);
    await approveTx.wait();
  }
  
  // Deposit
  console.log("Depositing tokens...");
  const depositTx = await vault.deposit(depositAmounts);
  const depositReceipt = await depositTx.wait();
  console.log("Deposit tx:", depositTx.hash);
  
  // Get shares received
  const shareBalance = await vault.balanceOf(signer.address);
  console.log("Vault shares received:", ethers.formatEther(shareBalance));
  
  // === WITHDRAW ===
  console.log("\n=== Withdrawing ===");
  
  // Withdraw 50% of shares
  const sharesToWithdraw = shareBalance / 2n;
  console.log("Withdrawing shares:", ethers.formatEther(sharesToWithdraw));
  
  const withdrawTx = await vault.withdraw(sharesToWithdraw);
  const withdrawReceipt = await withdrawTx.wait();
  console.log("Withdraw tx:", withdrawTx.hash);
  
  // Parse withdraw event to see amounts received
  const withdrawEvent = withdrawReceipt.logs.find((log: any) => {
    try {
      const parsed = vault.interface.parseLog({
        topics: log.topics as string[],
        data: log.data
      });
      return parsed?.name === "Withdraw";
    } catch {
      return false;
    }
  });
  
  if (withdrawEvent) {
    const parsed = vault.interface.parseLog({
      topics: withdrawEvent.topics as string[],
      data: withdrawEvent.data
    });
    console.log("\nTokens received:");
    const amounts = parsed?.args[2];
    for (let i = 0; i < amounts.length; i++) {
      console.log(`- Token ${i}: ${amounts[i]}`);
    }
  }
  
  // Final share balance
  const finalShares = await vault.balanceOf(signer.address);
  console.log("\nRemaining shares:", ethers.formatEther(finalShares));
}

main().catch(console.error);
