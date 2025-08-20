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

  // SSV template overrides (use placeholders if not available locally)
  const ssvNetwork = dep.contracts?.ProtocolCore || '0x0000000000000000000000000000000000000001';
  const ssvToken = dep.contracts?.DXPToken || asset;
  const withdrawalCredentials = '0x' + '00'.repeat(32);
  const operatorIds = [1, 2, 3, 4];

  // BridgingAdapter from deployment (required for SSV postDeploy setter)
  const bridgingAdapter: string | undefined = dep.contracts?.BridgingAdapter;
  if (!bridgingAdapter) {
    throw new Error('BridgingAdapter not found in deployment. Please run deploy-v3.ts (or deploy-v3_withMock.ts) to deploy and write contracts.BridgingAdapter, then re-run this script.');
  }

  const items: any[] = [
    // 60% allocation to SSV Node staking with bridging enabled via postDeploy setter
    {
      templateId: 'staking.node.ssv.v1',
      overrides: {
        ssvNetwork,
        ssvToken,
        withdrawalCredentials,
        operatorIds,
        bridgingAdapter,
        minDeposit,
        minWithdraw,
      },
      bps: 6000,
    },
    // 40% allocation to Lido liquid staking adapter (UniV3 WETH->wstETH)
    {
      templateId: 'staking.liquid.lido.v1',
      overrides: {
        // Use lowercase to bypass checksum validation in local runs
        wstETH: '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452',
        swapRouter: '0x2626664c2603336e57b271c5c0b26f421741e481',
        quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
        poolFee: 100,
        minDeposit,
        minWithdraw,
      },
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
