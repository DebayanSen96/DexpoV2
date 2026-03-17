import { readFileSync } from "fs";
import { ethers } from "ethers";

const HOODI_RPC = "https://hoodi.drpc.org";
const PRIVATE_KEY = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";

const CS_MODULE = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const CS_ACCOUNTING = "0xA54b90BA34C5f326BC1485054080994e38FB4C60";

const DEPLOYMENT_PATH = "c:/Work/DexpoV2/deployments/v3-latest/ethereum-hoodi.json";
const DEPOSIT_JSON_PATH = "c:/Work/DexpoV2/keys/depost_data_1_march_2026.json";

const VAULT_ABI = [
  "function executeModuleAction(uint8 command, bytes params) returns (bytes)",
];

const ADAPTER_ABI = [
  "function vaultNodeOperatorId(address) view returns (uint256)",
  "function vaultBondedEth(address) view returns (uint256)",
  "function getAccruedRewardsEth(address) view returns (uint256)",
  "function vaultRegistered(address) view returns (bool)",
];

const CSM_ABI = [
  "function getNodeOperator(uint256) view returns (tuple(uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint8,uint32,uint32,address,address,address,address,bool,bool))",
];

const CSA_ABI = [
  "function getBondSummary(uint256 nodeOperatorId) view returns (uint256 current, uint256 required)",
];

function toNum(v) {
  return Number(v);
}

function findByNoId(entries, noId) {
  return entries.find((e) => Number(e.nodeOperatorId) === Number(noId));
}

async function main() {
  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
  const entries = JSON.parse(readFileSync(DEPOSIT_JSON_PATH, "utf8"));

  const csm = new ethers.Contract(CS_MODULE, CSM_ABI, provider);
  const csa = new ethers.Contract(CS_ACCOUNTING, CSA_ABI, provider);

  const no410 = findByNoId(entries, 410);
  const no411 = findByNoId(entries, 411);

  if (!no410) throw new Error("Could not find nodeOperatorId=410 in deposit JSON");
  if (!no411) throw new Error("Could not find nodeOperatorId=411 in deposit JSON");

  console.log("Wallet:", wallet.address);
  console.log("Vault:", deployment.csmVault);
  console.log("Adapter:", deployment.lidoCSMAdapter);

  console.log("\n=== NO 410 (direct script path) ===");
  const [current410, required410] = await csa.getBondSummary(410);
  const info410 = await csm.getNodeOperator(410);
  console.log("pubkey:", `0x${no410.pubkey}`);
  console.log("manager:", info410[10]);
  console.log("rewardAddress:", info410[11]);
  console.log("vetted:", toNum(info410[3]));
  console.log("deposited:", toNum(info410[2]));
  console.log("current bond:", ethers.formatEther(current410), "ETH");
  console.log("required bond:", ethers.formatEther(required410), "ETH");
  console.log("potential reward over required:", ethers.formatEther(current410 > required410 ? current410 - required410 : 0n), "ETH");
  console.log("Note: direct NO reward withdrawal requires Lido Merkle proof + claimRewardsStETH, not available in repo scripts yet.");

  console.log("\n=== NO 411 (vault + adapter path) ===");
  const adapter = new ethers.Contract(deployment.lidoCSMAdapter, ADAPTER_ABI, provider);
  const vault = new ethers.Contract(deployment.csmVault, VAULT_ABI, wallet);

  const registered = await adapter.vaultRegistered(deployment.csmVault);
  const adapterNoId = await adapter.vaultNodeOperatorId(deployment.csmVault);
  const trackedPrincipal = await adapter.vaultBondedEth(deployment.csmVault);
  const accruedView = await adapter.getAccruedRewardsEth(deployment.csmVault);
  const [current411, required411] = await csa.getBondSummary(411);
  const info411 = await csm.getNodeOperator(411);

  console.log("pubkey:", `0x${no411.pubkey}`);
  console.log("vaultRegistered:", registered);
  console.log("adapter NO ID:", toNum(adapterNoId));
  console.log("manager:", info411[10]);
  console.log("rewardAddress:", info411[11]);
  console.log("vetted:", toNum(info411[3]));
  console.log("deposited:", toNum(info411[2]));
  console.log("current bond:", ethers.formatEther(current411), "ETH");
  console.log("required bond:", ethers.formatEther(required411), "ETH");
  console.log("adapter tracked principal:", ethers.formatEther(trackedPrincipal), "ETH");
  console.log("adapter accrued view:", ethers.formatEther(accruedView), "ETH");

  const STAKE_CLAIM = 6;
  const claimPreviewBytes = await vault.executeModuleAction.staticCall(STAKE_CLAIM, "0x");
  const [claimPreview] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], claimPreviewBytes);
  console.log("STAKE_CLAIM preview claimable:", ethers.formatEther(claimPreview), "ETH");

  if (claimPreview > 0n) {
    console.log("\nSending on-chain STAKE_CLAIM tx...");
    const nonce = await provider.getTransactionCount(wallet.address, "latest");
    const tx = await vault.executeModuleAction(STAKE_CLAIM, "0x", { nonce, gasLimit: 600_000n });
    console.log("tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("status:", receipt.status, "gas:", receipt.gasUsed.toString());

    const claimAfterBytes = await vault.executeModuleAction.staticCall(STAKE_CLAIM, "0x");
    const [claimAfter] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], claimAfterBytes);
    console.log("STAKE_CLAIM preview after tx:", ethers.formatEther(claimAfter), "ETH");
  } else {
    console.log("No claimable rewards yet on adapter path. Wait for more accrual and rerun.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
