import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";

const networks: HardhatUserConfig["networks"] = {
  hardhat: {
    allowUnlimitedContractSize: true,
  },
  "base-sepolia": {
    url: "https://sepolia.base.org", // Replace with your actual RPC URL
    accounts: ["0x6e748857c30404a686a96457624bffc3e3f06346a29c7d808671687dcdc7a34b"], // Replace with your actual private key
    chainId: 84532
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
