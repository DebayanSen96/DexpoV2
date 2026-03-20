import { ethers } from "ethers";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const HOODI_RPC = "https://hoodi.drpc.org";
const PRIVATE_KEY = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";

const CS_MODULE = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const CS_ACCOUNTING = "0xA54b90BA34C5f326BC1485054080994e38FB4C60";
const TREE_URL = "https://raw.githubusercontent.com/lidofinance/csm-rewards/hoodi/tree.json";
const STETH = "0x3508A952176b3c15387C97BE809eaffB1982176a";

const CSM_ABI = [
  "function getNodeOperator(uint256) view returns (uint32 totalAddedKeys, uint32 totalWithdrawnKeys, uint32 totalDepositedKeys, uint32 totalVettedKeys, uint32 stuckValidatorsCount, uint32 depositableValidatorsCount, uint32 targetLimit, uint8 targetLimitMode, uint32 totalExitedKeys, uint32 enqueuedCount, address managerAddress, address proposedManagerAddress, address rewardAddress, address proposedRewardAddress, bool extendedManagerPermissions, bool stuck)",
  "function claimRewardsStETH(uint256 nodeOperatorId, uint256 stETHAmount, uint256 cumulativeFeeShares, bytes32[] rewardsProof)",
  "function changeNodeOperatorRewardAddress(uint256 nodeOperatorId, address newAddress)",
];

const CSA_ABI = [
  "function getBondSummary(uint256 nodeOperatorId) view returns (uint256 current, uint256 required)",
  "function pullFeeRewards(uint256 nodeOperatorId, uint256 cumulativeFeeShares, bytes32[] rewardsProof)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getLatestNonce(provider, address) {
  const latest = await provider.getTransactionCount(address, "latest");
  const pending = await provider.getTransactionCount(address, "pending");
  if (pending > latest) {
    console.log(`  nonce drift detected: latest=${latest} pending=${pending}, using latest`);
  }
  return latest;
}

