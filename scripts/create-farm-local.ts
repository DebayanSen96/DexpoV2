import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

async function readDeployment(network: string) {
  const dir = path.join(process.cwd(), 'deployments', network);
  const filePath = path.join(dir, `${network}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not read deployment file ${filePath}: ${error}`);
  }
}

async function main() {
  // Config
  const network = 'localhost';
  const serverUrl = process.env.SERVER_URL || 'http://127.0.0.1:3001';

  // Creator address to assign farm ownership to (no private key needed)
  const creator = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Hardhat default account[0]

  // Read deployment for asset address
  const dep = await readDeployment(network);
  const asset: string = dep.params?.ASSET_TOKEN || dep.contracts?.DXPToken;
  if (!asset) throw new Error('Could not resolve asset token from deployments');

  // Note: Do not attempt on-chain approvals here; server will use its signer.

  // Strategy items for unified flow
  const minDeposit = '0';
  const minWithdraw = '0';

  // SSV template overrides (use local non-zero addresses)
  const ssvNetwork = dep.contracts?.ProtocolCore || '0x0000000000000000000000000000000000000001';
  const ssvToken = dep.contracts?.DXPToken || asset;
  const withdrawalCredentials = '0x' + '00'.repeat(32);
  const operatorIds = [1, 2, 3, 4];

  // Stargate template overrides (use local placeholders)
  const stargateRouter = dep.contracts?.FarmFactory || '0x0000000000000000000000000000000000000002';
  const lzEndpoint = dep.contracts?.ProtocolCore || '0x0000000000000000000000000000000000000003';

  const items: any[] = [
    {
      templateId: 'staking.node.ssv.v1',
      overrides: { ssvNetwork, ssvToken, withdrawalCredentials, operatorIds, minDeposit, minWithdraw },
      bps: 6000,
    },
    {
      templateId: 'bridge.stargate.v1',
      overrides: { stargateRouter, lzEndpoint, poolId: 1, dstChainId: 100, minDeposit, minWithdraw },
      bps: 4000,
    },
  ];

  // Build unified request payload
  const payload = {
    network: network as 'localhost',
    ownerPrivateKey: (process.env.LOCALHOST_PRIVATE_KEY || process.env.PRIVATE_KEY) as string | undefined,
    payload: {
      creator,
      asset,
      farmName: 'Local Test Farm',
      farmSymbol: 'LTF',
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
        transferFeeBps: 50,
        feeReceiver: creator,
        protocolFeeReceiver: creator,
        protocolRakeBps: 200,
      },
    },
    items,
  };

  // Print request payload
  console.log('Request Payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('POST', `${serverUrl}/api/v3/create-farm-with-strategies`);

  // POST to server
  const res = await fetch(`${serverUrl}/api/v3/create-farm-with-strategies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log('Status:', res.status);
  let json: any | undefined;
  try {
    json = JSON.parse(text);
    console.log('Response JSON:');
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log('Response Text:');
    console.log(text);
  }

  // Unified flow already created farm and allocated strategies.
  console.log('Unified flow complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
