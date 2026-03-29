/**
 * model-benchmarks.ts
 *
 * Fetches, caches, and resolves ZeroEval benchmark scores for models.
 * Data source: https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true
 * Cache: ~/.goodvibes/tui/benchmarks.json (24hr TTL).
 *
 * Never deletes cache — if fetch fails, stale data is used indefinitely.
 * Atomic writes: write to .tmp then rename over existing.
 *
 * Public API:
 *   initBenchmarks()              — load cache + background refresh if stale
 *   getBenchmarks(modelName)      — fuzzy lookup by name
 *   getQualityTier(benchmarks)    — S/A/B/C tier based on composite score
 *   compositeScore(b)             — weighted composite (SWE 0.4, GPQA 0.4, AIME 0.2)
 *   refreshBenchmarks()           — force re-fetch and cache update
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModelBenchmarks {
  gpqa?: number;      // GPQA Diamond — general knowledge / reasoning
  swe?: number;       // SWE-bench — software engineering tasks
  aime?: number;      // AIME — math competition
  terminal?: number;  // Terminal-bench — terminal/CLI tasks
  tool?: number;      // Tool-use bench
  mcp?: number;       // MCP bench
}

export interface BenchmarkEntry {
  modelId: string;
  name: string;
  organization: string;
  benchmarks: ModelBenchmarks;
}

export type QualityTier = 'S' | 'A' | 'B' | 'C';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ZeroEvalModel {
  id?: string;
  model_id?: string;
  name?: string;
  model_name?: string;
  organization?: string;
  org?: string;
  // Benchmark score fields — ZeroEval may use various key names
  gpqa?: number | null;
  gpqa_diamond?: number | null;
  swe_bench?: number | null;
  swe?: number | null;
  aime?: number | null;
  aime_2024?: number | null;
  terminal_bench?: number | null;
  terminal?: number | null;
  tool_use?: number | null;
  tool?: number | null;
  mcp_bench?: number | null;
  mcp?: number | null;
  // Scores may also be nested
  scores?: Record<string, number | null>;
  // Average / composite provided by API
  average?: number | null;
}

interface ZeroEvalResponse {
  models?: ZeroEvalModel[];
  data?: ZeroEvalModel[];
  leaderboard?: ZeroEvalModel[];
}

interface BenchmarksCache {
  version: 1;
  fetchedAt: number;
  ttlMs: number;
  entries: BenchmarkEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZEROEVAL_URL = 'https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true';
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 86_400_000; // 24 hours

// ---------------------------------------------------------------------------
// Cache path
// ---------------------------------------------------------------------------

function getCachePath(): string {
  return join(homedir(), '.goodvibes', 'tui', 'benchmarks.json');
}

function getTmpPath(): string {
  return getCachePath() + '.tmp';
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let _cache: BenchmarksCache | null = null;

// Index for fast lookup: lowercase name → entry
let _nameIndex: Map<string, BenchmarkEntry> | null = null;

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

function pickFirst<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const v of values) {
    if (v != null) return v;
  }
  return undefined;
}

function parseScore(v: number | null | undefined): number | undefined {
  if (v == null || isNaN(v)) return undefined;
  // ZeroEval may return scores as percentages (0-100) or fractions (0-1).
  // Normalise to 0-1 range.
  return v > 1 ? v / 100 : v;
}

function extractBenchmarks(model: ZeroEvalModel): ModelBenchmarks {
  // Direct fields take precedence; fall back to nested scores map.
  const s = model.scores ?? {};

  const raw = {
    gpqa: pickFirst(model.gpqa_diamond, model.gpqa, s['gpqa_diamond'], s['gpqa']),
    swe: pickFirst(model.swe_bench, model.swe, s['swe_bench'], s['swe']),
    aime: pickFirst(model.aime_2024, model.aime, s['aime_2024'], s['aime']),
    terminal: pickFirst(model.terminal_bench, model.terminal, s['terminal_bench'], s['terminal']),
    tool: pickFirst(model.tool_use, model.tool, s['tool_use'], s['tool']),
    mcp: pickFirst(model.mcp_bench, model.mcp, s['mcp_bench'], s['mcp']),
  };

  const benchmarks: ModelBenchmarks = {};
  if (raw.gpqa != null) benchmarks.gpqa = parseScore(raw.gpqa);
  if (raw.swe != null) benchmarks.swe = parseScore(raw.swe);
  if (raw.aime != null) benchmarks.aime = parseScore(raw.aime);
  if (raw.terminal != null) benchmarks.terminal = parseScore(raw.terminal);
  if (raw.tool != null) benchmarks.tool = parseScore(raw.tool);
  if (raw.mcp != null) benchmarks.mcp = parseScore(raw.mcp);

  return benchmarks;
}

function parseEntries(json: unknown): BenchmarkEntry[] {
  const resp = json as ZeroEvalResponse;
  const raw: ZeroEvalModel[] = resp.models ?? resp.data ?? resp.leaderboard ?? [];

  if (!Array.isArray(raw)) {
    logger.warn('[model-benchmarks] Unexpected ZeroEval response shape', { keys: Object.keys(resp) });
    return [];
  }

  const entries: BenchmarkEntry[] = [];
  for (const model of raw) {
    const id = String(model.id ?? model.model_id ?? '');
    const name = String(model.name ?? model.model_name ?? id);
    const organization = String(model.organization ?? model.org ?? '');
    entries.push({
      modelId: id,
      name,
      organization,
      benchmarks: extractBenchmarks(model),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

function loadCache(): BenchmarksCache | null {
  try {
    const raw = readFileSync(getCachePath(), 'utf-8');
    const parsed = JSON.parse(raw) as BenchmarksCache;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch (err) {
    const msg = String(err);
    if (msg.includes('ENOENT') || msg.includes('no such file')) {
      logger.debug('[model-benchmarks] No cache file found (first run)');
    } else {
      logger.warn('[model-benchmarks] Cache load failed (corrupted?)', { error: msg });
    }
    return null;
  }
}

function saveCache(cache: BenchmarksCache): void {
  try {
    const dir = join(homedir(), '.goodvibes', 'tui');
    mkdirSync(dir, { recursive: true });
    const tmp = getTmpPath();
    writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
    renameSync(tmp, getCachePath());
  } catch (err) {
    logger.warn('[model-benchmarks] Cache write failed', { error: String(err) });
  }
}

function isCacheStale(cache: BenchmarksCache): boolean {
  return Date.now() - cache.fetchedAt > cache.ttlMs;
}

function buildNameIndex(entries: BenchmarkEntry[]): Map<string, BenchmarkEntry> {
  const idx = new Map<string, BenchmarkEntry>();
  for (const entry of entries) {
    idx.set(entry.name.toLowerCase(), entry);
    // Also index by modelId (lowercase)
    if (entry.modelId) {
      idx.set(entry.modelId.toLowerCase(), entry);
    }
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch ZeroEval leaderboard and parse into BenchmarkEntry[].
 */
