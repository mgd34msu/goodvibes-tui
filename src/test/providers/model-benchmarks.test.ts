import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import {
  compositeScore,
  getQualityTier,
  getQualityTierFromScore,
  BenchmarkStore,
} from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import type { ModelBenchmarks, BenchmarkEntry } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import { writeBenchmarksCache } from '../helpers/provider-cache.ts';

// ---------------------------------------------------------------------------
// compositeScore
// ---------------------------------------------------------------------------

describe('compositeScore', () => {
  it('returns weighted score: SWE 0.4 + GPQA 0.4 + AIME 0.2', () => {
    const scores: ModelBenchmarks = {
      swe: 0.5,
      gpqa: 0.6,
      aime: 0.8,
    };
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.6, 5);
  });

  it('returns null when no scores are available', () => {
    const scores: ModelBenchmarks = {};
    expect(compositeScore(scores)).toBeNull();
  });

  it('returns null for empty scores object', () => {
    expect(compositeScore({})).toBeNull();
  });

  it('handles partial scores — swe only', () => {
    const scores: ModelBenchmarks = { swe: 0.75 };
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.75, 5);
  });

  it('handles partial scores — swe and gpqa, no aime', () => {
    const scores: ModelBenchmarks = { swe: 0.6, gpqa: 0.7 };
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.65, 5);
  });

  it('handles partial scores — gpqa only', () => {
    const scores: ModelBenchmarks = { gpqa: 0.9 };
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.9, 5);
  });

  it('handles all perfect scores', () => {
    const scores: ModelBenchmarks = { swe: 1.0, gpqa: 1.0, aime: 1.0 };
    expect(compositeScore(scores)).toBeCloseTo(1.0, 5);
  });

  it('handles all zero scores', () => {
    const scores: ModelBenchmarks = { swe: 0, gpqa: 0, aime: 0 };
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(0, 5);
  });

  it('handles aime-only score', () => {
    const scores: ModelBenchmarks = { aime: 0.5 };
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.5, 5);
  });

  it('treats undefined fields the same as missing', () => {
    const scores: ModelBenchmarks = { swe: 0.8, gpqa: undefined, aime: undefined };
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.8, 5);
  });
});

// ---------------------------------------------------------------------------
// getQualityTier
// ---------------------------------------------------------------------------

describe('getQualityTier', () => {
  it('S tier: composite >= 0.80', () => {
    expect(getQualityTier({ swe: 0.9, gpqa: 0.9, aime: 0.9 })).toBe('S');
  });

  it('S tier: composite exactly 0.80', () => {
    expect(getQualityTier({ swe: 0.8, gpqa: 0.8, aime: 0.8 })).toBe('S');
  });

  it('A tier: composite >= 0.65 and < 0.80', () => {
    expect(getQualityTier({ swe: 0.65, gpqa: 0.65, aime: 0.65 })).toBe('A');
  });

  it('A tier: composite mid-range (0.72)', () => {
    expect(getQualityTier({ swe: 0.72, gpqa: 0.72, aime: 0.72 })).toBe('A');
  });

  it('A tier: composite just below S threshold (0.79)', () => {
    expect(getQualityTier({ swe: 0.79, gpqa: 0.79, aime: 0.79 })).toBe('A');
  });

  it('B tier: composite >= 0.50 and < 0.65', () => {
    expect(getQualityTier({ swe: 0.5, gpqa: 0.5, aime: 0.5 })).toBe('B');
  });

  it('B tier: composite exactly 0.50', () => {
    expect(getQualityTier({ swe: 0.5, gpqa: 0.5, aime: 0.5 })).toBe('B');
  });

  it('B tier: composite just below A threshold (0.64)', () => {
    expect(getQualityTier({ swe: 0.64, gpqa: 0.64, aime: 0.64 })).toBe('B');
  });

  it('C tier: composite below 0.50', () => {
    expect(getQualityTier({ swe: 0.3, gpqa: 0.3, aime: 0.3 })).toBe('C');
  });

  it('C tier: no data (no benchmark fields)', () => {
    expect(getQualityTier({})).toBe('C');
  });

  it('C tier: just below B threshold (0.49)', () => {
    expect(getQualityTier({ swe: 0.49, gpqa: 0.49, aime: 0.49 })).toBe('C');
  });

  it('returns a valid tier string for any input', () => {
    const validTiers = ['S', 'A', 'B', 'C'] as const;
    const inputs: ModelBenchmarks[] = [
      { swe: 0.95, gpqa: 0.92, aime: 0.88 },
      { swe: 0.7, gpqa: 0.68 },
      { aime: 0.55 },
      {},
      { swe: 0, gpqa: 0, aime: 0 },
    ];
    for (const input of inputs) {
      expect(validTiers).toContain(getQualityTier(input));
    }
  });
});

// ---------------------------------------------------------------------------
// getQualityTierFromScore
// ---------------------------------------------------------------------------

