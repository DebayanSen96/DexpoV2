import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "dotenv/config";

const networks: HardhatUserConfig["networks"] = {
  hardhat: {
    allowUnlimitedContractSize: true,
  },
  sepolia: {
    url: process.env.SEPOLIA_RPC_URL || "https://eth-sepolia.public.blastapi.io",
    accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    chainId: 11155111,
  },
  "base-sepolia": {
    url: "https://sepolia.base.org", // Replace with your actual RPC URL
    accounts: ["8c94cd0dba51e5ebe7a4bb7efc3a5a577ff8e66d9c3e28e1448d468e8055402c"], // Replace with your actual private key
    chainId: 84532
  },
  "monad-testnet": {
    // Official RPC and chainId from Monad docs
    url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
    accounts: ["8c94cd0dba51e5ebe7a4bb7efc3a5a577ff8e66d9c3e28e1448d468e8055402c"],
    chainId: 10143,
  },
  "hyperliquid-testnet": {
    url: process.env.HYPERLIQUID_TESTNET_RPC_URL || "https://rpc.hyperliquid-testnet.xyz/evm",
    accounts: process.env.HYPERLIQUID_PRIVATE_KEY
      ? [process.env.HYPERLIQUID_PRIVATE_KEY]
      : (process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []),
    chainId: 998,
  },
  "ethereum-hoodi": {
    url: process.env.HOODI_RPC_URL || "https://ethereum-hoodi-rpc.publicnode.com",
    accounts: ["2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca"],
    chainId: 560048,
  },
};

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 50 },
          metadata: { bytecodeHash: "none" },
        },
      },
      {
        version: "0.8.24",
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 1 },
          metadata: { bytecodeHash: "none" },
        },
      },
      {
        version: "0.8.17",
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 50 },
          metadata: { bytecodeHash: "none" },
        },
      },
    ],
    overrides: {
      "contracts/ProtocolCore.sol": {
        version: "0.8.24",
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 1 },
          metadata: { bytecodeHash: "none" },
          debug: { revertStrings: "strip" },
        },
      },
      // Reduce bytecode size for heavy V3 contracts (deployment networks enforce size limits)
      "contracts/v3/farm/BaseFarm.sol": {
        version: "0.8.24",
        settings: {
          viaIR: false,
          optimizer: { enabled: true, runs: 200 },
          metadata: { bytecodeHash: "none" },
          debug: { revertStrings: "strip" },
        },
      },
      "contracts/v3/strategies/StrategyRouter.sol": {
        version: "0.8.24",
        settings: {
          viaIR: false,
          optimizer: { enabled: true, runs: 200 },
          metadata: { bytecodeHash: "none" },
          debug: { revertStrings: "strip" },
        },
      },
      "contracts/v3/modules/PayoutPolicy.sol": {
        version: "0.8.24",
        settings: {
          viaIR: false,
          optimizer: { enabled: true, runs: 200 },
          metadata: { bytecodeHash: "none" },
          debug: { revertStrings: "strip" },
        },
      },
      "contracts/v3/modules/LockupPolicy.sol": {
        version: "0.8.24",
        settings: {
          viaIR: false,
          optimizer: { enabled: true, runs: 200 },
          metadata: { bytecodeHash: "none" },
          debug: { revertStrings: "strip" },
        },
      },
      "contracts/v3/modules/StakeholderRegistry.sol": {
        version: "0.8.24",
        settings: {
          viaIR: false,
          optimizer: { enabled: true, runs: 200 },
          metadata: { bytecodeHash: "none" },
          debug: { revertStrings: "strip" },
        },
      },
      "contracts/v3/factories/FarmFactory.sol": {
        version: "0.8.24",
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 1 },
          metadata: { bytecodeHash: "none" },
          debug: { revertStrings: "strip" },
        },
      },
    },
  },
  networks,
};

export default config;