export async function fetchBenchmarks(): Promise<BenchmarkEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(ZEROEVAL_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`ZeroEval API returned ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    const entries = parseEntries(json);

    logger.debug('[model-benchmarks] Fetched entries', { count: entries.length });
    return entries;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load cache from disk; background-refresh if stale.
 * Never deletes existing cache — stale data is always preferred over nothing.
 */
export function initBenchmarks(): void {
  _cache = loadCache();
  if (_cache) {
    _nameIndex = buildNameIndex(_cache.entries);
  }

  if (!_cache || isCacheStale(_cache)) {
    // Background refresh — do not await
    refreshBenchmarks().catch((err) => {
      logger.debug('[model-benchmarks] Background refresh failed', { error: String(err) });
    });
  }
}

/**
 * Force re-fetch from ZeroEval and update cache.
 * Only replaces cache with valid new data — stale cache is preserved on failure.
 */
export async function refreshBenchmarks(): Promise<void> {
  const entries = await fetchBenchmarks();

  if (entries.length === 0) {
    logger.warn('[model-benchmarks] Refresh returned 0 entries — keeping existing cache');
    return;
  }

  const newCache: BenchmarksCache = {
    version: 1,
    fetchedAt: Date.now(),
    ttlMs: CACHE_TTL_MS,
    entries,
  };

  saveCache(newCache);
  _cache = newCache;
  _nameIndex = buildNameIndex(entries);

  logger.debug('[model-benchmarks] Cache updated', { count: entries.length });
}

/**
 * Look up benchmark data for a model by name.
 * Fuzzy matching: exact → lowercase → substring (shortest match preferred).
 * Returns undefined if no match found.
 */
export function getBenchmarks(modelName: string): BenchmarkEntry | undefined {
  const entries = _cache?.entries;
  if (!entries || entries.length === 0) return undefined;

  const idx = _nameIndex ?? buildNameIndex(entries);

  // 1. Exact match (case-sensitive)
  const exactEntry = entries.find((e) => e.name === modelName || e.modelId === modelName);
  if (exactEntry) return exactEntry;

  // 2. Lowercase match
  const lower = modelName.toLowerCase();
  const lowerEntry = idx.get(lower);
  if (lowerEntry) return lowerEntry;

  // 3. Substring match — prefer shortest name/modelId to avoid 'gpt-4' matching 'gpt-4o'
  let bestEntry: BenchmarkEntry | undefined;
  let bestLen = Infinity;
  for (const e of entries) {
    const nameLow = e.name.toLowerCase();
    const idLow = e.modelId.toLowerCase();
    if (nameLow.includes(lower) || idLow.includes(lower)) {
      const len = Math.min(
        nameLow.includes(lower) ? e.name.length : Infinity,
        idLow.includes(lower) ? e.modelId.length : Infinity,
      );
      if (len < bestLen) {
        bestLen = len;
        bestEntry = e;
      }
    }
  }
  return bestEntry;
}

/**
 * Test helper — directly set the internal cache entries and rebuild the name index.
 * ONLY for use in unit tests.
 */
export function _setEntriesForTest(entries: BenchmarkEntry[]): void {
  _cache = { version: 1, fetchedAt: Date.now(), ttlMs: CACHE_TTL_MS, entries };
  _nameIndex = buildNameIndex(entries);
}

/**
 * Returns the modelIds of the top N entries ranked by composite benchmark score.
 * Used by filterRelevantChanges in model-catalog.ts.
 */
export function getTopBenchmarkModelIds(n: number): string[] {
  const entries = _cache?.entries;
  if (!entries || entries.length === 0) return [];

  const scored = entries
    .map(e => ({ id: e.modelId, score: compositeScore(e.benchmarks) }))
    .filter((e): e is { id: string; score: number } => e.score !== null)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, n).map(e => e.id);
}

/**
 * Compute weighted composite score.
 * Weights: SWE 0.4, GPQA 0.4, AIME 0.2.
 * Returns null if none of the scored fields are present.
 */
export function compositeScore(b: ModelBenchmarks): number | null {
  let total = 0;
  let weight = 0;

  if (b.swe != null) { total += b.swe * 0.4; weight += 0.4; }
  if (b.gpqa != null) { total += b.gpqa * 0.4; weight += 0.4; }
  if (b.aime != null) { total += b.aime * 0.2; weight += 0.2; }

  if (weight === 0) return null;

  // Normalise: if only a subset of weights is present, scale to 0-1
  return total / weight;
}

/**
 * Determine quality tier based on composite benchmark score.
 * S ≥ 0.80 | A ≥ 0.65 | B ≥ 0.50 | C < 0.50 or no data
 */
export function getQualityTier(benchmarks: ModelBenchmarks): QualityTier {
  const score = compositeScore(benchmarks);
  if (score == null) return 'C';
  if (score >= 0.80) return 'S';
  if (score >= 0.65) return 'A';
  if (score >= 0.50) return 'B';
  return 'C';
}
