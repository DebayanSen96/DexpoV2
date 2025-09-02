import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

// Minimal IOwnable ABI
const OWNABLE_ABI = [
  "function owner() view returns (address)"
];

// Default Hardhat mnemonic (public)
const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";

async function deriveLocalAccounts(limit = 20): Promise<{ address: string; privateKey: string }[]> {
  // In ethers v6, fromPhrase defaults to depth 5 (m/44'/60'/0'/0/0). We want the account branch root
  // so specify the path and then derive children by index without a root 'm/'.
  const root = ethers.HDNodeWallet.fromPhrase(DEFAULT_MNEMONIC, undefined, "m/44'/60'/0'/0");
  const accounts: { address: string; privateKey: string }[] = [];
  for (let i = 0; i < limit; i++) {
    const wallet = root.deriveChild(i);
    accounts.push({ address: wallet.address, privateKey: wallet.privateKey });
  }
  return accounts;
}

async function main() {
  // Prefer localhost deployments file explicitly
  const localhostPath = path.join(__dirname, "../deployments", "localhost", "localhost.json");
  const networkPath = path.join(__dirname, "../deployments", network.name, `${network.name}.json`);
  const deploymentsPath = fs.existsSync(localhostPath) ? localhostPath : networkPath;
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(`Deployments file not found. Checked: ${localhostPath} and ${networkPath}`);
  }

  const deployed = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));

  const protocolCoreAddr: string = deployed.contracts?.ProtocolCore;
  const bluechipRouterAddr: string = deployed.contracts?.vaults?.bluechip?.StrategyRouter;

  if (!protocolCoreAddr) throw new Error("ProtocolCore address missing in deployments file");
  if (!bluechipRouterAddr) throw new Error("Bluechip StrategyRouter address missing in deployments file");

  const provider = ethers.provider;
  const protocolCore = new ethers.Contract(protocolCoreAddr, OWNABLE_ABI, provider);
  const bluechipRouter = new ethers.Contract(bluechipRouterAddr, OWNABLE_ABI, provider);

  const protocolOwner: string = await protocolCore.owner();
  const farmOwner: string = await bluechipRouter.owner();

  // Map to local private keys if running on hardhat
  const derived = await deriveLocalAccounts(50);
  const findPK = (addr: string) => derived.find(a => a.address.toLowerCase() === addr.toLowerCase())?.privateKey;

  const protocolOwnerPK = findPK(protocolOwner);
  const farmOwnerPK = findPK(farmOwner);

  console.log("Dual-signature roles required by BluechipIndexAdapter.authorizedSwap():");
  console.log(`Using deployments file: ${deploymentsPath}`);
  console.log("");
  console.log("- Protocol Owner (owner of ProtocolCore)");
  console.log(`  Contract ProtocolCore: ${protocolCoreAddr}`);
  console.log(`  owner(): ${protocolOwner}`);
  console.log(`  privateKey (if local hardhat): ${protocolOwnerPK ?? "<not a default local account>"}`);
  console.log("");
  console.log("- Farm Owner (owner of StrategyRouter for Bluechip vault)");
  console.log(`  Contract StrategyRouter (bluechip): ${bluechipRouterAddr}`);
  console.log(`  owner(): ${farmOwner}`);
  console.log(`  privateKey (if local hardhat): ${farmOwnerPK ?? "<not a default local account>"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
