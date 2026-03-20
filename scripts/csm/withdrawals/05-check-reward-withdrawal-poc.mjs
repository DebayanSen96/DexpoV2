import { readFileSync } from "fs";
import { ethers } from "ethers";

const HOODI_RPC = "https://hoodi.drpc.org";
const PRIVATE_KEY = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";
const TREE_URL = "https://raw.githubusercontent.com/lidofinance/csm-rewards/hoodi/tree.json";

const CS_MODULE = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const CS_ACCOUNTING = "0xA54b90BA34C5f326BC1485054080994e38FB4C60";

const DEPLOYMENT_PATH = "c:/Work/DexpoV2/deployments/v3-latest/ethereum-hoodi.json";

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

function hashNode(a, b) {
  if (a > b) [a, b] = [b, a];
  return ethers.keccak256(ethers.concat([a, b]));
}

function getProofFromTree(treeArray, index) {
  const proof = [];
  let i = index;
  while (i > 0) {
    const sibling = i % 2 === 0 ? i - 1 : i + 1;
    if (treeArray[sibling]) proof.push(treeArray[sibling]);
    i = Math.floor((i - 1) / 2);
  }
  return proof;
}

function verifyProof(root, leaf, proof) {
  let acc = leaf;
  for (const p of proof) acc = hashNode(acc, p);
  return acc.toLowerCase() === root.toLowerCase();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return await res.json();
}

async function main() {
  const SHOULD_SEND = process.argv.includes("--send");
  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
  const vault = new ethers.Contract(deployment.csmVault, VAULT_ABI, wallet);
  const adapter = new ethers.Contract(deployment.lidoCSMAdapter, ADAPTER_ABI, provider);
  const csm = new ethers.Contract(CS_MODULE, CSM_ABI, provider);
  const csa = new ethers.Contract(CS_ACCOUNTING, CSA_ABI, provider);

  const registered = await adapter.vaultRegistered(deployment.csmVault);
  const noId = await adapter.vaultNodeOperatorId(deployment.csmVault);
  const trackedPrincipal = await adapter.vaultBondedEth(deployment.csmVault);
  const accruedView = await adapter.getAccruedRewardsEth(deployment.csmVault);
  const [current, required] = await csa.getBondSummary(noId);
  const info = await csm.getNodeOperator(noId);

  console.log("Wallet:", wallet.address);
  console.log("Vault:", deployment.csmVault);
  console.log("Adapter:", deployment.lidoCSMAdapter);
  console.log("NO ID:", Number(noId));
  console.log("vaultRegistered:", registered);
  console.log("manager:", info[10]);
  console.log("rewardAddress:", info[11]);
  console.log("current bond:", ethers.formatEther(current), "ETH");
  console.log("required bond:", ethers.formatEther(required), "ETH");
  console.log("adapter tracked principal:", ethers.formatEther(trackedPrincipal), "ETH");
  console.log("adapter accrued view:", ethers.formatEther(accruedView), "ETH");

  const treeDump = await fetchJson(TREE_URL);
  const target = treeDump.values.find((v) => Number(v.value[0]) === Number(noId));
  if (!target) {
    console.log(`NO ${Number(noId)} not present in Lido rewards tree yet.`);
    return;
  }

  const cumulative = BigInt(target.value[1]);
  const treeIndex = target.treeIndex;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(treeDump.leafEncoding, [BigInt(noId), cumulative]);
  const leaf = ethers.keccak256(ethers.keccak256(encoded));
  const proof = getProofFromTree(treeDump.tree, treeIndex);
  const validProof = verifyProof(treeDump.tree[0], leaf, proof);

  if (!validProof) throw new Error("Proof verification failed");
  console.log("Merkle proof: OK");
  console.log("cumulativeFeeShares:", cumulative.toString());
  console.log("proof length:", proof.length);

  const STAKE_CLAIM = 6;
  const params = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "bytes32[]"],
    [cumulative, proof]
  );

  const previewBytes = await vault.executeModuleAction.staticCall(STAKE_CLAIM, params);
  const [claimPreview] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], previewBytes);
  console.log("STAKE_CLAIM(proof) preview claimable:", ethers.formatEther(claimPreview), "ETH");

  if (!SHOULD_SEND) {
    console.log("Dry run complete. Re-run with --send to broadcast STAKE_CLAIM(proof).");
    return;
  }

  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const tx = await vault.executeModuleAction(STAKE_CLAIM, params, { nonce, gasLimit: 900_000n });
  console.log("tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("status:", receipt.status, "gas:", receipt.gasUsed.toString());

  const afterBytes = await vault.executeModuleAction.staticCall(STAKE_CLAIM, params);
  const [afterPreview] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], afterBytes);
  console.log("STAKE_CLAIM(proof) preview after tx:", ethers.formatEther(afterPreview), "ETH");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
