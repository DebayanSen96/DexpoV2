import fs from 'fs/promises';
import path from 'path';

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
  const serverUrl = process.env.API_URL || 'http://127.0.0.1:3001';

  // Creator address to assign vault ownership to (no private key needed)
  const creator = process.env.CREATOR_ADDRESS || process.env.CREATOR;
  if (!creator || !/^0x[a-fA-F0-9]{40}$/.test(creator)) {
    throw new Error('Set CREATOR_ADDRESS env var to a valid address');
  }

  // Read deployment for asset address
  const dep = await readLatestDeployment(network);
  const asset: string = dep.params?.ASSET_TOKEN || dep.contracts?.DXPToken;
  if (!asset) throw new Error('Could not resolve asset token from deployments');

  // Note: Do not attempt on-chain approvals here; server will use its signer.

  // Build payload
  const payload = {
    network: network as 'localhost',
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

  // Print request payload
  console.log('Request Payload:');
  console.log(JSON.stringify(payload, null, 2));
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
