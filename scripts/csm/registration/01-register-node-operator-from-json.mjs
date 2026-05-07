import { readFileSync, writeFileSync } from "fs";
import { ethers } from "ethers";

const HOODI_RPC = "https://hoodi.drpc.org";
const PRIVATE_KEY = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";
const PERMISSIONLESS_GATE = "0xd7bD8D2A9888D1414c770B35ACF55890B15de26a";
const CS_MODULE = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const STAKING_ROUTER = "0xCc820558B39ee15C7C45B59390B503b83fb499A8";
const BOND_AMOUNT = ethers.parseEther("2.4");
const DEFAULT_JSON_PATH = "c:/Work/DexpoV2/keys/depost_data_1_march_2026.json";

function normalizeHex(hex) {
  if (!hex) return "0x";
  return hex.startsWith("0x") ? hex : `0x${hex}`;
}

function pickNextValidator(entries) {
  return entries.find((entry) => !entry.usedAt && !entry.used);
}

async function main() {
  const jsonPath = process.argv[2] || DEFAULT_JSON_PATH;
  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const walletAddress = wallet.address;

  console.log("Wallet:", walletAddress);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(walletAddress)), "ETH");
  console.log("JSON:", jsonPath);

  const raw = readFileSync(jsonPath, "utf8");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Validator JSON must be a non-empty array");
  }

  const selected = pickNextValidator(entries);
  if (!selected) {
    console.log("No unused validators found in JSON.");
    return;
  }

  const sr = new ethers.Contract(STAKING_ROUTER, [
    "function getWithdrawalCredentials() view returns (bytes32)",
  ], provider);

  const csm = new ethers.Contract(CS_MODULE, [
    "function getNodeOperatorsCount() view returns (uint256)",
    "function getNodeOperator(uint256) view returns (tuple(uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint8,uint32,uint32,address,address,address,address,bool,bool))",
  ], provider);

  const expectedWC = (await sr.getWithdrawalCredentials()).toLowerCase();
  const wcFromJson = normalizeHex(selected.withdrawal_credentials).toLowerCase();
  if (expectedWC !== wcFromJson) {
    console.warn("WARNING: withdrawal_credentials mismatch with StakingRouter");
    console.warn("  json:", wcFromJson);
    console.warn("  expected:", expectedWC);
  }

  const pubkey = normalizeHex(selected.pubkey);
  const signature = normalizeHex(selected.signature);
  if (pubkey.length !== 98) throw new Error("Invalid pubkey length in JSON");
  if (signature.length !== 194) throw new Error("Invalid signature length in JSON");

  const managementProperties = {
    managerAddress: walletAddress,
    rewardAddress: walletAddress,
    extendedManagerPermissions: true,
  };

  const gate = new ethers.Contract(PERMISSIONLESS_GATE, [
    "function addNodeOperatorETH(uint256 keysCount, bytes publicKeys, bytes signatures, tuple(address managerAddress, address rewardAddress, bool extendedManagerPermissions) managementProperties, address referrer) payable returns (uint256)",
  ], wallet);

  const nonce = await provider.getTransactionCount(walletAddress, "latest");
  console.log("\nRegistering NO using pubkey:", pubkey);
  console.log("Bond:", ethers.formatEther(BOND_AMOUNT), "ETH");

  const tx = await gate.addNodeOperatorETH(
    1,
    pubkey,
    signature,
    managementProperties,
    ethers.ZeroAddress,
    { value: BOND_AMOUNT, gasLimit: 2_000_000n, nonce }
  );

  console.log("TX:", tx.hash);
  console.log("Waiting for confirmation (timeout 120s)...");
  const receipt = await Promise.race([
    tx.wait(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT: TX not mined in 120s")), 120_000)),
  ]);

  console.log("Status:", receipt.status, "block:", receipt.blockNumber, "gas:", receipt.gasUsed.toString());
  if (receipt.status !== 1) {
    throw new Error("Transaction reverted");
  }

  const totalNOs = await csm.getNodeOperatorsCount();
  const newNOId = Number(totalNOs) - 1;
  console.log("\nNew Node Operator ID:", newNOId);

  const no = await csm.getNodeOperator(newNOId);
  console.log("  totalAddedKeys:", Number(no[0]));
  console.log("  totalVettedKeys:", Number(no[3]));
  console.log("  depositableValidatorsCount:", Number(no[5]));
  console.log("  enqueuedCount:", Number(no[9]));
  console.log("  manager:", no[10]);

  selected.used = true;
  selected.usedAt = new Date().toISOString();
  selected.nodeOperatorId = newNOId;
  selected.txHash = tx.hash;
  selected.vetted = Number(no[3]) > 0;

  writeFileSync(jsonPath, JSON.stringify(entries, null, 2));

  console.log("\nUpdated JSON entry for pubkey:", pubkey);
  console.log("Monitor: https://hoodi.beaconcha.in/validator/" + pubkey);

  if (Number(no[3]) === 0) {
    console.warn("\n⚠ WARNING: Key is NOT vetted yet. Check withdrawal credentials/signature.");
  } else {
    console.log("\nKey is VETTED. Waiting for Lido deposit bot to pick it up from queue.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
