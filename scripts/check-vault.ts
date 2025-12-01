import { ethers } from "hardhat";

async function main() {
  const vaultAddress = "0x795a0A214cBA086CF8d5C30bf83C057233EFF41E";
  const testWallet = "0x578636C1CDfd5BCA3F1e787Fa49c2ea664c7bd8C";
  
  const vault = await ethers.getContractAt("IndexSwap", vaultAddress);
  
  console.log("Vault:", vaultAddress);
  console.log("Test Wallet:", testWallet);
  
  const shares = await vault.balanceOf(testWallet);
  console.log("\nShares:", ethers.formatEther(shares));
  
  const totalSupply = await vault.totalSupply();
  console.log("Total Supply:", ethers.formatEther(totalSupply));
  
  const tvl = await vault.getTotalValueUsd();
  console.log("TVL:", ethers.formatEther(tvl), "USD");
  
  const portfolio = await vault.getPortfolio();
  console.log("\nPortfolio:");
  
  const tokens = {
    "0x822f6bB6ba99a45F12D2d8E44CCE089B7AA47fC4": { symbol: "USDC", decimals: 6 },
    "0x5355419854236B3D9c0675a87Fa560F230127663": { symbol: "DAI", decimals: 18 },
    "0x1D196BCE6Bbea402fEF328AB1Ac50C971497173D": { symbol: "USDT", decimals: 6 },
    "0xe50E303b29aB28181460D335a1186033Af24Bf82": { symbol: "USDx", decimals: 18 }
  };
  
  for (let i = 0; i < portfolio.length; i++) {
    const token = portfolio[i][0];
    const weight = portfolio[i][1];
    const tokenContract = await ethers.getContractAt("IERC20", token);
    const balance = await tokenContract.balanceOf(vaultAddress);
    const tokenInfo = tokens[token.toLowerCase()] || tokens[token];
    const symbol = tokenInfo?.symbol || "Unknown";
    const decimals = tokenInfo?.decimals || 18;
    console.log(`  ${symbol}: ${ethers.formatUnits(balance, decimals)} (weight: ${Number(weight)/100}%)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
