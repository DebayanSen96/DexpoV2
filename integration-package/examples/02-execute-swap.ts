import { ethers } from "ethers";

/**
 * Example: Execute a token swap via MockSwapRouter
 * 
 * This demonstrates how to swap tokens using the mock swap infrastructure.
 * In production, this would use real DEX routers.
 */

// Configuration
const RPC_URL = "https://sepolia.base.org";
const MOCK_SWAP_ROUTER = "0x706c3bA805980B692f1E48161213153c179C9dC1";
const PRIVATE_KEY = "YOUR_PRIVATE_KEY_HERE";

// Token addresses
const USDC = "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4";
const WETH = "0x3aAbBC9464fAA82B99c92b69A021FC8B4b639c4F";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
];

const SWAP_ROUTER_ABI = [
  "function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut)",
  "function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient) external returns (uint256 amountOut)",
  "event Swap(address indexed sender, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address recipient)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log("Swapping from:", signer.address);
  
  // Connect to contracts
  const usdcToken = new ethers.Contract(USDC, ERC20_ABI, signer);
  const router = new ethers.Contract(MOCK_SWAP_ROUTER, SWAP_ROUTER_ABI, signer);
  
  // Amount to swap (100 USDC)
  const amountIn = ethers.parseUnits("100", 6); // USDC has 6 decimals
  
  // Step 1: Get quote
  console.log("\n1. Getting quote...");
  const expectedOut = await router.quote(USDC, WETH, amountIn);
  console.log("Expected WETH out:", ethers.formatEther(expectedOut));
  
  // Step 2: Approve router to spend USDC
  console.log("\n2. Approving USDC...");
  const approveTx = await usdcToken.approve(MOCK_SWAP_ROUTER, amountIn);
  await approveTx.wait();
  console.log("Approved!");
  
  // Step 3: Execute swap
  console.log("\n3. Executing swap...");
  const swapTx = await router.swap(
    USDC,           // tokenIn
    WETH,           // tokenOut
    amountIn,       // amountIn
    signer.address  // recipient
  );
  
  console.log("Swap tx:", swapTx.hash);
  const receipt = await swapTx.wait();
  console.log("Swap completed! Block:", receipt.blockNumber);
  
  // Parse swap event
  const swapEvent = receipt.logs.find((log: any) => {
    try {
      const parsed = router.interface.parseLog({
        topics: log.topics as string[],
        data: log.data
      });
      return parsed?.name === "Swap";
    } catch {
      return false;
    }
  });
  
  if (swapEvent) {
    const parsed = router.interface.parseLog({
      topics: swapEvent.topics as string[],
      data: swapEvent.data
    });
    console.log("\nSwap details:");
    console.log("- Amount in:", ethers.formatUnits(parsed?.args[3], 6), "USDC");
    console.log("- Amount out:", ethers.formatEther(parsed?.args[4]), "WETH");
  }
}

main().catch(console.error);
