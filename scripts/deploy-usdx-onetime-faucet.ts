import hre from "hardhat";

// Config
const TOKEN_ADDRESS = "0xFc411f933b84B8762d90ea699D7Ec82b10400912"; // USDX on base-sepolia
const CLAIM_HUMAN = "100000"; // 100,000 tokens (one-time)
const OPTIONAL_FUND_HUMAN = "5000000"; // 5,000,000 tokens funding (optional)

const ERC20_METADATA_ABI = [
  { inputs: [], name: "decimals", outputs: [{ internalType: "uint8", name: "", type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "transfer", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "", type: "address" }], name: "balanceOf", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

async function main() {
  const { ethers, network } = hre as any;
  console.log("Network:", (network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat");

  if (!ethers.isAddress(TOKEN_ADDRESS)) throw new Error(`Invalid TOKEN_ADDRESS: ${TOKEN_ADDRESS}`);

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("Deployer:", deployerAddress);

  const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_METADATA_ABI, deployer);
  const decimals: number = Number(await token.decimals());
  const claimAmount = ethers.parseUnits(CLAIM_HUMAN, decimals);

  console.log("Deploying USDXOneTimeFaucet...");
  const FaucetF = await ethers.getContractFactory("contracts/libraries/testnet/USDXOneTimeFaucet.sol:USDXOneTimeFaucet");
  const faucet = await FaucetF.deploy(TOKEN_ADDRESS, claimAmount);
  await faucet.waitForDeployment();
  const faucetAddr = await faucet.getAddress();
  console.log("USDXOneTimeFaucet deployed at:", faucetAddr);

  // Optional funding
  try {
    const fundAmount = ethers.parseUnits(OPTIONAL_FUND_HUMAN, decimals);
    console.log(`Funding faucet with ${OPTIONAL_FUND_HUMAN} USDX...`);
    const balBefore: bigint = await token.balanceOf(faucetAddr);
    const tx = await token.transfer(faucetAddr, fundAmount);
    console.log("  transfer tx:", tx.hash);
    await tx.wait();
    const balAfter: bigint = await token.balanceOf(faucetAddr);
    console.log("  faucet balance:", ethers.formatUnits(balBefore, decimals), "->", ethers.formatUnits(balAfter, decimals));
  } catch (e) {
    console.warn("Skipping funding step (insufficient balance or non-mintable token)");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
