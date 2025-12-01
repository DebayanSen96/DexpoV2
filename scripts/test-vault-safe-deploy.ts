import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

const TOKEN_ADDRESS = "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4"; // USDC on Base Sepolia
const SPENDER_ADDRESS = "0xC7ab880FE31B36eaF606b9a68e47a9AAbB5fb17B"; // Random spender for testing

// Existing smart account to test
const EXISTING_VAULT_SAFE = "0xe38e04dd16edc00ace2292fd764532b0aae4a67c";

async function main() {
  // Use the owner's private key (0xf9d676bec8210ba4f5c080fabd13add8c9d407f7)
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    throw new Error("PRIVATE_KEY not set in .env");
  }

  console.log("Network:", network.name);

  const provider = ethers.provider;
  const wallet = new ethers.Wallet(pk, provider);

  console.log("Signer:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH");

  // Check if contract exists
  const code = await provider.getCode(EXISTING_VAULT_SAFE);
  console.log("\nVaultSafe bytecode length:", code.length);
  if (code === "0x" || code.length < 100) {
    throw new Error("No contract deployed at VaultSafe address!");
  }

  const vaultSafe = await ethers.getContractAt("VaultSafe", EXISTING_VAULT_SAFE, wallet);
  const vaultSafeAddress = EXISTING_VAULT_SAFE;

  // Step 1: Verify deployment
  console.log("\n=== Step 1: Verify VaultSafe ===");
  console.log("VaultSafe Address:", vaultSafeAddress);
  
  const deployedThreshold = await vaultSafe.threshold();
  const isOwner = await vaultSafe.isOwner(wallet.address);
  
  console.log("  threshold:", deployedThreshold.toString());
  console.log("  isOwner(" + wallet.address + "):", isOwner);

  if (!isOwner) {
    throw new Error("Signer is not an owner of this VaultSafe!");
  }

  // Step 2: Check USDC balance
  console.log("\n=== Step 2: Check USDC Balance ===");
  const usdc = await ethers.getContractAt("IERC20Metadata", TOKEN_ADDRESS, wallet);
  const decimals = await usdc.decimals();
  
  const vaultBalance = await usdc.balanceOf(vaultSafeAddress);
  console.log("  VaultSafe USDC balance:", ethers.formatUnits(vaultBalance, decimals));

  // Step 3: Test submitTransaction with approve
  console.log("\n=== Step 3: Test Approval via submitTransaction ===");
  
  const approveAmount = ethers.parseUnits("50", decimals); // Approve 50 USDC
  const approveData = usdc.interface.encodeFunctionData("approve", [SPENDER_ADDRESS, approveAmount]);
  
  console.log("  Target:", TOKEN_ADDRESS);
  console.log("  Spender:", SPENDER_ADDRESS);
  console.log("  Amount:", ethers.formatUnits(approveAmount, decimals), "USDC");
  console.log("  Encoded data:", approveData);
  
  console.log("\nSubmitting transaction...");
  const submitTx = await vaultSafe.submitTransaction(TOKEN_ADDRESS, 0, approveData);
  const receipt = await submitTx.wait();
  
  console.log("✅ Transaction submitted!");
  console.log("  Tx hash:", receipt?.hash);
  console.log("  Gas used:", receipt?.gasUsed?.toString());
  
  // Parse events
  console.log("\n  Events emitted:");
  for (const log of receipt?.logs || []) {
    try {
      const parsed = vaultSafe.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed) {
        console.log("    -", parsed.name);
      }
    } catch (e) {
      // Not a VaultSafe event
    }
  }

  // Step 4: Verify the approval was set
  console.log("\n=== Step 4: Verify Approval ===");
  
  // Wait for blockchain to process
  console.log("  Waiting 5 seconds for blockchain to process...");
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const allowance = await usdc.allowance(vaultSafeAddress, SPENDER_ADDRESS);
  console.log("  Allowance:", ethers.formatUnits(allowance, decimals), "USDC");
  
  if (allowance >= approveAmount) {
    console.log("✅ SUCCESS! Approval was set correctly!");
  } else {
    console.log("❌ FAILED! Allowance not set as expected");
    
    // Double check after more time
    console.log("  Waiting another 5 seconds...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    const allowance2 = await usdc.allowance(vaultSafeAddress, SPENDER_ADDRESS);
    console.log("  Allowance (retry):", ethers.formatUnits(allowance2, decimals), "USDC");
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log("VaultSafe Address:", vaultSafeAddress);
  console.log("Owner:", wallet.address);
  console.log("USDC Balance:", ethers.formatUnits(vaultBalance, decimals));
  console.log("Approval to", SPENDER_ADDRESS + ":", ethers.formatUnits(allowance, decimals), "USDC");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