async function sendTx(provider, wallet, label, txFn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const nonce = await getLatestNonce(provider, wallet.address);
      console.log(`  ${label}: sending (nonce=${nonce}, attempt ${attempt}/${maxAttempts})`);
      const tx = await txFn(nonce);
      console.log(`  ${label} tx: ${tx.hash}`);
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("tx.wait timeout 180s")), 180_000)),
      ]);
      if (!receipt || receipt.status !== 1) throw new Error(`${label} tx failed: ${tx.hash}`);
      console.log(`  ${label} confirmed (gas: ${receipt.gasUsed})`);
      await delay(1500);
      return receipt;
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.log(`  ${label} attempt ${attempt} error: ${msg}`);
      if (msg.includes("nonce too low") && attempt < maxAttempts) {
        await delay(3000);
        continue;
      }
      if (msg.includes("timeout") && attempt < maxAttempts) {
        await delay(5000);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts`);
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
  const PULL_ONLY = args.includes("--pull-only");
  const FORCE_CLAIM = args.includes("--force-claim");

  if (!Number.isFinite(NO_ID) || NO_ID <= 0) {
    throw new Error("Invalid --no-id. Example: --no-id 410");
  }

  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const csm = new ethers.Contract(CS_MODULE, CSM_ABI, wallet);
  const csa = new ethers.Contract(CS_ACCOUNTING, CSA_ABI, wallet);
  const steth = new ethers.Contract(STETH, ERC20_ABI, provider);

  const deployment = JSON.parse(readFileSync(join(ROOT, "deployments", "v3-latest", "ethereum-hoodi.json"), "utf8"));
  console.log("Wallet:", wallet.address);
  console.log("CSModule:", CS_MODULE);
  console.log("Vault:", deployment.csmVault);

  console.log("\nFetching rewards tree from Lido...");
  const treeDump = await fetchJson(TREE_URL);
  const treeArray = treeDump.tree;
  const root = treeArray[0];
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const target = treeDump.values.find((v) => Number(v.value[0]) === NO_ID);
  if (!target) {
    console.log(`NO ${NO_ID} is not present in current rewards tree (no claim proof available yet).`);
    return;
  }

  const cumulative = BigInt(target.value[1]);
  const treeIndex = target.treeIndex;

  const encoded = coder.encode(treeDump.leafEncoding, [BigInt(NO_ID), cumulative]);
  const leaf = ethers.keccak256(ethers.keccak256(encoded));
  if (leaf !== treeArray[treeIndex]) throw new Error("Leaf hash mismatch with tree dump");

  const proof = getProofFromTree(treeArray, treeIndex);
  if (!verifyProof(root, leaf, proof)) throw new Error("Generated proof does not verify against tree root");

  console.log(`\nNO ${NO_ID} found in tree`);
  console.log("cumulativeFeeShares:", cumulative.toString());
  console.log("proof length:", proof.length);
  console.log("tree root:", root);

  const no = await csm.getNodeOperator(NO_ID);
  const manager = no.managerAddress;
  const rewardAddr = no.rewardAddress;
  const ZERO = "0x0000000000000000000000000000000000000000";
  const walletLc = wallet.address.toLowerCase();
  const isManager = manager.toLowerCase() === walletLc;
  const isRewardAddress = rewardAddr !== ZERO && rewardAddr.toLowerCase() === walletLc;
  const canUseCsmClaim = isManager || isRewardAddress;
  console.log("\nmanager:", manager);
  console.log("rewardAddress:", rewardAddr);
  console.log("walletIsManager:", isManager);
  console.log("walletIsRewardAddress:", isRewardAddress);

  if (rewardAddr === ZERO) {
    console.log("\nrewardAddress is 0x0 — must set it before claiming.");
    console.log("Setting rewardAddress to wallet:", wallet.address);
    if (!isManager) {
      throw new Error("rewardAddress is 0x0, but wallet is not the node operator manager; cannot call changeNodeOperatorRewardAddress");
    }
    if (!SHOULD_SEND) {
      console.log("Dry run: would call changeNodeOperatorRewardAddress. Re-run with --send.");
      return;
    }
    await sendTx(provider, wallet, "changeNodeOperatorRewardAddress", (nonce) =>
      csm.changeNodeOperatorRewardAddress(NO_ID, wallet.address, { nonce, gasLimit: 200_000n })
    );
    const noAfter = await csm.getNodeOperator(NO_ID);
    console.log("rewardAddress now:", noAfter.rewardAddress);
    if (noAfter.rewardAddress === ZERO) throw new Error("Failed to set reward address");
  }

  const [currentBond, requiredBond] = await csa.getBondSummary(NO_ID);
  console.log("\ncurrent bond:", ethers.formatEther(currentBond), "ETH");
  console.log("required bond:", ethers.formatEther(requiredBond), "ETH");

  const stethBalBefore = await steth.balanceOf(rewardAddr);
  console.log("rewardAddress stETH before:", ethers.formatEther(stethBalBefore));

  console.log("\nstaticCall pullFeeRewards...");
  await csa.pullFeeRewards.staticCall(NO_ID, cumulative, proof);
  console.log("staticCall pullFeeRewards: OK");

  let claimPreviewError = null;
  if (!PULL_ONLY) {
    console.log("\nstaticCall claimRewardsStETH...");
    if (!canUseCsmClaim) {
      claimPreviewError = new Error("wallet is neither manager nor rewardAddress for this node operator");
      console.log("staticCall claimRewardsStETH failed:", claimPreviewError.message);
    } else {
      try {
        await csm.claimRewardsStETH.staticCall(NO_ID, ethers.MaxUint256, cumulative, proof);
        console.log("staticCall claimRewardsStETH: OK");
      } catch (err) {
        claimPreviewError = err;
        const msg = err?.shortMessage || err?.message || String(err);
        console.log("staticCall claimRewardsStETH failed:", msg);
      }
    }
  }

  if (!SHOULD_SEND) {
    if (PULL_ONLY) {
      console.log("\nDry run mode: proof + pullFeeRewards preview verified. Re-run with --send --pull-only to broadcast pull tx.");
      return;
    }
    if (claimPreviewError) {
      console.log("\nDry run mode: pullFeeRewards works, but claimRewardsStETH currently reverts on Hoodi. Re-run with --send --pull-only to at least realize rewards into bond, or --send --force-claim to try the reverting claim path anyway.");
      return;
    }
    console.log("\nDry run mode: proof + pullFeeRewards + claimRewardsStETH verified. Re-run with --send to broadcast claim tx.");
    return;
  }

  if (PULL_ONLY || (claimPreviewError && !FORCE_CLAIM)) {
    console.log("\nSending pullFeeRewards tx...");
    await sendTx(provider, wallet, "pullFeeRewards", (nonce) =>
      csa.pullFeeRewards(NO_ID, cumulative, proof, { nonce, gasLimit: 500_000n })
    );

    const [bondAfterPull, requiredAfterPull] = await csa.getBondSummary(NO_ID);
    console.log("bond after pull:", ethers.formatEther(bondAfterPull), "ETH");
    console.log("required bond:", ethers.formatEther(requiredAfterPull), "ETH");
    console.log("excess bond after pull:", ethers.formatEther(bondAfterPull - requiredAfterPull), "ETH");
    console.log("rewardAddress stETH after:", ethers.formatEther(await steth.balanceOf(rewardAddr)));
    return;
  }

  if (!canUseCsmClaim) {
    throw new Error("wallet is neither manager nor rewardAddress for this node operator; cannot send claimRewardsStETH via CSModule");
  }

  console.log("\nSending claimRewardsStETH tx...");
  await sendTx(provider, wallet, "claimRewardsStETH", (nonce) =>
    csm.claimRewardsStETH(NO_ID, ethers.MaxUint256, cumulative, proof, { nonce, gasLimit: 1_000_000n })
  );

  const stethBalAfter = await steth.balanceOf(rewardAddr);
  console.log("\nrewardAddress stETH after:", ethers.formatEther(stethBalAfter));
  console.log("stETH received:", ethers.formatEther(stethBalAfter - stethBalBefore));

  const [bondAfter] = await csa.getBondSummary(NO_ID);
  console.log("bond after claim:", ethers.formatEther(bondAfter), "ETH");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
