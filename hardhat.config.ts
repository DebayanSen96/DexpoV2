import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "dotenv/config";

const networks: HardhatUserConfig["networks"] = {
  hardhat: {
    allowUnlimitedContractSize: true,
  },
  "base-sepolia": {
    url: "https://sepolia.base.org", // Replace with your actual RPC URL
    accounts: ["0x6e748857c30404a686a96457624bffc3e3f06346a29c7d808671687dcdc7a34b"], // Replace with your actual private key
    chainId: 84532
  },
  "monad-testnet": {
    // Official RPC and chainId from Monad docs
    url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
    accounts: ["8c94cd0dba51e5ebe7a4bb7efc3a5a577ff8e66d9c3e28e1448d468e8055402c"],
    chainId: 10143,
  },
};

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } },
      },
      {
        version: "0.8.24",
        settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } },
      },
      {
        version: "0.8.17",
        settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },
  networks,
};

export default config;
