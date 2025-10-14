import hre from "hardhat";

// Configure these as needed
const TOKEN_ADDRESS = "0xFc411f933b84B8762d90ea699D7Ec82b10400912"; // USDX on base-sepolia (given)
const DEFAULT_CLAIM_HUMAN = "100"; // 100 tokens per claim
const DEFAULT_COOLDOWN_SECONDS = 8 * 60 * 60; // 8 hours
const OPTIONAL_FUND_HUMAN = "1000000"; // 1,000,000 tokens to fund faucet (optional)

// Minimal ERC20 metadata ABI (decimals + transfer)
const ERC20_METADATA_ABI = [
  { inputs: [], name: "decimals", outputs: [{ internalType: "uint8", name: "", type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "transfer", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "", type: "address" }], name: "balanceOf", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

async function main() {
  const { ethers, network } = hre as any;
  console.log("Network:", (network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat");

  if (!ethers.isAddress(TOKEN_ADDRESS)) {
    throw new Error(`Invalid TOKEN_ADDRESS: ${TOKEN_ADDRESS}`);
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("Deployer:", deployerAddress);

  const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_METADATA_ABI, deployer);
  const decimals: number = Number(await token.decimals());
  const claimAmount = ethers.parseUnits(DEFAULT_CLAIM_HUMAN, decimals);
  const cooldown = DEFAULT_COOLDOWN_SECONDS;

  console.log("Deploying DXPFaucet with:");
  console.log("  token:", TOKEN_ADDRESS);
  console.log("  claim:", DEFAULT_CLAIM_HUMAN, `(decimals=${decimals})`);
  console.log("  cooldown:", cooldown, "seconds");

  const FaucetF = await ethers.getContractFactory("contracts/libraries/testnet/DXPFaucet.sol:DXPFaucet");
  const faucet = await FaucetF.deploy(TOKEN_ADDRESS, claimAmount, cooldown);
  await faucet.waitForDeployment();
  const faucetAddr = await faucet.getAddress();
  console.log("DXPFaucet deployed at:", faucetAddr);

  // Optional funding step: send tokens from deployer to faucet
  try {
    const fundAmount = ethers.parseUnits(OPTIONAL_FUND_HUMAN, decimals);
    console.log(`Funding faucet with ${OPTIONAL_FUND_HUMAN} tokens...`);
    const balBefore: bigint = await token.balanceOf(faucetAddr);
    const tx = await token.transfer(faucetAddr, fundAmount);
    console.log("  transfer tx:", tx.hash);
    await tx.wait();
    const balAfter: bigint = await token.balanceOf(faucetAddr);
    console.log("  faucet balance:", ethers.formatUnits(balBefore, decimals), "->", ethers.formatUnits(balAfter, decimals));
  } catch (e) {
    console.warn("Skipping funding step (transfer may have failed due to insufficient balance or non-mintable token)");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
