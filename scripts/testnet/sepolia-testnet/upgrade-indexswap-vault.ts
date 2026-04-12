import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type DeploymentState = {
  deployer?: string;
  protocolCore?: string;
  mockSwapRouter?: string;
  indexSwapImplementation?: string;
  indexSwapFactory?: string;
};

const DEFAULT_TARGET_VAULT = "0x03838644433d83a2a8abb5cec9b8e7a3e171fc81";

function statePath(): string {
  return path.join(__dirname, "..", "..", "..", "deployments", "testnet", `${network.name}.json`);
}

function loadState(): DeploymentState {
  const file = statePath();
  if (!fs.existsSync(file)) {
    throw new Error(`Deployment state not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentState;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

async function main() {
  const state = loadState();
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const targetVault = (process.env.TARGET_VAULT || DEFAULT_TARGET_VAULT).trim();
  const updateFactoryImplementation = parseBool(process.env.UPDATE_FACTORY_IMPLEMENTATION, true);
  const upgradeVaultProxy = parseBool(process.env.UPGRADE_VAULT_PROXY, true);

  if (!state.protocolCore) throw new Error("Missing protocolCore in deployment state");
  if (!state.indexSwapFactory) throw new Error("Missing indexSwapFactory in deployment state");

  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`ProtocolCore: ${state.protocolCore}`);
  console.log(`IndexSwapFactory: ${state.indexSwapFactory}`);
  console.log(`MockSwapRouter (preserved): ${state.mockSwapRouter || "unknown"}`);
  console.log(`Target vault: ${targetVault}`);

  const protocolCore = await ethers.getContractAt(
    ["function owner() view returns (address)"],
    state.protocolCore,
    deployer
  );
  const protocolOwner = await protocolCore.owner();
  if (protocolOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(`Deployer ${deployerAddress} is not ProtocolCore owner ${protocolOwner}`);
  }

  const implFactory = await ethers.getContractFactory(
    "contracts/v3/testnet/sepolia-testnet/vault/SepoliaTestnetIndexSwapV3.sol:SepoliaTestnetIndexSwapV3"
  );
  const implementation = await implFactory.deploy();
  await implementation.waitForDeployment();
  const newImplementation = await implementation.getAddress();
  console.log(`New implementation: ${newImplementation}`);

  if (updateFactoryImplementation) {
    const factory = await ethers.getContractAt(
      ["function setImplementation(address) external", "function implementation() view returns (address)"],
      state.indexSwapFactory,
      deployer
    );
    const currentImplementation = await factory.implementation();
    if (currentImplementation.toLowerCase() !== newImplementation.toLowerCase()) {
      const tx = await factory.setImplementation(newImplementation);
      console.log(`Factory update tx: ${tx.hash}`);
      await tx.wait();
    }
  }

  if (upgradeVaultProxy) {
    const vault = await ethers.getContractAt(
      ["function upgradeToAndCall(address newImplementation, bytes data) external"],
      targetVault,
      deployer
    );
    const tx = await vault.upgradeToAndCall(newImplementation, "0x");
    console.log(`Vault upgrade tx: ${tx.hash}`);
    await tx.wait();
  }

  state.indexSwapImplementation = newImplementation;
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));

  console.log("Upgrade flow complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
