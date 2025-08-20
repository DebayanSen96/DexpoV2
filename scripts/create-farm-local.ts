import fs from 'fs/promises';
import path from 'path';

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
  const serverUrl = 'http://127.0.0.1:3001';

  // Creator address to assign farm ownership to (no private key needed)
  const creator = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Hardhat default account[0]

  // Read deployment for asset address
  const dep = await readDeployment(network);
  const asset: string = dep.params?.ASSET_TOKEN || dep.contracts?.DXPToken;
  if (!asset) throw new Error('Could not resolve asset token from deployments');

  // Note: Do not attempt on-chain approvals here; server will use its signer.

  // Build payload
  const payload = {
    network: network as 'localhost',
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
  console.log('POST', `${serverUrl}/api/v3/create-farm`);

  // POST to server
  const res = await fetch(`${serverUrl}/api/v3/create-farm`, {
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

  // For test purposes, use local placeholder addresses for overrides
  // These contracts are placeholders for local testing; no swaps/bridges will be executed in this script.
  const wstETH: string | undefined = dep.params?.ASSET_TOKEN || dep.contracts?.DXPToken;
  const swapRouter: string | undefined = dep.contracts?.MockLiquidityManager || dep.contracts?.FarmFactory;
  const quoter: string | undefined = dep.contracts?.FarmFactory || dep.contracts?.ProtocolCore;
  if (!wstETH || !swapRouter || !quoter) {
    console.log('Missing mock addresses in deployments for adapter params; skipping strategy deployment test.');
    return;
  }

  const poolFee = 500;
  const slippageBps = 30;
  const minDeposit = '0';
  const minWithdraw = '0';
  const bps = 10000;

  // 2a) Deploy legacy UniV3 adapter (earlier flow) with deployOnly=true
  const legacyReq: any = {
    network: payload.network,
    router,
    bps,
    deployOnly: true,
    wstETH,
    swapRouter,
    quoter,
    poolFee,
    slippageBps,
    minDeposit,
    minWithdraw,
  };
  console.log('Legacy Strategy Request Payload (deployOnly):');
  console.log(JSON.stringify(legacyReq, null, 2));
  console.log('POST', `${serverUrl}/api/v3/strategies/deploy-and-wire`);
  const legacyRes = await fetch(`${serverUrl}/api/v3/strategies/deploy-and-wire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(legacyReq),
  });
  const legacyText = await legacyRes.text();
  console.log('Legacy Strategy Status:', legacyRes.status);
  try {
    const legacyJson = JSON.parse(legacyText);
    console.log('Legacy Strategy Response JSON:');
    console.log(JSON.stringify(legacyJson, null, 2));
  } catch {
    console.log('Legacy Strategy Response Text:');
    console.log(legacyText);
  }

  // 2b) Deploy a new template-based adapter (SSV preferred, fallback to Stargate)
  // Prepare SSV overrides (dummy non-zero addresses ok for localhost)
  const ssvNetwork = dep.contracts?.ProtocolCore || router; // any non-zero address
  const ssvToken = dep.contracts?.DXPToken || asset;        // any non-zero address
  const withdrawalCredentials = '0x' + '00'.repeat(32);     // bytes32
  const operatorIds = [1, 2, 3, 4];

  // If SSV required addresses are unavailable, fallback to Stargate template
  const canUseSSV = Boolean(ssvNetwork && ssvToken);
  const templateId = canUseSSV ? 'staking.node.ssv.v1' : 'bridge.stargate.v1';

  const templateOverrides: any = canUseSSV
    ? {
        ssvNetwork,
        ssvToken,
        withdrawalCredentials,
        operatorIds,
        minDeposit,
        minWithdraw,
      }
    : {
        stargateRouter: dep.contracts?.FarmFactory || router,
        lzEndpoint: dep.contracts?.ProtocolCore || router,
        poolId: 1,
        dstChainId: 100,
        minDeposit,
        minWithdraw,
      };

  const tmplReq = {
    network: payload.network,
    router,
    bps,
    deployOnly: false,
    templateId,
    overrides: templateOverrides,
  };
  console.log('Template Strategy Request Payload:');
  console.log(JSON.stringify(tmplReq, null, 2));
  console.log('POST', `${serverUrl}/api/v3/strategies/deploy-and-wire`);
  const tmplRes = await fetch(`${serverUrl}/api/v3/strategies/deploy-and-wire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tmplReq),
  });
  const tmplText = await tmplRes.text();
  console.log('Template Strategy Status:', tmplRes.status);
  try {
    const tmplJson = JSON.parse(tmplText);
    console.log('Template Strategy Response JSON:');
    console.log(JSON.stringify(tmplJson, null, 2));
  } catch {
    console.log('Template Strategy Response Text:');
    console.log(tmplText);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
