import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

// === CONFIG ===
const VAULT_SAFE_ADDRESS = "0xccb21309c2c7d866f05a74dcd6b10b24a63f5db8"; // Smart account
const TOKEN_ADDRESS = "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4";      // USDC on Base Sepolia
const SPENDER_ADDRESS = "0xf9d676bec8210ba4f5c080fabd13add8c9d407f7";     // Example: ownerEOA as spender
const APPROVE_AMOUNT_USDC = "1000";                                        // 1000 USDC

const VAULT_SAFE_ABI = [
  "function isOwner(address) view returns (bool)",
  "function threshold() view returns (uint256)",
  "function protocolCore() view returns (address)",
  "function submitTransaction(address to, uint256 value, bytes data) returns (bytes32)",
  "function owners(uint256) view returns (address)"
];

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    throw new Error("PRIVATE_KEY not set in .env");
  }

  console.log("Network:", network.name);

  const provider = ethers.provider;
  const wallet = new ethers.Wallet(pk, provider);

  console.log("Using signer:", wallet.address);

  // Check if contract exists
  const code = await provider.getCode(VAULT_SAFE_ADDRESS);
  console.log("VaultSafe bytecode length:", code.length);
  if (code === "0x") {
    throw new Error("No contract deployed at VaultSafe address!");
  }

  const vaultSafe = new ethers.Contract(VAULT_SAFE_ADDRESS, VAULT_SAFE_ABI, wallet);
  
  // Check if signer is an owner
  const isOwner = await vaultSafe.isOwner(wallet.address);
  console.log("Is signer an owner of VaultSafe?", isOwner);
  
  // Check threshold
  const threshold = await vaultSafe.threshold();
  console.log("VaultSafe threshold:", threshold.toString());
  
  // Check protocolCore
  try {
    const protocolCore = await vaultSafe.protocolCore();
    console.log("VaultSafe protocolCore:", protocolCore);
  } catch (e) {
    console.log("VaultSafe protocolCore: (not available or different ABI)");
  }
  
  if (!isOwner) {
    throw new Error(`Signer ${wallet.address} is not an owner of VaultSafe ${VAULT_SAFE_ADDRESS}`);
  }

  const erc20 = await ethers.getContractAt("IERC20Metadata", TOKEN_ADDRESS, wallet);

  const decimals = await erc20.decimals();
  const amount = ethers.parseUnits(APPROVE_AMOUNT_USDC, decimals);

  console.log("Preparing approve() call:");
  console.log("  Token:", TOKEN_ADDRESS);
  console.log("  Spender:", SPENDER_ADDRESS);
  console.log("  Amount:", APPROVE_AMOUNT_USDC, "USDC");

  // Check VaultSafe balance
  const vaultBalance = await erc20.balanceOf(VAULT_SAFE_ADDRESS);
  console.log("  VaultSafe USDC balance:", ethers.formatUnits(vaultBalance, decimals));

  const data = erc20.interface.encodeFunctionData("approve", [SPENDER_ADDRESS, amount]);
  console.log("  Encoded data:", data);

  console.log("Submitting transaction via VaultSafe.submitTransaction...");
  try {
    console.log("  Calling submitTransaction with:");
    console.log("    to:", TOKEN_ADDRESS);
    console.log("    value:", 0);
    console.log("    data:", data);
    
    // Try with staticCall first to see the error
    try {
      await vaultSafe.submitTransaction.staticCall(TOKEN_ADDRESS, 0, data);
      console.log("  staticCall succeeded, proceeding with actual tx...");
    } catch (staticErr: any) {
      console.error("  staticCall failed:", staticErr.message);
      if (staticErr.data) {
        console.error("  Error data:", staticErr.data);
      }
    }
    
    const tx = await vaultSafe.submitTransaction(TOKEN_ADDRESS, 0, data, { gasLimit: 500000 });
    console.log("Tx sent:", tx.hash);
    const receipt = await tx.wait();
    console.log("✅ Tx confirmed:", receipt?.hash);
    console.log("Gas used:", receipt?.gasUsed?.toString());
  } catch (error: any) {
    console.error("❌ Error:", error.shortMessage || error.message);
  }

  // For threshold == 1, VaultSafe executes internally inside submitTransaction.
  // For higher thresholds, this script at least records the transaction on-chain.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});