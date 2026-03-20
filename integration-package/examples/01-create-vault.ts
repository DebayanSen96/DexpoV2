import { ethers } from "ethers";

/**
 * Example: Create a new IndexSwapV3 vault via ProtocolCore
 * 
 * This script demonstrates how to deploy a new vault with a custom portfolio
 * of tokens and weights.
 */

// Configuration
const RPC_URL = "https://sepolia.base.org";
const PROTOCOL_CORE_ADDRESS = "0xd080d29eAfEe778f6E348D6B75b631674BBF9A43";
const PRIVATE_KEY = "YOUR_PRIVATE_KEY_HERE"; // Protocol owner wallet

// Portfolio configuration
const PORTFOLIO = [
  {
    token: "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4", // USDC
    weightBps: 5000 // 50%
  },
  {
    token: "0x3aAbBC9464fAA82B99c92b69A021FC8B4b639c4F", // WETH
    weightBps: 5000 // 50%
  }
];

const PROTOCOL_CORE_ABI = [
  "function createIndexSwapVault(address safe, string memory name, string memory symbol, tuple(address token, uint256 weightBps)[] memory portfolio, uint256 managementFee, uint256 performanceFee) external returns (address)",
  "event IndexSwapVaultCreated(address indexed safe, address indexed indexSwap, string name, string symbol)"
];

async function main() {
  // Setup provider and signer
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log("Creating vault from:", signer.address);
  
  // Connect to ProtocolCore
  const protocolCore = new ethers.Contract(
    PROTOCOL_CORE_ADDRESS,
    PROTOCOL_CORE_ABI,
    signer
  );
  
  // Create vault
  const tx = await protocolCore.createIndexSwapVault(
    signer.address,           // safe (vault owner)
    "My Index Vault",         // name
    "MIV",                    // symbol
    PORTFOLIO,                // portfolio
    0,                        // managementFee (0 bps = 0%)
    1000                      // performanceFee (1000 bps = 10%)
  );
  
  console.log("Transaction hash:", tx.hash);
  
  // Wait for confirmation
  const receipt = await tx.wait();
  console.log("Vault created! Block:", receipt.blockNumber);
  
  // Parse event to get vault address
  const event = receipt.logs.find((log: any) => {
    try {
      const parsed = protocolCore.interface.parseLog({
        topics: log.topics as string[],
        data: log.data
      });
      return parsed?.name === "IndexSwapVaultCreated";
    } catch {
      return false;
    }
  });
  
  if (event) {
    const parsed = protocolCore.interface.parseLog({
      topics: event.topics as string[],
      data: event.data
    });
    console.log("Vault address:", parsed?.args[1]);
  }
}

main().catch(console.error);
