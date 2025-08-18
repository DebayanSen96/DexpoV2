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
  const serverUrl = 'http://127.0.0.1:3001';

  // Creator address to assign vault ownership to (no private key needed)
  const creator = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Hardhat default account[0]

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
  let json: any | undefined;
  try {
    json = JSON.parse(text);
    console.log('Response JSON:');
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log('Response Text:');
    console.log(text);
  }

  // Step 2: Deploy and wire strategy using returned router
  const router: string | undefined = json?.modules?.router;
  if (!router) {
    console.log('No router in response; skipping strategy deployment test.');
    return;
  }

  // For test purposes, hardcode adapter params from the latest deployment
  // These contracts are placeholders for local testing; no swaps will be executed in this script.
  const wstETH: string | undefined = dep.params?.ASSET_TOKEN || dep.contracts?.DXPToken;
  const swapRouter: string | undefined = dep.contracts?.MockLiquidityManager || dep.contracts?.FarmFactory;
  const quoter: string | undefined = dep.contracts?.VaultFactory || dep.contracts?.ProtocolCore;
  if (!wstETH || !swapRouter || !quoter) {
    console.log('Missing mock addresses in deployments for adapter params; skipping strategy deployment test.');
    return;
  }

  const poolFee = 500;
  const slippageBps = 30;
  const minDeposit = '0';
  const minWithdraw = '0';
  const bps = 10000;

  const stratReq: any = {
    network: payload.network,
    router,
    bps,
    deployOnly: false,
    wstETH,
    swapRouter,
    quoter,
    poolFee,
    slippageBps,
  };
  if (minDeposit !== undefined) stratReq.minDeposit = minDeposit;
  if (minWithdraw !== undefined) stratReq.minWithdraw = minWithdraw;

  console.log('Strategy Request Payload:');
  console.log(JSON.stringify(stratReq, null, 2));
  console.log('POST', `${serverUrl}/api/v3/strategies/deploy-and-wire`);

  const sres = await fetch(`${serverUrl}/api/v3/strategies/deploy-and-wire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(stratReq),
  });
  const stext = await sres.text();
  console.log('Strategy Status:', sres.status);
  try {
    const sjson = JSON.parse(stext);
    console.log('Strategy Response JSON:');
    console.log(JSON.stringify(sjson, null, 2));
  } catch {
    console.log('Strategy Response Text:');
    console.log(stext);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
