import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable } from "hardhat/config";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
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
      production: {
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
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },
};

export default config;
