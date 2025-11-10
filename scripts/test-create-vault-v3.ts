import hre from "hardhat";
import { readFile } from "fs/promises";
import { join } from "path";
import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers";

function env(name: string, def?: string): string | undefined {
  return process.env[name] ?? def;
}

async function main() {
  const { ethers } = hre as any;
  const network: string = ((hre as any).network?.name as string) || process.env.HARDHAT_NETWORK || "hardhat";
  console.log("Network:", network);

  const deployPath = join("deployments", network, `${network}.json`);
  const raw = await readFile(deployPath, "utf-8");
  const dep = JSON.parse(raw);

  const coreAddr: string = dep.contracts?.ProtocolCore;
  const factoryAddr: string = dep.contracts?.VaultFactory;
  const dxpAddr: string = dep.contracts?.DXPToken;
  const routerAddr: string | undefined = dep.contracts?.MockSwapRouter;
  const treasuryAddr: string | undefined = dep.contracts?.VaultTreasury;

  if (!ethers.isAddress(coreAddr) || !ethers.isAddress(factoryAddr)) {
    throw new Error("Missing ProtocolCore/VaultFactory in deployments file");
  }

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();
  console.log("Signer:", signerAddr);

  // Params (env overrides)
  const asset = env("ASSET_TOKEN", dxpAddr!)!;
  const ownerEoa = env("OWNER_EOA", signerAddr)!;
  const farmId = BigInt(env("FARM_ID", String(Math.floor(Date.now() / 1000)))!);
  const usdPricer = env("USD_PRICER", routerAddr || ethers.ZeroAddress) as string;
  const assetsValuer = env("ASSETS_VALUER", treasuryAddr || ethers.ZeroAddress) as string;
  const minSubscriptionAssets = BigInt(env("MIN_SUBSCRIPTION", "0")!);
  const lockupSeconds = Number(env("LOCKUP_SECONDS", "0"));
  const shareTransferable = env("SHARE_TRANSFERABLE", "true") === "true";
  const transferFeeBps = Number(env("TRANSFER_FEE_BPS", "0"));
  const shareDecimals = Number(env("SHARE_DECIMALS", "18"));
  const name = env("VAULT_NAME", "My Vault")!;
  const symbol = env("VAULT_SYMBOL", "MVLT")!;

  // Preflight checks
  const core = new Contract(coreAddr, [
    "function vaultFactory() view returns (address)",
    "function createVaultViaCore(address,string,string,address,uint256,address,address,uint256,uint64,bool,uint16,uint8) returns (address)"
  ], signer);

  const factory = new Contract(factoryAddr, [
    "function protocolCore() view returns (address)",
    "function vaultsByOwner(address) view returns (address[])",
    "event VaultCreated(address indexed vault, address indexed asset, uint256 indexed farmId)"
  ], signer);

  const vf = await core.vaultFactory();
  console.log("Core.vaultFactory:", vf);
  const fc = await factory.protocolCore();
  console.log("Factory.protocolCore:", fc);
  if (vf.toLowerCase() !== factoryAddr.toLowerCase()) throw new Error("Core is not wired to expected VaultFactory");
  if (fc.toLowerCase() !== coreAddr.toLowerCase()) throw new Error("VaultFactory.protocolCore mismatch with ProtocolCore");

  // Asset decimals preflight
  const erc20 = new Contract(asset, ["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function name() view returns (string)"], signer);
  try {
    const dec = await erc20.decimals();
    console.log("Asset decimals:", dec);
  } catch {
    throw new Error(`Asset is not ERC20 on ${network}: ${asset}`);
  }

  console.log("Calling createVaultViaCore with:", {
    asset, name, symbol, ownerEoa, farmId: String(farmId), usdPricer, assetsValuer,
    minSubscriptionAssets: String(minSubscriptionAssets), lockupSeconds, shareTransferable, transferFeeBps, shareDecimals
  });

  const tx = await core.createVaultViaCore(
    asset,
    name,
    symbol,
    ownerEoa,
    farmId,
    usdPricer,
    assetsValuer,
    minSubscriptionAssets,
    lockupSeconds,
    shareTransferable,
    transferFeeBps,
    shareDecimals
  );
  const rcpt = await tx.wait();
  console.log("Tx hash:", rcpt.hash);

  // Try to resolve address
  let vaultAddr: string | undefined;
  try {
    const iface = new Interface(["event VaultCreated(address indexed vault, address indexed asset, uint256 indexed farmId)"]);
    for (const l of rcpt.logs) {
      try {
        const parsed = iface.parseLog(l);
        if (parsed?.name === "VaultCreated") { vaultAddr = parsed.args?.vault as string; break; }
      } catch {}
    }
  } catch {}
  if (!vaultAddr) {
    try {
      const list: string[] = await factory.vaultsByOwner(ownerEoa);
      vaultAddr = list[list.length - 1];
    } catch {}
  }
  console.log("Vault:", vaultAddr || "(unresolved, check factory registry)");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
