import path from 'path';
import fs from 'fs/promises';
import type { Network } from './strategyService';

export type StrategyTemplate = {
  id: string;
  title?: string;
  kind?: string;
  path?: string[];
  artifact: string; // path to compiled artifact json
  constructor: { params: string[] }; // ordered param names
  defaults?: Record<string, any>;
  postDeploy?: {
    setters?: Array<{ fn: string; arg: string }>;
  };
};

export type StrategyCatalog = {
  version: string;
  items: StrategyTemplate[];
};

function catalogPathForNetwork(network: Network) {
  const file = `strategies.${network}.json`;
  return path.join(process.cwd(), 'server', 'catalog', file);
}

export async function loadStrategyCatalog(network: Network): Promise<StrategyCatalog> {
  const p = catalogPathForNetwork(network);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const json = JSON.parse(raw);
    if (!json.items || !Array.isArray(json.items)) throw new Error('Invalid catalog: items missing');
    return json as StrategyCatalog;
  } catch (e: any) {
    // Fallback: try base catalog when non-base network is missing
    if (network !== 'base') {
      const basePath = catalogPathForNetwork('base');
      const raw = await fs.readFile(basePath, 'utf8');
      const json = JSON.parse(raw);
      return json as StrategyCatalog;
    }
    throw new Error(`Strategy catalog not found for ${network}: ${e?.message || e}`);
  }
}

export async function getTemplate(network: Network, id: string): Promise<StrategyTemplate> {
  const cat = await loadStrategyCatalog(network);
  const t = cat.items.find(i => i.id === id);
  if (!t) throw new Error(`Template not found: ${id}`);
  return t;
}
