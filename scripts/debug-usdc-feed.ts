import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const BASE_MAINNET = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  CHAINLINK_USDC_USD: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
};

async function main() {
  const [signer] = await ethers.getSigners();
  
  const deploymentPath = path.join(__dirname, "..", "deployments", "v3-latest", "base-mainnet.json");
  const state = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  
  const oracle = await ethers.getContractAt(
    "contracts/v3/mainnet/oracles/ChainlinkOracle.sol:ChainlinkOracle",
    state.chainlinkOracle,
    signer
  );
  
  console.log("\n--- Direct Chainlink Feed Test ---");
  
  const feedContract = await ethers.getContractAt(
    ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"],
    BASE_MAINNET.CHAINLINK_USDC_USD,
    signer
  );
  
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = await feedContract.latestRoundData();
  const decimals = await feedContract.decimals();
  
  console.log("Round ID:", roundId.toString());
  console.log("Answer:", answer.toString());
  console.log("Started At:", startedAt.toString());
  console.log("Updated At:", updatedAt.toString());
  console.log("Answered In Round:", answeredInRound.toString());
  console.log("Decimals:", decimals.toString());
  
  const now = Math.floor(Date.now() / 1000);
  const age = now - Number(updatedAt.toString());
  console.log("\nCurrent timestamp:", now);
  console.log("Age of price:", age, "seconds (", (age / 3600).toFixed(2), "hours)");
  
  const threshold = await oracle.defaultStaleThreshold();
  console.log("Stale threshold:", threshold.toString(), "seconds");
  
  console.log("\nIs stale?", age > Number(threshold.toString()));
  
  console.log("\n--- Calling oracle.getPrice directly ---");
  try {
    const [price, dec] = await oracle.getPrice(BASE_MAINNET.USDC);
    console.log("Price:", price.toString());
    console.log("Decimals:", dec.toString());
  } catch (e: any) {
    console.log("Error:", e.message);
    if (e.data) {
      console.log("Error data:", e.data);
    }
  }
}

main().catch(console.error);
