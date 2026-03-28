import { describe, it, expect, afterEach } from 'bun:test';
import {
  compositeScore,
  getQualityTier,
  getBenchmarks,
  _setEntriesForTest,
} from '../../providers/model-benchmarks.ts';
import type { ModelBenchmarks, BenchmarkEntry } from '../../providers/model-benchmarks.ts';

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
    // Expected: 0.5*0.4 + 0.6*0.4 + 0.8*0.2 = 0.20 + 0.24 + 0.16 = 0.60
    // Renormalized by weight sum (1.0) → 0.60
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
    // swe weight 0.4, renormalized to 0.4/0.4 = 1.0 → result = 0.75
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.75, 5);
  });

  it('handles partial scores — swe and gpqa, no aime', () => {
    const scores: ModelBenchmarks = { swe: 0.6, gpqa: 0.7 };
    // swe*0.4 + gpqa*0.4 = 0.24 + 0.28 = 0.52, weight = 0.8
    // renormalized: 0.52 / 0.8 = 0.65
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.65, 5);
  });

  it('handles partial scores — gpqa only', () => {
    const scores: ModelBenchmarks = { gpqa: 0.9 };
    // gpqa weight 0.4, renormalized → 0.9
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
    // All zeros — weight sum is 1.0, total is 0 → result is 0 (not null)
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(0, 5);
  });

  it('handles aime-only score', () => {
    const scores: ModelBenchmarks = { aime: 0.5 };
    // aime weight 0.2, renormalized → 0.5
    const result = compositeScore(scores);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.5, 5);
  });

  it('treats undefined fields the same as missing', () => {
    const scores: ModelBenchmarks = { swe: 0.8, gpqa: undefined, aime: undefined };
    // Only swe present — renormalized: 0.8
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
    // swe=0.8, gpqa=0.8, aime=0.8 → composite = 0.8
    expect(getQualityTier({ swe: 0.8, gpqa: 0.8, aime: 0.8 })).toBe('S');
  });

  it('A tier: composite >= 0.65 and < 0.80', () => {
    // swe=0.65, gpqa=0.65, aime=0.65 → composite = 0.65
    expect(getQualityTier({ swe: 0.65, gpqa: 0.65, aime: 0.65 })).toBe('A');
  });

  it('A tier: composite mid-range (0.72)', () => {
    // swe=0.72, gpqa=0.72, aime=0.72 → composite = 0.72 (clearly in A range)
    expect(getQualityTier({ swe: 0.72, gpqa: 0.72, aime: 0.72 })).toBe('A');
  });

  it('A tier: composite just below S threshold (0.79)', () => {
    // swe=0.79, gpqa=0.79, aime=0.79 → composite ≈ 0.79
    expect(getQualityTier({ swe: 0.79, gpqa: 0.79, aime: 0.79 })).toBe('A');
  });

  it('B tier: composite >= 0.50 and < 0.65', () => {
    // swe=0.5, gpqa=0.5, aime=0.5 → composite = 0.5
    expect(getQualityTier({ swe: 0.5, gpqa: 0.5, aime: 0.5 })).toBe('B');
  });

  it('B tier: composite exactly 0.50', () => {
    expect(getQualityTier({ swe: 0.5, gpqa: 0.5, aime: 0.5 })).toBe('B');
  });

  it('B tier: composite just below A threshold (0.64)', () => {
    expect(getQualityTier({ swe: 0.64, gpqa: 0.64, aime: 0.64 })).toBe('B');
  });

  it('C tier: composite below 0.50', () => {
    // swe=0.3, gpqa=0.3, aime=0.3 → composite = 0.3
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
// Synthetic test data for getBenchmarks lookup tests
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

// ---------------------------------------------------------------------------
// getBenchmarks — fuzzy matching with populated cache
// ---------------------------------------------------------------------------

describe('getBenchmarks', () => {
  afterEach(() => {
    // Reset module state so tests do not bleed into each other
    _setEntriesForTest([]);
  });

  it('returns undefined when cache is empty', () => {
    _setEntriesForTest([]);
    expect(getBenchmarks('GPT-4')).toBeUndefined();
  });

  it('exact match by name (case-sensitive)', () => {
    _setEntriesForTest(SYNTHETIC_ENTRIES);
    const result = getBenchmarks('GPT-4');
    expect(result).not.toBeUndefined();
    expect(result!.modelId).toBe('openai/gpt-4');
  });

  it('exact match by modelId', () => {
    _setEntriesForTest(SYNTHETIC_ENTRIES);
    const result = getBenchmarks('anthropic/claude-opus-5');
    expect(result).not.toBeUndefined();
    expect(result!.name).toBe('Claude Opus 5');
  });

  it('case-insensitive match by name', () => {
    _setEntriesForTest(SYNTHETIC_ENTRIES);
    const result = getBenchmarks('claude opus 5');
    expect(result).not.toBeUndefined();
    expect(result!.modelId).toBe('anthropic/claude-opus-5');
  });

  it('case-insensitive match by modelId', () => {
    _setEntriesForTest(SYNTHETIC_ENTRIES);
    const result = getBenchmarks('OPENAI/GPT-4O');
    expect(result).not.toBeUndefined();
    expect(result!.modelId).toBe('openai/gpt-4o');
  });

  it('substring match returns shortest match — gpt-4 matches GPT-4, not GPT-4o', () => {
    _setEntriesForTest(SYNTHETIC_ENTRIES);
    // 'gpt-4' is a substring of both 'GPT-4' (len 5) and 'GPT-4o' (len 6).
    // The shortest-name rule must return GPT-4, not GPT-4o.
    const result = getBenchmarks('gpt-4');
    expect(result).not.toBeUndefined();
    expect(result!.modelId).toBe('openai/gpt-4');
  });

  it('returns undefined for unknown model when cache IS populated', () => {
    _setEntriesForTest(SYNTHETIC_ENTRIES);
    const result = getBenchmarks('completely-unknown-model-xyz-99999');
    expect(result).toBeUndefined();
  });

  it('never throws for any string input', () => {
    _setEntriesForTest(SYNTHETIC_ENTRIES);
    const inputs = ['unknown-model-xyz', '', 'Claude Opus 5', 'gpt-5.2', 'GEMINI-3.5', 'llama-3.3'];
    for (const input of inputs) {
      expect(() => getBenchmarks(input)).not.toThrow();
    }
  });
});
