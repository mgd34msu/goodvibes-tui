import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  diffCatalogs,
  filterRelevantChanges,
  formatChangeNotifications,
} from '../../providers/model-catalog.ts';
import type { CatalogModel, CatalogDiff } from '../../providers/model-catalog.ts';
import type { FavoritesData } from '../../providers/favorites.ts';
import { _setEntriesForTest } from '../../providers/model-benchmarks.ts';
import type { BenchmarkEntry } from '../../providers/model-benchmarks.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<CatalogModel> & { id: string; name: string; provider: string }): CatalogModel {
  return {
    pricing: { input: 1, output: 5 },
    tier: 'paid',
    providerId: overrides.provider.toLowerCase(),
    providerEnvVars: [],
    ...overrides,
  };
}

function emptyFavorites(): FavoritesData {
  return { pinned: [], history: [] };
}

function makeBenchmarkEntry(
  modelId: string,
  scores: { swe?: number; gpqa?: number; aime?: number },
): BenchmarkEntry {
  return {
    modelId,
    name: modelId,
    organization: 'test',
    benchmarks: {
      swe: scores.swe ?? undefined,
      gpqa: scores.gpqa ?? undefined,
      aime: scores.aime ?? undefined,
    },
  };
}

// Restore empty benchmark state after each test
beforeEach(() => {
  _setEntriesForTest([]);
});

afterEach(() => {
  _setEntriesForTest([]);
});

// ---------------------------------------------------------------------------
// diffCatalogs — structural diff
// ---------------------------------------------------------------------------

