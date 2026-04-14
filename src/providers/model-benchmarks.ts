import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

export interface ModelBenchmarks {
  gpqa?: number;
  swe?: number;
  aime?: number;
  terminal?: number;
  tool?: number;
  mcp?: number;
}

export interface BenchmarkEntry {
  modelId: string;
  name: string;
  organization: string;
  benchmarks: ModelBenchmarks;
}

export type QualityTier = 'S' | 'A' | 'B' | 'C';

interface ZeroEvalModel {
  id?: string;
  model_id?: string;
  name?: string;
  model_name?: string;
  organization?: string;
  org?: string;
  gpqa_score?: number | null;
  gpqa?: number | null;
  gpqa_diamond?: number | null;
  swe_bench_verified_score?: number | null;
  swe_bench?: number | null;
  swe?: number | null;
  aime_2025_score?: number | null;
  aime?: number | null;
  aime_2024?: number | null;
  terminal_bench_score?: number | null;
  terminal_bench?: number | null;
  terminal?: number | null;
  toolathlon_score?: number | null;
  tool_use?: number | null;
  tool?: number | null;
  mcp_atlas_score?: number | null;
  mcp_bench?: number | null;
  mcp?: number | null;
  scores?: Record<string, number | null>;
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

const ZEROEVAL_URL = 'https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true';
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 86_400_000;

export const S_TIER_THRESHOLD = 0.80;
export const A_TIER_THRESHOLD = 0.65;
export const B_TIER_THRESHOLD = 0.50;

function pickFirst<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const value of values) {
    if (value != null) return value;
  }
  return undefined;
}

function parseScore(value: number | null | undefined): number | undefined {
  if (value == null || Number.isNaN(value)) return undefined;
  return value > 1 ? value / 100 : value;
}

