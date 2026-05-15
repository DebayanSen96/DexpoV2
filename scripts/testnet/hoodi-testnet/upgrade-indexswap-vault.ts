import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type DeploymentState = {
  deployer?: string;
  protocolCore?: string;
  indexSwapImplementation?: string;
  indexSwapFactory?: string;
  csmVault?: string;
};

const DEFAULT_TARGET_VAULT = "0xdc96a4a44c057d2cf9789cbfa46862aadd6d14f2";

function statePath(): string {
  return path.join(__dirname, "..", "..", "..", "deployments", "testnet", "hoodi-testnet.json");
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

function parseVaults(value: string | undefined, fallback: string): string[] {
  const raw = value?.trim() || fallback;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function main() {
  const state = loadState();
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  const targetVaults = parseVaults(process.env.TARGET_VAULTS || process.env.TARGET_VAULT, DEFAULT_TARGET_VAULT);
  const updateFactoryImplementation = parseBool(process.env.UPDATE_FACTORY_IMPLEMENTATION, true);
  const upgradeVaultProxies = parseBool(process.env.UPGRADE_VAULT_PROXIES || process.env.UPGRADE_VAULT_PROXY, true);

  if (!state.protocolCore) throw new Error("Missing protocolCore in deployment state");
  if (!state.indexSwapFactory) throw new Error("Missing indexSwapFactory in deployment state");

  console.log(`Network: ${network.name}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`ProtocolCore: ${state.protocolCore}`);
  console.log(`IndexSwapFactory: ${state.indexSwapFactory}`);
  console.log(`Target vaults: ${targetVaults.join(", ")}`);

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
    "contracts/v3/testnet/hoodi-testnet/vault/HoodiTestnetIndexSwapV3.sol:HoodiTestnetIndexSwapV3"
  );
  const implementation = await implFactory.deploy();
  await implementation.waitForDeployment();
  const newImplementation = await implementation.getAddress();
  console.log(`New implementation: ${newImplementation}`);

  if (updateFactoryImplementation) {
    const factory = await ethers.getContractAt(
      [
        "function owner() view returns (address)",
        "function setImplementation(address) external",
        "function implementation() view returns (address)",
      ],
      state.indexSwapFactory,
      deployer
    );
    const factoryOwner = await factory.owner();
    if (factoryOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
      throw new Error(`Deployer ${deployerAddress} is not IndexSwapFactory owner ${factoryOwner}`);
    }

    const currentImplementation = await factory.implementation();
    if (currentImplementation.toLowerCase() !== newImplementation.toLowerCase()) {
      const tx = await factory.setImplementation(newImplementation);
      console.log(`Factory update tx: ${tx.hash}`);
      await tx.wait();
    }
  }

  if (upgradeVaultProxies) {
    for (const targetVault of targetVaults) {
      const vault = await ethers.getContractAt(
        ["function upgradeToAndCall(address newImplementation, bytes data) external"],
        targetVault,
        deployer
      );
      const tx = await vault.upgradeToAndCall(newImplementation, "0x");
      console.log(`Vault ${targetVault} upgrade tx: ${tx.hash}`);
      await tx.wait();
    }
  }

  state.indexSwapImplementation = newImplementation;
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));

  console.log("Hoodi IndexSwap upgrade flow complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
