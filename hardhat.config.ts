import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";

const networks: HardhatUserConfig["networks"] = {
  hardhat: {
    allowUnlimitedContractSize: true,
  },
};

if (process.env.SEPOLIA_RPC_URL) {
  networks.sepolia = {
    url: "https://sepolia.base.org",
    accounts: ["8c94cd0dba51e5ebe7a4bb7efc3a5a577ff8e66d9c3e28e1448d468e8055402c"],
  };
}

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
