import { ethers } from "ethers";
import { readFileSync } from "fs";

const HOODI_RPC = "https://hoodi.drpc.org";
const PRIVATE_KEY = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";

const CS_MODULE = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const TREE_URL = "https://raw.githubusercontent.com/lidofinance/csm-rewards/hoodi/tree.json";

const CSM_ABI = [
  "function getNodeOperator(uint256) view returns (tuple(uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint8,uint32,uint32,address,address,address,address,bool,bool))",
  "function claimRewardsStETH(uint256 nodeOperatorId, uint256 stETHAmount, uint256 cumulativeFeeShares, bytes32[] rewardsProof)",
];

function cmpHex(a, b) {
  return Buffer.compare(Buffer.from(a.slice(2), "hex"), Buffer.from(b.slice(2), "hex"));
}

function hashLeaf(encodedLeaf) {
  return ethers.keccak256(ethers.keccak256(encodedLeaf));
}

function hashNode(lhs, rhs) {
  if (cmpHex(lhs, rhs) > 0) [lhs, rhs] = [rhs, lhs];
  return ethers.keccak256(ethers.concat([lhs, rhs]));
}

function buildCompleteTree(sortedLeaves) {
  if (sortedLeaves.length === 0) throw new Error("Cannot build tree with no leaves");
  const size = 2 * sortedLeaves.length - 1;
  const tree = new Array(size);

  for (let i = 0; i < sortedLeaves.length; i++) {
    tree[size - 1 - i] = sortedLeaves[i];
  }
  for (let i = size - 1 - sortedLeaves.length; i >= 0; i--) {
    tree[i] = hashNode(tree[2 * i + 1], tree[2 * i + 2]);
  }
  return tree;
}

function getProof(tree, index) {
  const proof = [];
  let i = index;
  while (i > 0) {
    const sibling = i % 2 === 0 ? i - 1 : i + 1;
    proof.push(tree[sibling]);
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
  const args = process.argv.slice(2);
  const noIdArgIndex = args.indexOf("--no-id");
  const NO_ID = noIdArgIndex >= 0 ? Number(args[noIdArgIndex + 1]) : 410;
  const SHOULD_SEND = args.includes("--send");

  if (!Number.isFinite(NO_ID) || NO_ID <= 0) {
    throw new Error("Invalid --no-id. Example: --no-id 410");
  }

  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const csm = new ethers.Contract(CS_MODULE, CSM_ABI, wallet);

  const deployment = JSON.parse(readFileSync("c:/Work/DexpoV2/deployments/v3-latest/ethereum-hoodi.json", "utf8"));
  console.log("Wallet:", wallet.address);
  console.log("CSModule:", CS_MODULE);
  console.log("Vault:", deployment.csmVault);

  const treeDump = await fetchJson(TREE_URL);
  const types = treeDump.leafEncoding;
  const values = treeDump.values;

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const leavesWithValues = values.map((entry) => {
    const noId = BigInt(entry.value[0]);
    const cumulative = BigInt(entry.value[1]);
    const encoded = coder.encode(types, [noId, cumulative]);
    return {
      noId,
      cumulative,
      leaf: hashLeaf(encoded),
    };
  });

  const sortedLeaves = leavesWithValues.map((x) => x.leaf).sort(cmpHex);
  const tree = buildCompleteTree(sortedLeaves);

  const target = leavesWithValues.find((x) => Number(x.noId) === NO_ID);
  if (!target) {
    console.log(`NO ${NO_ID} is not present in current rewards tree (no claim proof available yet).`);
    return;
  }

  const leafIndex = tree.indexOf(target.leaf);
  if (leafIndex < 0) throw new Error("Target leaf not found in built tree");

  const proof = getProof(tree, leafIndex);
  const rootFromDump = treeDump.tree[0];
  const ok = verifyProof(rootFromDump, target.leaf, proof);
  if (!ok) throw new Error("Generated proof does not verify against tree root");

  console.log(`\nNO ${NO_ID} cumulativeFeeShares:`, target.cumulative.toString());
  console.log("proof length:", proof.length);
  console.log("tree root:", rootFromDump);

  const no = await csm.getNodeOperator(NO_ID);
  console.log("manager:", no[10]);
  console.log("rewardAddress:", no[11]);

  const claimAmount = ethers.MaxUint256;
  await csm.claimRewardsStETH.staticCall(NO_ID, claimAmount, target.cumulative, proof);
  console.log("staticCall claimRewardsStETH: OK");

  if (!SHOULD_SEND) {
    console.log("Dry run mode: proof + staticCall verified. Re-run with --send to broadcast claim tx.");
    return;
  }

  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const tx = await csm.claimRewardsStETH(NO_ID, claimAmount, target.cumulative, proof, {
    nonce,
    gasLimit: 1_000_000n,
  });
  console.log("tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("status:", receipt.status, "gas:", receipt.gasUsed.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
