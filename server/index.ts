import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { deployAdapterFromTemplateAndWire } from './services/strategyService';
import { loadStrategyCatalog } from './services/catalog';

dotenv.config();

// Verbose logging toggle
const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';
const dbg = (...args: unknown[]) => { if (VERBOSE) console.log('[debug]', ...args); };

// ---- Types (runtime validated via zod) ----
const addr = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const bytes32 = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

const StrategySchema = z.object({
  key: bytes32,
  adapter: addr.optional(),
  bps: z.number().int().min(0).max(10000),
});

const FarmCreationPayloadSchema = z.object({
  creator: addr,
  asset: addr,
  farmName: z.string().min(1),
  farmSymbol: z.string().min(1),
  recipients: z.object({ ownerRecipient: addr }),
  splits: z.object({
    lpBps: z.number().int().min(0).max(10000),
    ownerBps: z.number().int().min(0).max(10000),
    verifierBps: z.number().int().min(0).max(10000),
  }),
  lockConfig: z.object({
    enabled: z.boolean(),
    allowEarlyExit: z.boolean(),
    earlyExitBps: z.number().int().min(0).max(10000),
    lockupSeconds: z.number().int().min(0),
    postLockMode: z.number().int().min(0).max(255),
  }),
  payoutConfig: z.object({
    mode: z.union([z.literal('Stream'), z.literal('Lockup'), z.number().int().min(0).max(1)]),
    streamBps: z.number().int().min(0).max(10000),
    compoundBps: z.number().int().min(0).max(10000),
    epochSeconds: z.number().int().min(1),
    minHarvestIntervalSeconds: z.number().int().min(0),
    compoundLpOnLock: z.boolean(),
  }),
  strategies: z.array(StrategySchema).optional(),
  shareToken: z.object({
    transferable: z.boolean(),
    transferFeeBps: z.number().int().min(0).max(1500),
    feeReceiver: addr.optional(),
    protocolFeeReceiver: addr.optional(),
    protocolRakeBps: z.number().int().min(0).max(2000).optional(),
  }).optional(),
  meta: z.object({ chainId: z.number().int().optional() }).optional(),
});

const CreateFarmRequestSchema = z.object({
  network: z.enum(['localhost', 'hardhat', 'basesepolia', 'base']),
  payload: FarmCreationPayloadSchema,
  addresses: z.object({
    protocolCore: addr.optional(),
    farmFactory: addr.optional(),
  }).optional(),
  ownerPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});

 

// ---- Minimal ABIs ----
const ProtocolCoreAbi = [
  'function owner() view returns (address)',
  'function approvedFarmOwners(address) view returns (bool)',
  'function setApprovedFarmOwner(address who,bool approved)',
  'function createApprovedFarm(address asset,string farmName,string farmSymbol,address ownerRecipient,uint16 lpBps,uint16 ownerBps,uint16 verifierBps,tuple(bool enabled,bool allowEarlyExit,uint16 earlyExitBps,uint256 lockupSeconds,uint8 postLockMode) lockCfg,tuple(uint8 mode,uint16 streamBps,uint16 compoundBps,uint256 epoch,uint256 minHarvestInterval,bool compoundLpOnLock) payoutCfg,tuple(bool transferable,uint16 transferFeeBps,address feeReceiver,address protocolFeeReceiver,uint16 protocolRakeBps) stCfg,bytes32[] adapterKeys,address[] adapterAddrs,uint16[] adapterBps) returns (uint256 farmIdOut,address baseFarm)',
  'function createApprovedFarmFor(address creator,address asset,string farmName,string farmSymbol,address ownerRecipient,uint16 lpBps,uint16 ownerBps,uint16 verifierBps,tuple(bool enabled,bool allowEarlyExit,uint16 earlyExitBps,uint256 lockupSeconds,uint8 postLockMode) lockCfg,tuple(uint8 mode,uint16 streamBps,uint16 compoundBps,uint256 epoch,uint256 minHarvestInterval,bool compoundLpOnLock) payoutCfg,tuple(bool transferable,uint16 transferFeeBps,address feeReceiver,address protocolFeeReceiver,uint16 protocolRakeBps) stCfg,bytes32[] adapterKeys,address[] adapterAddrs,uint16[] adapterBps) returns (uint256 farmIdOut,address baseFarm)',
  'function farmsById(uint256) view returns (address baseFarm,address owner,address asset,uint256 farmId,address router,address payoutPolicy,address lockupPolicy,address stakeholderRegistry)'
];

