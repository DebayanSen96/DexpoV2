import fs from 'fs/promises';
import path from 'path';
import { ethers } from 'ethers';

// Minimal ABI for approval checks
const ProtocolCoreAbi = [
  'function approvedFarmOwners(address) view returns (bool)',
  'function setApprovedFarmOwner(address,bool)'
];

async function readLatestDeployment(network: string) {
  const dir = path.join(process.cwd(), 'deployments', network);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`No deployment files in ${dir}`);
  const latest = files[files.length - 1];
  const raw = await fs.readFile(path.join(dir, latest), 'utf8');
  return JSON.parse(raw);
}

async function main() {
  // Config
  const network = 'localhost';
  const rpcUrl = process.env.LOCALHOST_RPC_URL || 'http://127.0.0.1:8545';
  const serverUrl = process.env.API_URL || 'http://127.0.0.1:3001';

  // Use provided private key (ensure 0x prefix)
  // Default to Hardhat account #0 if PK not provided
  let pk = process.env.PK || 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  if (!pk.startsWith('0x')) pk = '0x' + pk;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  const creator = await wallet.getAddress();

  // Read deployment for asset address
  const dep = await readLatestDeployment(network);
  const asset: string = dep.params?.ASSET_TOKEN || dep.contracts?.DXPToken;
  if (!asset) throw new Error('Could not resolve asset token from deployments');

  // Ensure creator is approved as farm owner in ProtocolCore
  const coreAddr: string | undefined = dep.contracts?.ProtocolCore;
  if (!coreAddr) throw new Error('Could not resolve ProtocolCore from deployments');
  const core = new ethers.Contract(coreAddr, ProtocolCoreAbi, wallet);
  const isApproved: boolean = await core.approvedFarmOwners(creator);
  if (!isApproved) {
    const tx = await core.setApprovedFarmOwner(creator, true);
    await tx.wait();
  }

  // Build payload
  const payload = {
    network: network as 'localhost',
    ownerPrivateKey: pk,
    payload: {
      creator,
      asset,
      vaultName: 'Local Test Vault',
      vaultSymbol: 'LTV',
      recipients: { ownerRecipient: creator },
      splits: { lpBps: 9000, ownerBps: 500, verifierBps: 500 },
      lockConfig: {
        enabled: false,
        allowEarlyExit: true,
        earlyExitBps: 0,
        lockupSeconds: 0,
        postLockMode: 0,
      },
      payoutConfig: {
        mode: 'Stream',
        streamBps: 3000,
        compoundBps: 7000,
        epochSeconds: 86400,
        minHarvestIntervalSeconds: 300,
        compoundLpOnLock: true,
      },
      shareToken: {
        transferable: true,
        transferFeeBps: 50, // 0.50%
        feeReceiver: creator,
        protocolFeeReceiver: creator,
        protocolRakeBps: 200, // 2.00%
      },
      // strategies omitted; server allows empty, and ProtocolCore can accept no adapters
    },
  };

  // Print request payload (redact PK unless SHOW_PK=1)
  const showPk = process.env.SHOW_PK === '1' || process.env.SHOW_PK === 'true';
  const printable = { ...payload, ownerPrivateKey: showPk ? payload.ownerPrivateKey : '***redacted***' };
  console.log('Request Payload:');
  console.log(JSON.stringify(printable, null, 2));
  console.log('POST', `${serverUrl}/api/v3/create-vault`);

  // POST to server
  const res = await fetch(`${serverUrl}/api/v3/create-vault`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log('Status:', res.status);
  try {
    const json = JSON.parse(text);
    console.log('Response JSON:');
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log('Response Text:');
    console.log(text);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