function extractBenchmarks(model: ZeroEvalModel): ModelBenchmarks {
  const scores = model.scores ?? {};
  const raw = {
    gpqa: pickFirst(model.gpqa_score, model.gpqa_diamond, model.gpqa, scores.gpqa_score, scores.gpqa_diamond, scores.gpqa),
    swe: pickFirst(model.swe_bench_verified_score, model.swe_bench, model.swe, scores.swe_bench_verified_score, scores.swe_bench, scores.swe),
    aime: pickFirst(model.aime_2025_score, model.aime_2024, model.aime, scores.aime_2025_score, scores.aime_2024, scores.aime),
    terminal: pickFirst(model.terminal_bench_score, model.terminal_bench, model.terminal, scores.terminal_bench_score, scores.terminal_bench, scores.terminal),
    tool: pickFirst(model.toolathlon_score, model.tool_use, model.tool, scores.toolathlon_score, scores.tool_use, scores.tool),
    mcp: pickFirst(model.mcp_atlas_score, model.mcp_bench, model.mcp, scores.mcp_atlas_score, scores.mcp_bench, scores.mcp),
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
  const raw = Array.isArray(json)
    ? json as ZeroEvalModel[]
    : ((json as ZeroEvalResponse).models ?? (json as ZeroEvalResponse).data ?? (json as ZeroEvalResponse).leaderboard ?? []);

  if (!Array.isArray(raw)) {
    logger.warn('[model-benchmarks] Unexpected ZeroEval response shape');
    return [];
  }

  return raw.map((model) => ({
    modelId: String(model.id ?? model.model_id ?? ''),
    name: String(model.name ?? model.model_name ?? model.id ?? model.model_id ?? ''),
    organization: String(model.organization ?? model.org ?? ''),
    benchmarks: extractBenchmarks(model),
  }));
}

function buildNameIndex(entries: readonly BenchmarkEntry[]): Map<string, BenchmarkEntry> {
  const index = new Map<string, BenchmarkEntry>();
  for (const entry of entries) {
    index.set(entry.name.toLowerCase(), entry);
    if (entry.modelId) {
      index.set(entry.modelId.toLowerCase(), entry);
    }
  }
  return index;
}

export function compositeScore(benchmarks: ModelBenchmarks): number | null {
  let total = 0;
  let weight = 0;
  if (benchmarks.swe != null) { total += benchmarks.swe * 0.4; weight += 0.4; }
  if (benchmarks.gpqa != null) { total += benchmarks.gpqa * 0.4; weight += 0.4; }
  if (benchmarks.aime != null) { total += benchmarks.aime * 0.2; weight += 0.2; }
  return weight === 0 ? null : total / weight;
}

export function getQualityTier(benchmarks: ModelBenchmarks): QualityTier {
  const score = compositeScore(benchmarks);
  if (score == null) return 'C';
  return getQualityTierFromScore(score);
}

export function getQualityTierFromScore(score: number): QualityTier {
  if (score >= S_TIER_THRESHOLD) return 'S';
  if (score >= A_TIER_THRESHOLD) return 'A';
  if (score >= B_TIER_THRESHOLD) return 'B';
  return 'C';
}

export interface BenchmarkStoreOptions {
  readonly dir: string;
}

export class BenchmarkStore {
  private readonly dir: string;
  private cache: BenchmarksCache | null = null;
  private nameIndex: Map<string, BenchmarkEntry> | null = null;
  private readonly refreshCallbacks = new Set<() => void>();

  constructor(options: BenchmarkStoreOptions) {
    this.dir = options.dir;
  }

  getCachePath(): string {
    return join(this.dir, 'benchmarks.json');
  }

  private getTmpPath(): string {
    return `${this.getCachePath()}.tmp`;
  }

  onRefreshed(callback: () => void): () => void {
    this.refreshCallbacks.add(callback);
    return () => {
      this.refreshCallbacks.delete(callback);
    };
  }

  initBenchmarks(): void {
    this.cache = this.loadCache();
    this.nameIndex = this.cache ? buildNameIndex(this.cache.entries) : null;
    if (!this.cache || this.isCacheStale(this.cache)) {
      void this.refreshBenchmarks().catch((err) => {
        logger.debug('[model-benchmarks] Background refresh failed', { error: summarizeError(err) });
      });
    }
  }

  async refreshBenchmarks(): Promise<void> {
    const entries = await this.fetchBenchmarks();
    if (entries.length === 0) {
      logger.warn('[model-benchmarks] Refresh returned 0 entries — keeping existing cache');
      return;
    }
    const next: BenchmarksCache = {
      version: 1,
      fetchedAt: Date.now(),
      ttlMs: CACHE_TTL_MS,
      entries,
    };
    this.saveCache(next);
    this.cache = next;
    this.nameIndex = buildNameIndex(entries);
    for (const callback of this.refreshCallbacks) callback();
    logger.debug('[model-benchmarks] Cache updated', { count: entries.length });
  }

  getBenchmarks(modelName: string): BenchmarkEntry | undefined {
    const entries = this.cache?.entries;
    if (!entries || entries.length === 0) return undefined;
    const index = this.nameIndex ?? buildNameIndex(entries);

    const exact = entries.find((entry) => entry.name === modelName || entry.modelId === modelName);
    if (exact) return exact;

    const lower = modelName.toLowerCase();
    const indexed = index.get(lower);
    if (indexed) return indexed;

    const slug = lower.replace(/[^a-z0-9]/g, '');
    if (slug.length > 0) {
      let slugBest: BenchmarkEntry | undefined;
      let slugBestLen = Infinity;
      let slugPrefixBest: BenchmarkEntry | undefined;
      let slugPrefixBestLen = Infinity;
      for (const entry of entries) {
        const nameSlug = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const idSlug = entry.modelId.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (nameSlug === slug || idSlug === slug) {
          const len = Math.min(
            nameSlug === slug ? entry.name.length : Infinity,
            idSlug === slug ? entry.modelId.length : Infinity,
          );
          if (len < slugBestLen) {
            slugBestLen = len;
            slugBest = entry;
          }
        } else if (nameSlug.startsWith(slug) || idSlug.startsWith(slug)) {
          const len = Math.min(
            nameSlug.startsWith(slug) ? entry.name.length : Infinity,
            idSlug.startsWith(slug) ? entry.modelId.length : Infinity,
          );
          if (len < slugPrefixBestLen) {
            slugPrefixBestLen = len;
            slugPrefixBest = entry;
          }
        }
      }
      if (slugBest) return slugBest;
      if (slugPrefixBest) return slugPrefixBest;
    }

    let best: BenchmarkEntry | undefined;
    let bestLen = Infinity;
    for (const entry of entries) {
      const nameLower = entry.name.toLowerCase();
      const idLower = entry.modelId.toLowerCase();
      if (nameLower.includes(lower) || idLower.includes(lower)) {
        const len = Math.min(
          nameLower.includes(lower) ? entry.name.length : Infinity,
          idLower.includes(lower) ? entry.modelId.length : Infinity,
        );
        if (len < bestLen) {
          bestLen = len;
          best = entry;
        }
      }
    }
    return best;
  }

  getTopBenchmarkModelIds(n: number): string[] {
    const entries = this.cache?.entries;
    if (!entries || entries.length === 0) return [];
    return entries
      .map((entry) => ({ id: entry.modelId, score: compositeScore(entry.benchmarks) }))
      .filter((entry): entry is { id: string; score: number } => entry.score != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((entry) => entry.id);
  }

  private async fetchBenchmarks(): Promise<BenchmarkEntry[]> {
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
      return parseEntries(await response.json());
    } finally {
      clearTimeout(timer);
    }
  }

  private loadCache(): BenchmarksCache | null {
    try {
      const parsed = JSON.parse(readFileSync(this.getCachePath(), 'utf-8')) as BenchmarksCache;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
      return parsed;
    } catch (err) {
      const message = summarizeError(err);
      if (message.includes('ENOENT') || message.includes('no such file')) {
        logger.debug('[model-benchmarks] No cache file found (first run)');
      } else {
        logger.warn('[model-benchmarks] Cache load failed (corrupted?)', { error: message });
      }
      return null;
    }
  }

  private saveCache(cache: BenchmarksCache): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.getTmpPath(), JSON.stringify(cache, null, 2), 'utf-8');
      renameSync(this.getTmpPath(), this.getCachePath());
    } catch (err) {
      logger.warn('[model-benchmarks] Cache write failed', { error: summarizeError(err) });
    }
  }

  private isCacheStale(cache: BenchmarksCache): boolean {
    return Date.now() - cache.fetchedAt > cache.ttlMs;
  }
}