const FarmCreatedEvent = [
  'event FarmCreated(uint256 indexed farmId,address indexed baseFarm,address indexed owner,address router,address payoutPolicy,address lockupPolicy,address stakeholderRegistry)'
];

// Minimal ABIs for BaseFarm and ShareToken configuration
const BaseFarmAbi = [
  'function shareToken() view returns (address)'
];
const ShareTokenAbi = [
  'function setTransferable(bool enabled)',
  'function setTransferFeeBps(uint16 bps)',
  'function setFeeReceiver(address receiver)',
  'function setProtocolFee(address receiver,uint16 rakeBps)',
  'function protocolFeeReceiver() view returns (address)',
  'function protocolRakeBps() view returns (uint16)'
];

// ---- Helpers ----
function resolveRpcUrl(network: 'localhost'|'hardhat'|'basesepolia'|'base'): string {
  switch (network) {
    case 'localhost':
    case 'hardhat':
      return process.env.LOCALHOST_RPC_URL || 'http://127.0.0.1:8545';
    case 'basesepolia':
      return process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
    case 'base':
      return process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
  }
}

function resolveSignerKey(network: string, fallback?: string): string | undefined {
  if (fallback) return fallback;
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  switch (network) {
    case 'localhost':
    case 'hardhat':
      return process.env.LOCALHOST_PRIVATE_KEY;
    case 'basesepolia':
      return process.env.BASE_SEPOLIA_PRIVATE_KEY;
    case 'base':
      return process.env.BASE_MAINNET_PRIVATE_KEY;
    default:
      return undefined;
  }
}

