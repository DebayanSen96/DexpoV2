import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs/promises';

export type Network = 'localhost' | 'hardhat' | 'basesepolia' | 'base';

export type DeployUniV3AdapterParams = {
  provider: ethers.JsonRpcProvider;
  signer: ethers.Signer;
  router: string;
  strategyKey?: string; // bytes32 hex; if missing, will be computed as bytes32(adapterAddr)
  bps?: number; // default 10000
  baseAsset?: string; // if missing, will fetch from router.asset()
  deployOnly?: boolean; // if true, skip setAllocations (just deploy and config)
  // Adapter constructor params (with network defaults)
  wstETH?: string;
  swapRouter?: string;
  quoter?: string;
  poolFee?: number; // e.g. 100
  // Optional adapter settings via setters
  slippageBps?: number;
  minDeposit?: bigint | string | number;
  minWithdraw?: bigint | string | number;
};

// Minimal ABIs
const StrategyRouterAbi = [
  'function asset() view returns (address)',
  'function owner() view returns (address)',
  'function setAllocations(bytes32[] ids,address[] adapters,uint16[] bps) external',
];

const UniV3AdapterArtifactPath = path.join(
  process.cwd(),
  'artifacts',
  'contracts',
  'v3',
  'adapters',
  'UniV3WethToWstETHAdapter.sol',
  'UniV3WethToWstETHAdapter.json'
);

async function loadUniV3AdapterArtifact(): Promise<{ abi: any; bytecode: string }>{
  const raw = await fs.readFile(UniV3AdapterArtifactPath, 'utf8');
  const json = JSON.parse(raw);
  const { abi, bytecode } = json;
  if (!abi || !bytecode) throw new Error('Invalid UniV3 adapter artifact');
  return { abi, bytecode };
}

// Known defaults per network (override-able)
export function defaultsForNetwork(network: Network) {
  switch (network) {
    case 'base':
      return {
        // Base mainnet
        wstETH: '0xc1CbA3fCEa344f92D9239C08C0568F6F2F0eE452',
        swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
        quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
        poolFee: 100,
      };
    case 'basesepolia':
      // Provide sensible placeholders; strongly recommend passing explicit addresses in request
      return {
        wstETH: undefined,
        swapRouter: undefined,
        quoter: undefined,
        poolFee: 500,
      };
    case 'localhost':
    case 'hardhat':
      return {
        wstETH: undefined,
        swapRouter: undefined,
        quoter: undefined,
        poolFee: 500,
      };
  }
}

export async function deployUniV3AdapterAndWire(
  network: Network,
  params: DeployUniV3AdapterParams
): Promise<{
  adapter: string;
  deployTxHash: string;
  configTxHashes: string[];
  allocationTxHash: string;
  strategyKeyUsed: string;
}> {
  const { provider, signer, router } = params;

  const routerC = new ethers.Contract(router, StrategyRouterAbi, signer);
  // Authorization is enforced on-chain. We no longer pre-check owner here
  // to allow ProtocolCore owner to call wiring per updated StrategyRouter.

  // Resolve base asset if not provided
  const baseAsset: string = params.baseAsset || (await routerC.asset());

  // Merge defaults
  const d = defaultsForNetwork(network);
  const wstETH = params.wstETH || d.wstETH;
  const swapRouter = params.swapRouter || d.swapRouter;
  const quoter = params.quoter || d.quoter;
  const poolFee = params.poolFee ?? d.poolFee;

  if (!wstETH || !swapRouter || !quoter || !poolFee) {
    throw new Error('Missing adapter params (wstETH/swapRouter/quoter/poolFee). Provide overrides or configure defaults for this network.');
  }

  // Load artifact and deploy
  const { abi, bytecode } = await loadUniV3AdapterArtifact();
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(baseAsset, wstETH, router, swapRouter, quoter, poolFee);
  const deployTx = contract.deploymentTransaction();
  const deployTxHash = deployTx?.hash || '';
  await contract.waitForDeployment();
  const adapterAddr: string = await contract.getAddress();
  const adapter = new ethers.Contract(adapterAddr, abi, signer);

  const configTxHashes: string[] = [];
  // Optional settings
  if (typeof params.slippageBps === 'number') {
    const tx = await adapter.setSlippageBps(params.slippageBps);
    const rc = await tx.wait();
    configTxHashes.push(rc.hash);
  }
  if (params.minDeposit !== undefined) {
    const val = BigInt(params.minDeposit as any);
    const tx = await adapter.setMinDeposit(val);
    const rc = await tx.wait();
    configTxHashes.push(rc.hash);
  }
  if (params.minWithdraw !== undefined) {
    const val = BigInt(params.minWithdraw as any);
    const tx = await adapter.setMinWithdraw(val);
    const rc = await tx.wait();
    configTxHashes.push(rc.hash);
  }

  // Compute or use provided key (bytes32). Default: bytes32(adapterAddr)
  let strategyKey = params.strategyKey;
  if (!strategyKey) {
    // bytes32(uint256(uint160(adapterAddr)))
    const addrNum = BigInt(adapterAddr);
    const key = '0x' + addrNum.toString(16).padStart(64, '0');
    strategyKey = key;
  } else {
    if (!ethers.isHexString(strategyKey, 32)) throw new Error('strategyKey must be bytes32 hex');
  }

  // Wire into router
  let allocationTxHash = '';
  if (!params.deployOnly) {
    const bps = params.bps ?? 10000;
    const setTx = await routerC.setAllocations([strategyKey], [adapterAddr], [bps]);
    const setRc = await setTx.wait();
    allocationTxHash = setRc.hash;
  }

  return {
    adapter: adapterAddr,
    deployTxHash,
    configTxHashes,
    allocationTxHash,
    strategyKeyUsed: strategyKey,
  };
}
