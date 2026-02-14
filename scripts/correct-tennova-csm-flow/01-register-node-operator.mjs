import * as bls from "@noble/bls12-381";
import { ethers } from "ethers";

const HOODI_RPC = "https://hoodi.drpc.org";
const PRIVATE_KEY = "2f9c39ab3295bc5d0efa10ab6a042a7486d25724f2bd35135088b402880e5eca";
const PERMISSIONLESS_GATE = "0x5553077102322689876A6AdFd48D75014c28acfb";
const CS_MODULE = "0x79CEf36D84743222f37765204Bec41E92a93E59d";
const STAKING_ROUTER = "0xCc820558B39ee15C7C45B59390B503b83fb499A8";
const GENESIS_FORK_VERSION = "0x10000910";
const BOND_AMOUNT = ethers.parseEther("2.4");

function hexToBytes(hex) {
  hex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const { ssz } = await import("@lodestar/types");

  const provider = new ethers.JsonRpcProvider(HOODI_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const walletAddress = wallet.address;
  console.log("Wallet:", walletAddress);

  const bal = await provider.getBalance(walletAddress);
  console.log("Balance:", ethers.formatEther(bal), "ETH");

  const sr = new ethers.Contract(STAKING_ROUTER, [
    "function getWithdrawalCredentials() view returns (bytes32)",
  ], provider);
  const csm = new ethers.Contract(CS_MODULE, [
    "function getNodeOperatorsCount() view returns (uint256)",
    "function getNodeOperator(uint256) view returns (tuple(uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint8,uint32,uint32,address,address,address,address,bool,bool))",
  ], provider);

  const wcBytes32 = await sr.getWithdrawalCredentials();
  console.log("Lido withdrawal credentials (from StakingRouter):", wcBytes32);
  const wc = hexToBytes(wcBytes32);

  // Step 2: Generate BLS keypair
  const sk = bls.utils.randomPrivateKey();
  const pk = bls.getPublicKey(sk);
  console.log("BLS pubkey:", bytesToHex(pk), `(${pk.length} bytes)`);

  // Step 3: Build deposit message and sign with Lido's withdrawal credentials
  const amountGwei = 32_000_000_000;
  const depositMessageRoot = ssz.phase0.DepositMessage.hashTreeRoot({
    pubkey: pk,
    withdrawalCredentials: wc,
    amount: amountGwei,
  });

  const forkVersion = hexToBytes(GENESIS_FORK_VERSION);
  const forkDataRoot = ssz.phase0.ForkData.hashTreeRoot({
    currentVersion: forkVersion,
    genesisValidatorsRoot: new Uint8Array(32),
  });
  const domain = new Uint8Array(32);
  domain.set([3, 0, 0, 0], 0);
  domain.set(forkDataRoot.slice(0, 28), 4);

  const signingRoot = ssz.phase0.SigningData.hashTreeRoot({
    objectRoot: depositMessageRoot,
    domain,
  });

  bls.utils.setDSTLabel("BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_");
  const sig = await bls.sign(signingRoot, sk);

  const valid = await bls.verify(sig, signingRoot, pk);
  console.log("Local BLS verify:", valid);
  if (!valid) {
    console.error("FATAL: BLS verification failed. Aborting.");
    process.exit(1);
  }

  const pkHex = bytesToHex(pk);
  const sigHex = bytesToHex(sig);
  console.log("pk:", (pkHex.length - 2) / 2, "bytes, sig:", (sigHex.length - 2) / 2, "bytes");

  // Step 4: Register new NO via PermissionlessGate (5-param version, no eaProof)
  const managementProperties = {
    managerAddress: walletAddress,
    rewardAddress: walletAddress,
    extendedManagerPermissions: true,
  };

  const gate = new ethers.Contract(PERMISSIONLESS_GATE, [
    "function addNodeOperatorETH(uint256 keysCount, bytes publicKeys, bytes signatures, tuple(address managerAddress, address rewardAddress, bool extendedManagerPermissions) managementProperties, address referrer) payable returns (uint256)",
  ], wallet);

  const nonce = await provider.getTransactionCount(walletAddress, "latest");
  console.log("\nNonce (latest):", nonce);
  console.log("Registering new Node Operator via PermissionlessGate...");
  console.log("Bond:", ethers.formatEther(BOND_AMOUNT), "ETH");

  const tx = await gate.addNodeOperatorETH(
    1,
    pkHex,
    sigHex,
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
    console.error("TX REVERTED");
    process.exit(1);
  }

  const totalNOs = await csm.getNodeOperatorsCount();
  const newNOId = Number(totalNOs) - 1;
  console.log("\nNew Node Operator ID:", newNOId);

  const no = await csm.getNodeOperator(newNOId);
  console.log("  totalAddedKeys:", Number(no[0]));
  console.log("  totalVettedKeys:", Number(no[3]));
  console.log("  depositableValidatorsCount:", Number(no[5]));
  console.log("  enqueuedCount:", Number(no[9]));
  console.log("  totalDepositedKeys:", Number(no[2]));
  console.log("  manager:", no[10]);

  console.log("\nValidator pubkey:", pkHex);
  console.log("Monitor: https://hoodi.beaconcha.in/validator/" + pkHex);

  if (Number(no[3]) === 0) {
    console.warn("\n⚠ WARNING: Key is NOT vetted. Withdrawal credentials or signature may still be wrong.");
  } else {
    console.log("\n✅ Key is VETTED. Waiting for Lido deposit bot to pick it up from queue.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
