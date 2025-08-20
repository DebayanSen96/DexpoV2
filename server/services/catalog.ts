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

function templatesDirForNetwork(network: Network) {
  return path.join(process.cwd(), 'server', 'templates', network);
}

async function readAllJsonFilesRecursively(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = await readAllJsonFilesRecursively(full);
        out.push(...sub);
      } else if (e.isFile() && e.name.endsWith('.json')) {
        out.push(full);
      }
    }
  } catch {}
  return out;
}

async function loadTemplatesFromDir(dir: string): Promise<StrategyTemplate[]> {
  const files = await readAllJsonFilesRecursively(dir);
  const items: StrategyTemplate[] = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(f, 'utf8');
      const json = JSON.parse(raw);
      // Minimal validation
      if (!json || typeof json !== 'object') continue;
      if (!json.id || !json.artifact || !json.constructor || !Array.isArray(json.constructor.params)) continue;
      items.push(json as StrategyTemplate);
    } catch {}
  }
  return items;
}

export async function loadStrategyCatalog(network: Network): Promise<StrategyCatalog> {
  // Preferred: load from server/templates/<network>/**.json
  const dir = templatesDirForNetwork(network);
  const items = await loadTemplatesFromDir(dir);
  if (items.length > 0) {
    return { version: '1.0.0', items };
  }

  // Fallback: try templates from base network
  if (network !== 'base') {
    const baseItems = await loadTemplatesFromDir(templatesDirForNetwork('base'));
    if (baseItems.length > 0) return { version: '1.0.0', items: baseItems };
  }

  // Legacy fallback: single catalog file
  const p = catalogPathForNetwork(network);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const json = JSON.parse(raw);
    if (!json.items || !Array.isArray(json.items)) throw new Error('Invalid catalog: items missing');
    return json as StrategyCatalog;
  } catch (e: any) {
    if (network !== 'base') {
      try {
        const basePath = catalogPathForNetwork('base');
        const raw = await fs.readFile(basePath, 'utf8');
        const json = JSON.parse(raw);
        return json as StrategyCatalog;
      } catch {}
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