async function readLatestDeploymentFor(network: string): Promise<any | undefined> {
  try {
    const dir = path.join(process.cwd(), 'deployments', network);
    const files = await fs.readdir(dir);
    const jsons = files.filter(f => f.endsWith('.json'));
    if (jsons.length === 0) return undefined;
    // Pick the most recently modified file to avoid stale selections (e.g., v3.json)
    const withTimes = await Promise.all(jsons.map(async f => ({
      file: f,
      mtime: (await fs.stat(path.join(dir, f))).mtimeMs,
    })));
    withTimes.sort((a, b) => a.mtime - b.mtime);
    const latest = withTimes[withTimes.length - 1].file;
    const raw = await fs.readFile(path.join(dir, latest), 'utf8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toPayoutMode(v: string | number): number {
  if (typeof v === 'number') return v;
  return v === 'Lockup' ? 1 : 0;
}

function assertSplitSum(lp: number, owner: number, verifier: number) {
  if (lp + owner + verifier !== 10000) {
    throw new Error('Split must sum to 10000');
  }
}

function ensureStrategiesSum(strats?: { bps: number }[]) {
  if (!strats || strats.length === 0) return;
  const sum = strats.reduce((a, s) => a + s.bps, 0);
  if (sum !== 10000) throw new Error('Strategy bps must sum to 10000');
}

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Request logger (method, path, status, duration)
  app.use((req: Request, res: Response, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      console.log(`[${req.method}] ${req.originalUrl} -> ${res.statusCode} ${ms}ms`);
    });
    dbg('headers', req.headers);
    next();
  });

  // Atomic: create farm, deploy adapters from templates, wire router and set allocations
  const CreateFarmWithStrategiesRequestSchema = z.object({
    network: z.enum(['localhost', 'hardhat', 'basesepolia', 'base']),
    ownerPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    payload: FarmCreationPayloadSchema, // strategies field may be provided but is ignored here
    addresses: z.object({ protocolCore: addr.optional(), farmFactory: addr.optional() }).optional(),
    items: z.array(z.object({
      templateId: z.string(),
      overrides: z.record(z.any()).optional(),
      bps: z.number().int().min(0).max(10000),
    })).min(1),
  });

  app.post('/api/v3/create-farm-with-strategies', async (req: Request, res: Response) => {
    try {
      console.log('POST /api/v3/create-farm-with-strategies');
      const parsed = CreateFarmWithStrategiesRequestSchema.parse(req.body);
      const { network, payload } = parsed;

      // pre-validate
      assertSplitSum(payload.splits.lpBps, payload.splits.ownerBps, payload.splits.verifierBps);
      const itemsSum = parsed.items.reduce((a, b) => a + b.bps, 0);
      if (itemsSum !== 10000) return res.status(400).json({ error: 'Sum of bps must equal 10000' });

      const rpcUrl = resolveRpcUrl(network);
      const pk = resolveSignerKey(network, parsed.ownerPrivateKey);
      if (!pk) return res.status(400).json({ error: 'No signer private key available' });
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const baseSigner = new ethers.Wallet(pk, provider);
      const signer = new ethers.NonceManager(baseSigner);
      const signerAddr = await signer.getAddress();

      // Resolve addresses from request or deployments
      let protocolCore = parsed.addresses?.protocolCore;
      let farmFactory = parsed.addresses?.farmFactory;
      if (!protocolCore || !farmFactory) {
        const dep = await readLatestDeploymentFor(network);
        protocolCore = protocolCore || dep?.contracts?.ProtocolCore;
        farmFactory = farmFactory || dep?.contracts?.FarmFactory;
      }
      if (!protocolCore) return res.status(400).json({ error: 'Missing ProtocolCore address' });

      const core = new ethers.Contract(protocolCore, ProtocolCoreAbi, signer);
      const coreOwner: string = await core.owner();
      const isProtocolOwner = coreOwner.toLowerCase() === signerAddr.toLowerCase();
      if (isProtocolOwner) {
        const creatorApproved: boolean = await core.approvedFarmOwners(payload.creator);
        if (!creatorApproved) {
          const approveTx = await core.setApprovedFarmOwner(payload.creator, true);
          await approveTx.wait();
        }
      } else {
        const signerApproved: boolean = await core.approvedFarmOwners(signerAddr);
        if (!signerApproved) return res.status(403).json({ error: 'Signer is not an approved farm owner in ProtocolCore' });
        if (payload.creator.toLowerCase() !== signerAddr.toLowerCase()) {
          return res.status(403).json({ error: 'Only protocol owner may create farms for another creator' });
        }
      }

      // Build configs
      const lockCfg = {
        enabled: payload.lockConfig.enabled,
        allowEarlyExit: payload.lockConfig.allowEarlyExit,
        earlyExitBps: payload.lockConfig.earlyExitBps,
        lockupSeconds: payload.lockConfig.lockupSeconds,
        postLockMode: payload.lockConfig.postLockMode,
      };
      const payoutCfg = {
        mode: toPayoutMode(payload.payoutConfig.mode),
        streamBps: payload.payoutConfig.streamBps,
        compoundBps: payload.payoutConfig.compoundBps,
        epoch: payload.payoutConfig.epochSeconds,
        minHarvestInterval: payload.payoutConfig.minHarvestIntervalSeconds,
        compoundLpOnLock: payload.payoutConfig.compoundLpOnLock,
      };
      const stCfg = {
        transferable: payload.shareToken ? payload.shareToken.transferable : true,
        transferFeeBps: payload.shareToken ? payload.shareToken.transferFeeBps : 0,
        feeReceiver: payload.shareToken?.feeReceiver ?? ethers.ZeroAddress,
        protocolFeeReceiver: payload.shareToken?.protocolFeeReceiver ?? ethers.ZeroAddress,
        protocolRakeBps: payload.shareToken?.protocolRakeBps ?? 0,
      };

      // Create farm with empty strategies first
      const tx = await core.createApprovedFarmFor(
        payload.creator,
        payload.asset,
        payload.farmName,
        payload.farmSymbol,
        payload.recipients.ownerRecipient,
        payload.splits.lpBps,
        payload.splits.ownerBps,
        payload.splits.verifierBps,
        lockCfg,
        payoutCfg,
        stCfg,
        [],
        [],
        []
      );
      const receipt = await tx.wait();

      const iface = new ethers.Interface([...ProtocolCoreAbi, ...FarmCreatedEvent]);
      let farmId: string | undefined;
      let modules: any = {};
      for (const log of receipt.logs) {
        try {
          const parsedLog = iface.parseLog(log);
          if (parsedLog?.name === 'FarmCreated') {
            farmId = (parsedLog.args[0] as bigint).toString();
            modules = {
              baseFarm: parsedLog.args[1] as string,
              owner: parsedLog.args[2] as string,
              router: parsedLog.args[3] as string,
              payoutPolicy: parsedLog.args[4] as string,
              lockupPolicy: parsedLog.args[5] as string,
              stakeholderRegistry: parsedLog.args[6] as string,
            };
            break;
          }
        } catch {}
      }
      if (!farmId) return res.status(500).json({ error: 'Failed to resolve new farm id' });
      if (!modules.router) {
        const all = await core.farmsById(farmId);
        modules = {
          baseFarm: all[0], owner: all[1], asset: all[2], farmId: (all[3] as bigint).toString(),
          router: all[4], payoutPolicy: all[5], lockupPolicy: all[6], stakeholderRegistry: all[7],
        };
      }

      const routerAddr: string = modules.router;

      // Deploy adapters for this router (deployOnly=true to defer allocation)
      const perItem: Array<{
        templateId: string;
        adapter: string;
        strategyKey: string;
        txs: { deploy: string; configs: string[] };
        bps: number;
      }> = [];
      for (const it of parsed.items) {
        const r = await deployAdapterFromTemplateAndWire(network, {
          provider,
          signer,
          router: routerAddr,
          templateId: it.templateId,
          overrides: it.overrides,
          bps: 0,
          deployOnly: true,
        });
        perItem.push({
          templateId: it.templateId,
          adapter: r.adapter,
          strategyKey: r.strategyKeyUsed,
          txs: { deploy: r.deployTxHash, configs: r.configTxHashes },
          bps: it.bps,
        });
      }

      // Set allocations in a single call
      const RouterSetAllocAbi = ['function setAllocations(bytes32[] ids,address[] adapters,uint16[] bps) external'];
      const routerC = new ethers.Contract(routerAddr, RouterSetAllocAbi, signer);
      const ids = perItem.map(i => i.strategyKey);
      const adapters = perItem.map(i => i.adapter);
      const bps = perItem.map(i => i.bps);
      const setTx = await routerC.setAllocations(ids, adapters, bps);
      const setRc = await setTx.wait();

      return res.json({
        network,
        txs: { createFarm: receipt.hash, allocation: setRc.hash },
        farm: { id: farmId, modules },
        router: routerAddr,
        items: perItem,
      });
    } catch (err: any) {
      console.error('Error in /api/v3/create-farm-with-strategies', err);
      return res.status(500).json({ error: err?.message || 'Unknown error' });
    }
  });

  

  

  app.get('/health', (_req: Request, res: Response) => {
    console.log('GET /health');
    res.json({ ok: true });
  });

  // Expose strategy catalog for frontend to render choices
  app.get('/api/v3/catalog', async (req: Request, res: Response) => {
    try {
      const network = (req.query.network as string) as 'localhost'|'hardhat'|'basesepolia'|'base' || 'base';
      const catalog = await loadStrategyCatalog(network);
      return res.json({ network, ...catalog });
    } catch (err: any) {
      console.error('Error in /api/v3/catalog', err);
      return res.status(500).json({ error: err?.message || 'Unknown error' });
    }
  });

  app.post('/api/v3/create-farm', async (req: Request, res: Response) => {
    try {
      console.log('POST /api/v3/create-farm');
      const parsed = CreateFarmRequestSchema.parse(req.body);
      const { network, payload } = parsed;
      dbg('payload.creator', payload.creator);
      dbg('payload.asset', payload.asset);

      // pre-validate
      assertSplitSum(payload.splits.lpBps, payload.splits.ownerBps, payload.splits.verifierBps);
      ensureStrategiesSum(payload.strategies);
      dbg('splits', payload.splits);
      dbg('strategies', payload.strategies);
      if (payload.shareToken) {
        dbg('shareToken', payload.shareToken);
        if (payload.shareToken.transferFeeBps > 0 && !payload.shareToken.feeReceiver) {
          return res.status(400).json({ error: 'shareToken.feeReceiver required when transferFeeBps > 0' });
        }
      }

      const rpcUrl = resolveRpcUrl(network);
      const pk = resolveSignerKey(network, parsed.ownerPrivateKey);
      if (!pk) {
        console.warn('No signer private key available');
        return res.status(400).json({ error: 'No signer private key available' });
      }

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const baseSigner = new ethers.Wallet(pk, provider);
      const signer = new ethers.NonceManager(baseSigner);
      const signerAddr = await signer.getAddress();
      console.log('rpcUrl', rpcUrl);
      console.log('signer', signerAddr);

      // Note: We no longer require signer == payload.creator.
      // Server uses env key (protocol owner) to deploy. ProtocolCore must authorize this signer.

      // Resolve addresses from request or deployments (ProtocolCore required; FarmFactory optional)
      let protocolCore = parsed.addresses?.protocolCore;
      let farmFactory = parsed.addresses?.farmFactory;
      if (!protocolCore || !farmFactory) {
        const dep = await readLatestDeploymentFor(network);
        if (!dep && !protocolCore) {
          return res.status(400).json({ error: `No deployments found for network ${network} and no addresses provided` });
        }
        protocolCore = protocolCore || dep?.contracts?.ProtocolCore;
        farmFactory = farmFactory || dep?.contracts?.FarmFactory;
      }
      if (!protocolCore) {
        return res.status(400).json({ error: 'Missing ProtocolCore address' });
      }
      console.log('Using ProtocolCore', protocolCore);
      if (farmFactory) {
        console.log('Using FarmFactory', farmFactory);
      } else {
        console.warn('FarmFactory not found in request or deployments; continuing without it');
      }

      const iface = new ethers.Interface([...ProtocolCoreAbi, ...FarmCreatedEvent]);
      const core = new ethers.Contract(protocolCore, ProtocolCoreAbi, signer);
      const coreOwner: string = await core.owner();
      const isProtocolOwner = coreOwner.toLowerCase() === signerAddr.toLowerCase();
      if (isProtocolOwner) {
        const creatorApproved: boolean = await core.approvedFarmOwners(payload.creator);
        console.log('creator.approvedFarmOwner', creatorApproved);
        if (!creatorApproved) {
          console.log('Approving creator as farm owner in ProtocolCore...');
          const approveTx = await core.setApprovedFarmOwner(payload.creator, true);
          console.log('approveTxHash', approveTx.hash);
          await approveTx.wait();
          console.log('Creator approved');
        }
      } else {
        const signerApproved: boolean = await core.approvedFarmOwners(signerAddr);
        console.log('signer.approvedFarmOwner', signerApproved);
        if (!signerApproved) {
          return res.status(403).json({ error: 'Signer is not an approved farm owner in ProtocolCore' });
        }
        if (payload.creator.toLowerCase() !== signerAddr.toLowerCase()) {
          return res.status(403).json({ error: 'Only protocol owner may create farms for another creator' });
        }
      }

      // Build configs
      const lockCfg = {
        enabled: payload.lockConfig.enabled,
        allowEarlyExit: payload.lockConfig.allowEarlyExit,
        earlyExitBps: payload.lockConfig.earlyExitBps,
        lockupSeconds: payload.lockConfig.lockupSeconds,
        postLockMode: payload.lockConfig.postLockMode,
      };
      const payoutCfg = {
        mode: toPayoutMode(payload.payoutConfig.mode),
        streamBps: payload.payoutConfig.streamBps,
        compoundBps: payload.payoutConfig.compoundBps,
        epoch: payload.payoutConfig.epochSeconds,
        minHarvestInterval: payload.payoutConfig.minHarvestIntervalSeconds,
        compoundLpOnLock: payload.payoutConfig.compoundLpOnLock,
      };
      dbg('lockCfg', lockCfg);
      dbg('payoutCfg', payoutCfg);

      // Build ShareToken config (defaults preserve on-chain defaults if not provided)
      const stCfg = {
        transferable: payload.shareToken ? payload.shareToken.transferable : true,
        transferFeeBps: payload.shareToken ? payload.shareToken.transferFeeBps : 0,
        feeReceiver: payload.shareToken?.feeReceiver ?? ethers.ZeroAddress,
        protocolFeeReceiver: payload.shareToken?.protocolFeeReceiver ?? ethers.ZeroAddress,
        protocolRakeBps: payload.shareToken?.protocolRakeBps ?? 0,
      };

      type Strategy = { key: string; adapter?: string; bps: number };
      const strategies: Strategy[] = (payload.strategies as unknown as Strategy[]) || [];
      const adapterKeys = strategies.map((s: Strategy) => s.key);
      const adapterAddrs = strategies.map((s: Strategy) => s.adapter || ethers.ZeroAddress);
      const adapterBps = strategies.map((s: Strategy) => s.bps);
      dbg('adapterKeys', adapterKeys);
      dbg('adapterAddrs', adapterAddrs);
      dbg('adapterBps', adapterBps);

      // Call createApprovedFarm
      console.log('Submitting createApprovedFarmFor');
      const tx = await core.createApprovedFarmFor(
        payload.creator,
        payload.asset,
        payload.farmName,
        payload.farmSymbol,
        payload.recipients.ownerRecipient,
        payload.splits.lpBps,
        payload.splits.ownerBps,
        payload.splits.verifierBps,
        lockCfg,
        payoutCfg,
        stCfg,
        adapterKeys,
        adapterAddrs,
        adapterBps
      );
      console.log('txHash', tx.hash);
      const receipt = await tx.wait();
      console.log('mined', receipt.blockNumber);

      // Try to parse VaultCreated
      let farmId: string | undefined;
      let modules: any = {};
      try {
        for (const log of receipt.logs) {
          try {
            const parsedLog = iface.parseLog(log);
            if (parsedLog?.name === 'FarmCreated') {
              farmId = (parsedLog.args[0] as bigint).toString();
              modules = {
                baseFarm: parsedLog.args[1] as string,
                owner: parsedLog.args[2] as string,
                router: parsedLog.args[3] as string,
                payoutPolicy: parsedLog.args[4] as string,
                lockupPolicy: parsedLog.args[5] as string,
                stakeholderRegistry: parsedLog.args[6] as string,
              };
              break;
            }
          } catch {}
        }
      } catch {}
      if (farmId) console.log('VaultCreated event farmId', farmId);

      // If not found in logs, fall back to view
      if (!farmId) {
        // Heuristic: last farm id increments; try a small search window
        // In strict mode, client can query separately.
      }

      // If still missing some fields, query vaultsById
      if (farmId) {
        const all = await core.farmsById(farmId);
        modules = {
          baseFarm: all[0],
          owner: all[1],
          asset: all[2],
          farmId: (all[3] as bigint).toString(),
          router: all[4],
          payoutPolicy: all[5],
          lockupPolicy: all[6],
          stakeholderRegistry: all[7],
        };
        console.log('Modules', modules);
      }

      // Fetch ShareToken address for response if baseFarm resolved
      try {
        const baseFarmAddr: string | undefined = modules.baseFarm as string | undefined;
        if (baseFarmAddr && baseFarmAddr !== ethers.ZeroAddress) {
          const farm = new ethers.Contract(baseFarmAddr, BaseFarmAbi, signer);
          const stAddr: string = await farm.shareToken();
          (modules as any).shareToken = stAddr;
        }
      } catch {}

      return res.json({
        network,
        protocolCore,
        farmFactory,
        txHash: receipt.hash,
        farmId,
        modules,
      });
    } catch (err: any) {
      console.error('Error in /api/v3/create-farm', err);
      const msg = err?.message || 'Unknown error';
      return res.status(500).json({ error: msg });
    }
  });

  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => {
    console.log(`Dexponent v3 API listening on :${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
