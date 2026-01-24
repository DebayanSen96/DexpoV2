import { ethers } from "hardhat";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  CHAINLINK_USDC_USD: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
};

async function main() {
  console.log("Checking Chainlink USDC/USD feed directly...");
  
  const feedAbi = [
    "function decimals() external view returns (uint8)",
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
  ];
  
  const feed = await ethers.getContractAt(feedAbi, BASE_MAINNET.CHAINLINK_USDC_USD);
  
  const decimals = await feed.decimals();
  console.log("Decimals:", decimals);
  
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = await feed.latestRoundData();
  console.log("Round ID:", roundId.toString());
  console.log("Answer:", answer.toString());
  console.log("Price:", ethers.formatUnits(answer, decimals), "USD");
  console.log("Updated At:", new Date(Number(updatedAt) * 1000).toISOString());
  console.log("Age (seconds):", Math.floor(Date.now() / 1000) - Number(updatedAt));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
