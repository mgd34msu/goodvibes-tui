import { networkInterfaces, homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerType = 'ollama' | 'lm-studio' | 'vllm' | 'llamacpp' | 'localai' | 'tgi' | 'jan' | 'gpt4all' | 'koboldcpp' | 'aphrodite' | 'unknown';

export interface DiscoveredServer {
  name: string;       // 'Ollama', 'LM Studio', 'local-192.168.1.50:8080'
  host: string;       // '127.0.0.1' or '192.168.1.50'
  port: number;
  baseURL: string;    // 'http://192.168.1.50:11434/v1'
  models: string[];   // ['llama3:latest', 'codellama:7b']
  serverType: ServerType;
  modelContextWindows?: Record<string, number>; // modelId -> context window tokens
}

export interface ScanResult {
  servers: DiscoveredServer[];
  scannedHosts: number;
  scannedPorts: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const PERSISTED_PATH = join(homedir(), '.goodvibes', 'tui', 'discovered-providers.json');

interface PersistedServer extends DiscoveredServer {
  lastSeen: number; // Unix ms timestamp
}

/** Load previously discovered providers from disk. Returns empty array if file doesn't exist. */
export function loadPersistedProviders(): DiscoveredServer[] {
  try {
    if (!existsSync(PERSISTED_PATH)) return [];
    const raw = readFileSync(PERSISTED_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    // Filter to only valid-shaped entries before trusting persisted data
    return parsed.filter((item): item is DiscoveredServer =>
      typeof item === 'object' && item !== null &&
      typeof (item as Record<string, unknown>).host === 'string' &&
      typeof (item as Record<string, unknown>).port === 'number' &&
      Array.isArray((item as Record<string, unknown>).models)
    );
  } catch {
    return [];
  }
}

/** Save discovered providers to disk. Merges with existing entries keyed by host:port. */
export function persistProviders(servers: DiscoveredServer[]): void {
  try {
    const now = Date.now();
    // Load existing persisted servers
    let existing: PersistedServer[] = [];
    if (existsSync(PERSISTED_PATH)) {
      try {
        const raw = readFileSync(PERSISTED_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          existing = (parsed as unknown[]).filter(
            (item): item is PersistedServer =>
              typeof item === 'object' && item !== null &&
              typeof (item as Record<string, unknown>).host === 'string' &&
              typeof (item as Record<string, unknown>).port === 'number' &&
              Array.isArray((item as Record<string, unknown>).models)
          );
        }
      } catch { existing = []; }
    }
    // Merge: update existing entries, add new ones
    const byKey = new Map(existing.map(s => [`${s.host}:${s.port}`, s]));
    for (const server of servers) {
      byKey.set(`${server.host}:${server.port}`, { ...server, lastSeen: now });
    }
    mkdirSync(dirname(PERSISTED_PATH), { recursive: true });
    writeFileSync(PERSISTED_PATH, JSON.stringify([...byKey.values()], null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal — persistence is best-effort
  }
}

/** Remove specific servers from the persisted file (by host:port). */
export function removePersistedProviders(toRemove: Array<{ host: string; port: number }>): void {
  if (toRemove.length === 0) return;
  try {
    if (!existsSync(PERSISTED_PATH)) return;
    const raw = readFileSync(PERSISTED_PATH, 'utf-8');
    const current = JSON.parse(raw) as PersistedServer[];
    if (!Array.isArray(current)) return;
    const removeKeys = new Set(toRemove.map(s => `${s.host}:${s.port}`));
    const filtered = current.filter(s => !removeKeys.has(`${s.host}:${s.port}`));
    writeFileSync(PERSISTED_PATH, JSON.stringify(filtered, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWN_PORTS = [1234, 1337, 2242, 4891, 5000, 5001, 7860, 8000, 8001, 8080, 11434];
const PROBE_TIMEOUT_MS = 200;
const MAX_CONCURRENT_PROBES = 50;
const METADATA_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

interface ProbeResult {
  host: string;
  port: number;
  models: string[];
  headers: Record<string, string>;
  responseBody: unknown;
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

async function asyncPool<T>(
  limit: number,
  items: T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p: Promise<void> = fn(item).then(() => { executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

// ---------------------------------------------------------------------------
// Subnet Detection
// ---------------------------------------------------------------------------

/**
 * Returns all host IPs to scan from local network interfaces.
 * Each non-internal, non-link-local IPv4 address yields its /24 subnet
 * (192.168.1.1 ... 192.168.1.254).
 */
function getLocalSubnets(): string[] {
  const ips: string[] = [];
  const ifaces = networkInterfaces();

  for (const iface of Object.values(ifaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // Skip link-local
      if (addr.address.startsWith('169.254.')) continue;

      const parts = addr.address.split('.');
      const prefix = parts.slice(0, 3).join('.');
      for (let i = 1; i <= 254; i++) {
        ips.push(`${prefix}.${i}`);
      }
    }
  }

  // Deduplicate (multiple interfaces on same subnet)
  return [...new Set(ips)];
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Probes a single host:port. Returns probe result or null on any failure.
 * Never throws.
 */
async function probeHost(
  host: string,
  port: number,
): Promise<ProbeResult | null> {
  // Attempt 1: /v1/models (OpenAI-compatible)
  const v1Result = await tryFetch(`http://${host}:${port}/v1/models`);
  if (v1Result !== null) {
    const models = extractV1Models(v1Result.body);
    if (models !== null) {
      return { host, port, models, headers: v1Result.headers, responseBody: v1Result.body };
    }
  }

  // Port 11434 with only /api/tags (no /v1/models) = old Ollama, can't use as OpenAI-compat provider.
  return null;
}

interface FetchResult {
  body: unknown;
  headers: Record<string, string>;
}

async function tryFetch(url: string): Promise<FetchResult | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value.toLowerCase(); });
    return { body, headers };
  } catch {
    return null;
  }
}

function extractV1Models(body: unknown): string[] | null {
  if (
    typeof body === 'object' &&
    body !== null &&
    'data' in body &&
    Array.isArray((body as Record<string, unknown>).data)
  ) {
    const data = (body as Record<string, unknown>).data as unknown[];
    const ids = data
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && 'id' in item && typeof (item as Record<string, unknown>).id === 'string',
      )
      .map((item) => item.id as string);
    return ids;
  }
  return null;
}


// ---------------------------------------------------------------------------
// Server Identification
// ---------------------------------------------------------------------------

/**
 * Heuristic identification of the server software.
 */
function identifyServer(
  port: number,
  headers: Record<string, string>,
  responseBody: unknown,
): ServerType {

  const headerValues = Object.entries(headers)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');

  // Model IDs as a flat string for pattern matching
  let modelIds = '';
  if (
    typeof responseBody === 'object' &&
    responseBody !== null &&
    'data' in responseBody &&
    Array.isArray((responseBody as Record<string, unknown>).data)
  ) {
    modelIds = ((responseBody as Record<string, unknown>).data as unknown[])
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && 'id' in item,
      )
      .map((item) => String(item.id))
      .join(' ');
  }

  if (port === 11434) return 'ollama';
  if (port === 1337) return 'jan';
  if (port === 4891) return 'gpt4all';
  if (port === 5001) return 'koboldcpp';
  if (port === 2242) return 'aphrodite';

  if (port === 1234 || headerValues.includes('lmstudio') || modelIds.includes('lmstudio')) {
    return 'lm-studio';
  }

  if (Object.keys(headers).some((k) => k.startsWith('x-vllm'))) return 'vllm';

  if (port === 8080) {
    const serverHeader = headers['server'] ?? '';
    if (serverHeader.includes('llama')) return 'llamacpp';
    if (serverHeader.includes('localai')) return 'localai';
  }

  if (headerValues.includes('text-generation-inference')) return 'tgi';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Context Window Detection
// ---------------------------------------------------------------------------

/**
 * Queries a discovered server for actual context window sizes of its models.
 * Returns a map of modelId -> contextWindow. Missing entries mean the server
 * didn't report a context length for that model.
 */
export async function fetchModelContextWindows(
  host: string,
  port: number,
  serverType: ServerType,
  models: string[],
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  switch (serverType) {
    case 'ollama': {
      // Ollama: POST /api/show for each model — parallel to avoid blocking pool slot
      await Promise.allSettled(
        models.map(async (model) => {
          try {
            const res = await fetch(`http://${host}:${port}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: model }),
              signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
            });
            if (!res.ok) return;
            const data = await res.json() as Record<string, unknown>;

            // Check model_info.context_length (newer Ollama)
            const modelInfo = data.model_info as Record<string, unknown> | undefined;
            if (modelInfo) {
              // Keys vary: could be "<arch>.context_length" or just "context_length"
              for (const [key, value] of Object.entries(modelInfo)) {
                if (key.endsWith('context_length') && typeof value === 'number' && value > 0) {
                  result[model] = value;
                  logger.info(`[Scan] ${model}: context ${value} tokens`);
                  break;
                }
              }
            }

            // Fallback: check parameters string for num_ctx
            if (!result[model] && typeof data.parameters === 'string') {
              const match = (data.parameters as string).match(/num_ctx\s+(\d+)/);
              if (match) {
                const ctxLen = parseInt(match[1], 10);
                result[model] = ctxLen;
                logger.info(`[Scan] ${model}: context ${ctxLen} tokens`);
              }
            }
          } catch (err) {
            logger.debug(`[Scan] Failed to fetch context window for ${model}: ${err}`);
          }
        })
      );
      break;
    }

    case 'vllm': {
      // vLLM: GET /v1/models/{id} returns max_model_len — parallel to avoid blocking pool slot
      await Promise.allSettled(
        models.map(async (model) => {
          try {
            const res = await fetch(`http://${host}:${port}/v1/models/${encodeURIComponent(model)}`, {
              signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
            });
            if (!res.ok) return;
            const data = await res.json() as Record<string, unknown>;
            if (typeof data.max_model_len === 'number' && data.max_model_len > 0) {
              result[model] = data.max_model_len;
              logger.info(`[Scan] ${model}: context ${data.max_model_len} tokens`);
            }
          } catch (err) {
            logger.debug(`[Scan] Failed to fetch context window for ${model}: ${err}`);
          }
        })
      );
      break;
    }

    case 'llamacpp': {
      // llama.cpp: GET /props returns default_generation_settings.n_ctx (server-wide)
      try {
        const res = await fetch(`http://${host}:${port}/props`, {
          signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
        });
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          const settings = data.default_generation_settings as Record<string, unknown> | undefined;
          if (settings && typeof settings.n_ctx === 'number' && settings.n_ctx > 0) {
            const ctxLen = settings.n_ctx as number;
            // llama.cpp typically serves one model, apply to all
            for (const model of models) {
              result[model] = ctxLen;
              logger.info(`[Scan] ${model}: context ${ctxLen} tokens`);
            }
          }
        }
      } catch (err) {
        logger.debug(`[Scan] Failed to fetch llama.cpp props from ${host}:${port}: ${err}`);
      }
      break;
    }

    case 'lm-studio':
    case 'localai':
    case 'jan':
    case 'gpt4all':
    case 'koboldcpp':
    case 'aphrodite':
    case 'tgi':
    case 'unknown':
    default: {
      // Generic: try /v1/models/{id} for each model, look for common context length fields — parallel
      await Promise.allSettled(
        models.map(async (model) => {
          try {
            const res = await fetch(`http://${host}:${port}/v1/models/${encodeURIComponent(model)}`, {
              signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
            });
            if (!res.ok) return;
            const data = await res.json() as Record<string, unknown>;

            const contextLength =
              (typeof data.max_model_len === 'number' && data.max_model_len > 0 ? data.max_model_len : null) ??
              (typeof data.context_length === 'number' && data.context_length > 0 ? data.context_length : null) ??
              (typeof data.context_window === 'number' && data.context_window > 0 ? data.context_window : null) ??
              (typeof data.max_context_length === 'number' && data.max_context_length > 0 ? data.max_context_length : null);

            if (contextLength !== null) {
              result[model] = contextLength;
              logger.info(`[Scan] ${model}: context ${contextLength} tokens`);
            }
          } catch (err) {
            logger.debug(`[Scan] Failed to fetch context window for ${model}: ${err}`);
          }
        })
      );
      break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Server Name
// ---------------------------------------------------------------------------

const SERVER_DISPLAY_NAMES: Record<string, string> = {
  'ollama': 'Ollama',
  'lm-studio': 'LM Studio',
  'vllm': 'vLLM',
  'llamacpp': 'llama.cpp',
  'localai': 'LocalAI',
  'tgi': 'TGI',
  'jan': 'Jan',
  'gpt4all': 'GPT4All',
  'koboldcpp': 'KoboldCPP',
  'aphrodite': 'Aphrodite',
};

/**
 * Builds a human-friendly provider name.
 */
function buildServerName(serverType: ServerType, host: string, port: number): string {
  const isLocal = host === '127.0.0.1' || host === 'localhost';

  if (serverType === 'unknown') {
    return `local-${host}:${port}`;
  }

  const display = SERVER_DISPLAY_NAMES[serverType] ?? serverType;
  return isLocal ? display : `${display} (${host})`;
}

// ---------------------------------------------------------------------------
// Scan Hosts
// ---------------------------------------------------------------------------

/**
 * Scans a list of hosts across all known ports.
 */
export async function scanHosts(
  hosts: string[],
  onProgress?: (completed: number, total: number) => void,
): Promise<DiscoveredServer[]> {
  type Probe = { host: string; port: number };
  const probes: Probe[] = [];
  for (const host of hosts) {
    for (const port of KNOWN_PORTS) {
      probes.push({ host, port });
    }
  }

  const total = probes.length;
  let completed = 0;
  const servers: DiscoveredServer[] = [];

  await asyncPool(MAX_CONCURRENT_PROBES, probes, async ({ host, port }) => {
    const result = await probeHost(host, port);
    completed++;
    onProgress?.(completed, total);

    if (result === null) return;

    const serverType = identifyServer(port, result.headers, result.responseBody);
    const name = buildServerName(serverType, host, port);
    const baseURL = `http://${host}:${port}/v1`;
    const modelContextWindows = await fetchModelContextWindows(host, port, serverType, result.models);

    servers.push({ name, host, port, baseURL, models: result.models, serverType, modelContextWindows });
    logger.info(`[Scan] Found ${name} at ${host}:${port} (${result.models.length} models)`);
  });

  return servers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans only localhost (fast, ~100ms).
 */
export async function scanLocalhost(): Promise<ScanResult> {
  const start = Date.now();
  const servers = await scanHosts(['127.0.0.1']);
  return {
    servers,
    scannedHosts: 1,
    scannedPorts: KNOWN_PORTS.length,
    durationMs: Date.now() - start,
  };
}

/**
 * Full scan: localhost first, then all /24 subnet IPs.
 * Returns merged, deduplicated results.
 */
let _scanning = false;

export async function scan(
  onProgress?: (completed: number, total: number) => void,
): Promise<ScanResult> {
  if (_scanning) {
    return { servers: [], scannedHosts: 0, scannedPorts: 0, durationMs: 0 };
  }
  _scanning = true;
  const start = Date.now();
  try {
    // Scan localhost first
    const localhostServers = await scanHosts(['127.0.0.1']);

    // Collect subnet IPs, excluding loopback
    const subnetIPs = getLocalSubnets().filter((ip) => ip !== '127.0.0.1');

    const subnetServers = subnetIPs.length > 0
      ? await scanHosts(subnetIPs, onProgress)
      : [];

    // Merge and deduplicate by host:port
    const seen = new Set<string>();
    const allServers: DiscoveredServer[] = [];
    for (const server of [...localhostServers, ...subnetServers]) {
      const key = `${server.host}:${server.port}`;
      if (!seen.has(key)) {
        seen.add(key);
        allServers.push(server);
      }
    }

    const scannedHosts = 1 + subnetIPs.length;
    return {
      servers: allServers,
      scannedHosts,
      scannedPorts: KNOWN_PORTS.length,
      durationMs: Date.now() - start,
    };
  } finally {
    _scanning = false;
  }
}