describe('getQualityTierFromScore', () => {
  it('score >= 0.80 returns S', () => {
    expect(getQualityTierFromScore(0.85)).toBe('S');
    expect(getQualityTierFromScore(1.0)).toBe('S');
  });

  it('score >= 0.65 and < 0.80 returns A', () => {
    expect(getQualityTierFromScore(0.72)).toBe('A');
    expect(getQualityTierFromScore(0.79)).toBe('A');
  });

  it('score >= 0.50 and < 0.65 returns B', () => {
    expect(getQualityTierFromScore(0.55)).toBe('B');
    expect(getQualityTierFromScore(0.64)).toBe('B');
  });

  it('score < 0.50 returns C', () => {
    expect(getQualityTierFromScore(0.3)).toBe('C');
    expect(getQualityTierFromScore(0.0)).toBe('C');
  });

  it('boundary: 0.80 exactly returns S', () => {
    expect(getQualityTierFromScore(0.80)).toBe('S');
  });

  it('boundary: 0.65 exactly returns A', () => {
    expect(getQualityTierFromScore(0.65)).toBe('A');
  });

  it('boundary: 0.50 exactly returns B', () => {
    expect(getQualityTierFromScore(0.50)).toBe('B');
  });

  it('boundary: 0.49 returns C', () => {
    expect(getQualityTierFromScore(0.49)).toBe('C');
  });
});

// ---------------------------------------------------------------------------
// BenchmarkStore lookup tests
// ---------------------------------------------------------------------------

const SYNTHETIC_ENTRIES: BenchmarkEntry[] = [
  {
    modelId: 'openai/gpt-4',
    name: 'GPT-4',
    organization: 'OpenAI',
    benchmarks: { swe: 0.72, gpqa: 0.68, aime: 0.30 },
  },
  {
    modelId: 'openai/gpt-4o',
    name: 'GPT-4o',
    organization: 'OpenAI',
    benchmarks: { swe: 0.80, gpqa: 0.78, aime: 0.50 },
  },
  {
    modelId: 'anthropic/claude-opus-5',
    name: 'Claude Opus 5',
    organization: 'Anthropic',
    benchmarks: { swe: 0.90, gpqa: 0.88, aime: 0.75 },
  },
];

const TMP_BASE = join(import.meta.dir, '__benchmarks_tmp__');
let tmpHomeDir: string;
let benchmarkDir: string;
let benchmarkStore: BenchmarkStore;

beforeEach(() => {
  tmpHomeDir = join(TMP_BASE, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  benchmarkDir = join(tmpHomeDir, '.goodvibes', 'tui');
  mkdirSync(benchmarkDir, { recursive: true });
  benchmarkStore = new BenchmarkStore({ dir: benchmarkDir });
  writeBenchmarksCache(SYNTHETIC_ENTRIES, benchmarkDir);
  benchmarkStore.initBenchmarks();
});

afterEach(() => {
  rmSync(TMP_BASE, { recursive: true, force: true });
});

describe('BenchmarkStore.getBenchmarks', () => {
  it('returns undefined when cache is empty', () => {
    writeBenchmarksCache([], benchmarkDir);
    benchmarkStore.initBenchmarks();
    expect(benchmarkStore.getBenchmarks('GPT-4')).toBeUndefined();
  });

  it('exact match by name (case-sensitive)', () => {
    const result = benchmarkStore.getBenchmarks('GPT-4');
    expect(result).not.toBeUndefined();
    expect(result!.modelId).toBe('openai/gpt-4');
  });

  it('exact match by modelId', () => {
    const result = benchmarkStore.getBenchmarks('anthropic/claude-opus-5');
    expect(result).not.toBeUndefined();
    expect(result!.name).toBe('Claude Opus 5');
  });

  it('slug / punctuation-insensitive match by name', () => {
    const result = benchmarkStore.getBenchmarks('claude opus 5');
    expect(result).not.toBeUndefined();
    expect(result!.modelId).toBe('anthropic/claude-opus-5');
  });

  it('slug / punctuation-insensitive match by modelId case-insensitive', () => {
    const result = benchmarkStore.getBenchmarks('OPENAI/GPT-4O');
    expect(result).not.toBeUndefined();
    expect(result!.modelId).toBe('openai/gpt-4o');
  });

  it('prefix substring shortest-name rule prefers GPT-4 over GPT-4o for gpt-4', () => {
    const result = benchmarkStore.getBenchmarks('gpt-4');
    expect(result).not.toBeUndefined();
    expect(result!.modelId).toBe('openai/gpt-4');
  });

  it('returns undefined for unknown model when cache is populated', () => {
    const result = benchmarkStore.getBenchmarks('completely-unknown-model-xyz-99999');
    expect(result).toBeUndefined();
  });

  it('never throws for any string input', () => {
    const inputs = ['unknown-model-xyz', '', 'Claude Opus 5', 'gpt-5.2', 'GEMINI-3.5', 'llama-3.3'];
    for (const input of inputs) {
      expect(() => benchmarkStore.getBenchmarks(input)).not.toThrow();
    }
  });
});