describe('diffCatalogs', () => {
  it('detects added models', () => {
    const oldCatalog: CatalogModel[] = [
      makeModel({ id: 'model-a', name: 'Model A', provider: 'acme' }),
    ];
    const newCatalog: CatalogModel[] = [
      makeModel({ id: 'model-a', name: 'Model A', provider: 'acme' }),
      makeModel({ id: 'model-b', name: 'Model B', provider: 'acme' }),
    ];

    const diff = diffCatalogs(oldCatalog, newCatalog);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].id).toBe('model-b');
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('detects removed models', () => {
    const oldCatalog: CatalogModel[] = [
      makeModel({ id: 'model-a', name: 'Model A', provider: 'acme' }),
      makeModel({ id: 'model-b', name: 'Model B', provider: 'acme' }),
    ];
    const newCatalog: CatalogModel[] = [
      makeModel({ id: 'model-a', name: 'Model A', provider: 'acme' }),
    ];

    const diff = diffCatalogs(oldCatalog, newCatalog);

    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].id).toBe('model-b');
    expect(diff.added).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('detects changed context window', () => {
    const oldCatalog: CatalogModel[] = [
      makeModel({ id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'nvidia', contextWindow: 262_000 }),
    ];
    const newCatalog: CatalogModel[] = [
      makeModel({ id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'nvidia', contextWindow: 512_000 }),
    ];

    const diff = diffCatalogs(oldCatalog, newCatalog);

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].model.id).toBe('kimi-k2.5');
    expect(diff.changed[0].changes.some(c => c.includes('context'))).toBe(true);
  });

  it('detects changed input pricing', () => {
    const oldCatalog: CatalogModel[] = [
      makeModel({ id: 'gpt-5', name: 'GPT-5', provider: 'openai', pricing: { input: 5, output: 15 } }),
    ];
    const newCatalog: CatalogModel[] = [
      makeModel({ id: 'gpt-5', name: 'GPT-5', provider: 'openai', pricing: { input: 3, output: 15 } }),
    ];

    const diff = diffCatalogs(oldCatalog, newCatalog);

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.some(c => c.includes('input price'))).toBe(true);
  });

  it('detects changed output pricing', () => {
    const oldCatalog: CatalogModel[] = [
      makeModel({ id: 'claude-opus', name: 'Claude Opus', provider: 'anthropic', pricing: { input: 15, output: 75 } }),
    ];
    const newCatalog: CatalogModel[] = [
      makeModel({ id: 'claude-opus', name: 'Claude Opus', provider: 'anthropic', pricing: { input: 15, output: 60 } }),
    ];

    const diff = diffCatalogs(oldCatalog, newCatalog);

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.some(c => c.includes('output price'))).toBe(true);
  });

  it('returns empty diff when catalogs are identical', () => {
    const catalog: CatalogModel[] = [
      makeModel({ id: 'model-a', name: 'Model A', provider: 'acme' }),
    ];
    const diff = diffCatalogs(catalog, catalog);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('returns empty diff for empty catalogs', () => {
    const diff = diffCatalogs([], []);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filterRelevantChanges — user-specific filtering
// ---------------------------------------------------------------------------

describe('filterRelevantChanges', () => {
  it('filters to models in usage history', () => {
    const diff: CatalogDiff = {
      added: [
        makeModel({ id: 'used-model', name: 'Used Model', provider: 'acme' }),
        makeModel({ id: 'unknown-model', name: 'Unknown', provider: 'acme' }),
      ],
      removed: [],
      changed: [],
    };
    const favorites: FavoritesData = {
      pinned: [],
      history: [{ modelId: 'used-model', lastUsed: '2024-01-01T00:00:00.000Z', count: 5 }],
    };

    const filtered = filterRelevantChanges(diff, favorites);

    expect(filtered.added).toHaveLength(1);
    expect(filtered.added[0].id).toBe('used-model');
  });

  it('filters to pinned models', () => {
    const diff: CatalogDiff = {
      added: [],
      removed: [
        makeModel({ id: 'pinned-model', name: 'Pinned Model', provider: 'acme' }),
        makeModel({ id: 'other-model', name: 'Other', provider: 'acme' }),
      ],
      changed: [],
    };
    const favorites: FavoritesData = {
      pinned: [{ modelId: 'pinned-model', pinnedAt: '2024-01-01T00:00:00.000Z' }],
      history: [],
    };

    const filtered = filterRelevantChanges(diff, favorites);

    expect(filtered.removed).toHaveLength(1);
    expect(filtered.removed[0].id).toBe('pinned-model');
  });

  it('includes top-10 benchmark models', () => {
    // Set up 12 benchmark entries; top model should be included
    const entries: BenchmarkEntry[] = Array.from({ length: 12 }, (_, i) => (
      makeBenchmarkEntry(`bench-model-${i}`, { swe: (12 - i) / 12, gpqa: (12 - i) / 12 })
    ));
    _setEntriesForTest(entries);

    // Only the top-10 should be included; bench-model-10 and bench-model-11 are lowest
    const diff: CatalogDiff = {
      added: entries.map(e => makeModel({ id: e.modelId, name: e.modelId, provider: 'acme' })),
      removed: [],
      changed: [],
    };

    const filtered = filterRelevantChanges(diff, emptyFavorites());

    expect(filtered.added).toHaveLength(10);
    // The 11th and 12th lowest-scoring models should be excluded
    const ids = filtered.added.map(m => m.id);
    expect(ids).not.toContain('bench-model-10');
    expect(ids).not.toContain('bench-model-11');
  });

  it('excludes models not in history, pinned, or top-10 benchmark', () => {
    const diff: CatalogDiff = {
      added: [
        makeModel({ id: 'irrelevant-model', name: 'Irrelevant', provider: 'acme' }),
      ],
      removed: [],
      changed: [],
    };

    const filtered = filterRelevantChanges(diff, emptyFavorites());

    expect(filtered.added).toHaveLength(0);
  });

  it('combines history and pinned without duplicates when both reference same model', () => {
    const diff: CatalogDiff = {
      added: [
        makeModel({ id: 'shared-model', name: 'Shared', provider: 'acme' }),
      ],
      removed: [],
      changed: [],
    };
    const favorites: FavoritesData = {
      pinned: [{ modelId: 'shared-model', pinnedAt: '2024-01-01T00:00:00.000Z' }],
      history: [{ modelId: 'shared-model', lastUsed: '2024-01-02T00:00:00.000Z', count: 1 }],
    };

    const filtered = filterRelevantChanges(diff, favorites);

    expect(filtered.added).toHaveLength(1);
    expect(filtered.added[0].id).toBe('shared-model');
  });
});

// ---------------------------------------------------------------------------
// formatChangeNotifications — message formatting
// ---------------------------------------------------------------------------

describe('formatChangeNotifications', () => {
  it('formats added model message', () => {
    const diff: CatalogDiff = {
      added: [makeModel({ id: 'gpt-5.5', name: 'GPT-5.5', provider: 'nvidia' })],
      removed: [],
      changed: [],
    };

    const msgs = formatChangeNotifications(diff);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toBe('New model: GPT-5.5 now available on nvidia');
  });

  it('formats removed model message', () => {
    const diff: CatalogDiff = {
      added: [],
      removed: [makeModel({ id: 'deepseek-v3', name: 'DeepSeek-V3.0', provider: 'groq' })],
      changed: [],
    };

    const msgs = formatChangeNotifications(diff);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toBe('Model removed: DeepSeek-V3.0 no longer available on groq');
  });

  it('formats context change message', () => {
    const diff: CatalogDiff = {
      added: [],
      removed: [],
      changed: [
        {
          model: makeModel({ id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'nvidia', contextWindow: 512_000 }),
          changes: ['context 256K \u2192 512K'],
        },
      ],
    };

    const msgs = formatChangeNotifications(diff);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('Model update: Kimi K2.5');
    expect(msgs[0]).toContain('context 256K \u2192 512K');
  });

  it('emits one message per change field when a model has multiple changes', () => {
    const diff: CatalogDiff = {
      added: [],
      removed: [],
      changed: [
        {
          model: makeModel({ id: 'multi-model', name: 'Multi Model', provider: 'acme' }),
          changes: ['input price $5 \u2192 $3 per 1M tokens', 'output price $15 \u2192 $10 per 1M tokens'],
        },
      ],
    };

    const msgs = formatChangeNotifications(diff);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('input price');
    expect(msgs[1]).toContain('output price');
  });

  it('returns empty array for empty diff', () => {
    const diff: CatalogDiff = { added: [], removed: [], changed: [] };
    expect(formatChangeNotifications(diff)).toEqual([]);
  });
});
