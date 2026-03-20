import { ethers } from "ethers";

const HOODI_RPC = "https://hoodi.drpc.org";
const PRIVATE_KEY = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";

const CS_MODULE = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const CS_ACCOUNTING = "0xA54b90BA34C5f326BC1485054080994e38FB4C60";
const TREE_URL = "https://raw.githubusercontent.com/lidofinance/csm-rewards/hoodi/tree.json";
const STETH = "0x3508A952176b3c15387C97BE809eaffB1982176a";

const CSM_ABI = [
  "function getNodeOperator(uint256) view returns (uint32 totalAddedKeys, uint32 totalWithdrawnKeys, uint32 totalDepositedKeys, uint32 totalVettedKeys, uint32 stuckValidatorsCount, uint32 depositableValidatorsCount, uint32 targetLimit, uint8 targetLimitMode, uint32 totalExitedKeys, uint32 enqueuedCount, address managerAddress, address proposedManagerAddress, address rewardAddress, address proposedRewardAddress, bool extendedManagerPermissions, bool stuck)",
  "function changeNodeOperatorRewardAddress(uint256 nodeOperatorId, address newAddress)",
];

const CSA_ABI = [
  "function getBondSummary(uint256 nodeOperatorId) view returns (uint256 current, uint256 required)",
  "function pullFeeRewards(uint256 nodeOperatorId, uint256 cumulativeFeeShares, bytes32[] rewardsProof)",
  "function getClaimableRewardsAndBondShares(uint256 nodeOperatorId, uint256 cumulativeFeeShares, bytes32[] rewardsProof) view returns (uint256)",
  "function claimRewardsStETH(uint256 nodeOperatorId, uint256 stETHAmount, uint256 cumulativeFeeShares, bytes32[] rewardsProof) returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

function parseArgs(argv) {
  const args = argv.slice(2);
  const noIdIndex = args.indexOf("--no-id");
  const noId = noIdIndex >= 0 ? Number(args[noIdIndex + 1]) : 410;

  return {
    noId,
    shouldSend: args.includes("--send"),
    pullOnly: args.includes("--pull-only"),
    autoSetRewardAddress: args.includes("--set-reward-address"),
  };
}

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getLatestNonce(provider, address) {
  const latest = await provider.getTransactionCount(address, "latest");
  const pending = await provider.getTransactionCount(address, "pending");
  return pending > latest ? pending : latest;
}

async function sendTx(provider, wallet, label, txFn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const nonce = await getLatestNonce(provider, wallet.address);
      console.log(`${label}: sending (nonce=${nonce}, attempt ${attempt}/${maxAttempts})`);
      const tx = await txFn(nonce);
      console.log(`${label} tx: ${tx.hash}`);
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("tx.wait timeout 180s")), 180_000)),
      ]);
      if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
      console.log(`${label}: confirmed, gas=${receipt.gasUsed}`);
      return receipt;
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.log(`${label}: attempt ${attempt} failed: ${msg}`);
      if (attempt < maxAttempts && (msg.includes("nonce too low") || msg.includes("timeout"))) {
        await delay(3000);
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const { noId, shouldSend, pullOnly, autoSetRewardAddress } = parseArgs(process.argv);
  if (!Number.isFinite(noId) || noId <= 0) {
    throw new Error("Pass a valid node operator id, for example: --no-id 410");
  }

  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const csm = new ethers.Contract(CS_MODULE, CSM_ABI, wallet);
  const csa = new ethers.Contract(CS_ACCOUNTING, CSA_ABI, wallet);
  const steth = new ethers.Contract(STETH, ERC20_ABI, provider);

  console.log("wallet:", wallet.address);
  console.log("nodeOperatorId:", noId);

  const rewardsTree = await fetchJson(TREE_URL);
  const entry = rewardsTree.values.find((value) => Number(value.value[0]) === noId);
  if (!entry) {
    console.log("This node operator is not in the current rewards tree yet, so there is nothing to claim right now.");
    return;
  }

  const cumulativeFeeShares = BigInt(entry.value[1]);
  const leafEncoding = rewardsTree.leafEncoding;
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(leafEncoding, [BigInt(noId), cumulativeFeeShares]);
  const leaf = ethers.keccak256(ethers.keccak256(encoded));
  const expectedLeaf = rewardsTree.tree[entry.treeIndex];
  if (leaf !== expectedLeaf) {
    throw new Error("Leaf hash mismatch against rewards tree");
  }

  const proof = getProofFromTree(rewardsTree.tree, entry.treeIndex);
  const proofOk = verifyProof(rewardsTree.tree[0], leaf, proof);
  if (!proofOk) {
    throw new Error("Merkle proof verification failed");
  }

  const no = await csm.getNodeOperator(noId);
  const manager = no.managerAddress;
  const rewardAddress = no.rewardAddress;
  const walletLc = wallet.address.toLowerCase();
  const isManager = manager.toLowerCase() === walletLc;
  const isRewardAddress = rewardAddress !== ethers.ZeroAddress && rewardAddress.toLowerCase() === walletLc;
  const canDirectClaim = isManager || isRewardAddress;

  console.log("manager:", manager);
  console.log("rewardAddress:", rewardAddress);
  console.log("walletIsManager:", isManager);
  console.log("walletIsRewardAddress:", isRewardAddress);
  console.log("treeRoot:", rewardsTree.tree[0]);
  console.log("proofLength:", proof.length);
  console.log("cumulativeFeeShares:", cumulativeFeeShares.toString());

  if (rewardAddress === ethers.ZeroAddress) {
    console.log("rewardAddress is zero.");
    if (!autoSetRewardAddress) {
      console.log("Use --set-reward-address if you want this script to set the reward address to the current wallet first.");
      return;
    }
    if (!isManager) {
      throw new Error("Cannot set reward address because this wallet is not the manager");
    }
    if (!shouldSend) {
      console.log("Dry run: would set rewardAddress to the current wallet.");
      return;
    }
    await sendTx(provider, wallet, "changeNodeOperatorRewardAddress", (nonce) =>
      csm.changeNodeOperatorRewardAddress(noId, wallet.address, { nonce, gasLimit: 200_000n })
    );
  }

  const [currentBond, requiredBond] = await csa.getBondSummary(noId);
  const claimableShares = await csa.getClaimableRewardsAndBondShares(noId, cumulativeFeeShares, proof);
  const stethBefore = await steth.balanceOf(rewardAddress === ethers.ZeroAddress ? wallet.address : rewardAddress);

  console.log("currentBondEth:", ethers.formatEther(currentBond));
  console.log("requiredBondEth:", ethers.formatEther(requiredBond));
  console.log("bondExcessEth:", ethers.formatEther(currentBond - requiredBond));
  console.log("claimableRewardShares:", claimableShares.toString());

  console.log("static pullFeeRewards: checking...");
  await csa.pullFeeRewards.staticCall(noId, cumulativeFeeShares, proof);
  console.log("static pullFeeRewards: ok");

  if (pullOnly) {
    if (!shouldSend) {
      console.log("Dry run complete. Re-run with --send --pull-only to realize rewards into bond without payout.");
      return;
    }
    await sendTx(provider, wallet, "pullFeeRewards", (nonce) =>
      csa.pullFeeRewards(noId, cumulativeFeeShares, proof, { nonce, gasLimit: 500_000n })
    );
    const [currentAfterPull, requiredAfterPull] = await csa.getBondSummary(noId);
    console.log("bondAfterPullEth:", ethers.formatEther(currentAfterPull));
    console.log("bondExcessAfterPullEth:", ethers.formatEther(currentAfterPull - requiredAfterPull));
    return;
  }

  if (!canDirectClaim) {
    console.log("This wallet cannot directly claim for this node operator.");
    console.log("You need the manager or rewardAddress wallet, or you need to change the roles first.");
    return;
  }

  const previewAmount = await csa.claimRewardsStETH.staticCall(noId, claimableShares, cumulativeFeeShares, proof);
  console.log("previewPayoutStEth:", ethers.formatEther(previewAmount));

  if (!shouldSend) {
    console.log("Dry run complete. Re-run with --send to broadcast the claim.");
    return;
  }

  await sendTx(provider, wallet, "claimRewardsStETH", (nonce) =>
    csa.claimRewardsStETH(noId, claimableShares, cumulativeFeeShares, proof, { nonce, gasLimit: 1_000_000n })
  );

  const payoutRecipient = rewardAddress === ethers.ZeroAddress ? wallet.address : rewardAddress;
  const stethAfter = await steth.balanceOf(payoutRecipient);
  const [currentBondAfter, requiredBondAfter] = await csa.getBondSummary(noId);

  console.log("payoutRecipient:", payoutRecipient);
  console.log("stEthReceived:", ethers.formatEther(stethAfter - stethBefore));
  console.log("bondAfterClaimEth:", ethers.formatEther(currentBondAfter));
  console.log("bondExcessAfterClaimEth:", ethers.formatEther(currentBondAfter - requiredBondAfter));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
