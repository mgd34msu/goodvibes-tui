import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { FavoritesStore, type FavoritesData } from '@pellux/goodvibes-sdk/platform/providers/favorites';

// ---------------------------------------------------------------------------
// Test isolation — redirect favorites to a per-test temp directory
// ---------------------------------------------------------------------------

const TMP_BASE = join(import.meta.dir, '__favorites_tmp__');

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(TMP_BASE, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TMP_BASE, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

function makeStore(): FavoritesStore {
  return new FavoritesStore({ dir: tmpDir });
}

// ---------------------------------------------------------------------------
// load / save — round-trip and empty-file handling
// ---------------------------------------------------------------------------

describe('FavoritesStore.load', () => {
  test('returns empty defaults when file does not exist', async () => {
    const data = await makeStore().load();
    expect(data.pinned).toEqual([]);
    expect(data.history).toEqual([]);
  });

  test('persistence round-trip: save then load', async () => {
    const input: FavoritesData = {
      pinned: [{ modelId: 'model-a', pinnedAt: '2024-01-01T00:00:00.000Z' }],
      history: [{ modelId: 'model-b', lastUsed: '2024-01-02T00:00:00.000Z', count: 3 }],
    };
    const store = makeStore();
    await store.save(input);
    const loaded = await store.load();
    expect(loaded.pinned).toHaveLength(1);
    expect(loaded.pinned[0]?.modelId).toBe('model-a');
    expect(loaded.history).toHaveLength(1);
    expect(loaded.history[0]?.count).toBe(3);
  });

  test('returns empty defaults on invalid JSON', async () => {
    writeFileSync(join(tmpDir, 'favorites.json'), 'not-valid-json', 'utf-8');
    const data = await makeStore().load();
    expect(data.pinned).toEqual([]);
    expect(data.history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pin / Unpin lifecycle
// ---------------------------------------------------------------------------

describe('FavoritesStore pinning', () => {
  test('pinning a model adds it to pinned list', async () => {
    const store = makeStore();
    await store.pinModel('gpt-4o');
    const pinned = await store.getPinned();
    expect(pinned).toContain('gpt-4o');
  });

  test('pinning same model twice does not duplicate', async () => {
    const store = makeStore();
    await store.pinModel('gpt-4o');
    await store.pinModel('gpt-4o');
    const pinned = await store.getPinned();
    expect(pinned.filter((id) => id === 'gpt-4o')).toHaveLength(1);
  });

  test('unpinning removes model from list', async () => {
    const store = makeStore();
    await store.pinModel('claude-opus');
    await store.unpinModel('claude-opus');
    const pinned = await store.getPinned();
    expect(pinned).not.toContain('claude-opus');
  });

  test('unpinning a model not in list is a no-op', async () => {
    const store = makeStore();
    await store.unpinModel('nonexistent-model');
    const pinned = await store.getPinned();
    expect(pinned).not.toContain('nonexistent-model');
  });

  test('pinning multiple models preserves all', async () => {
    const store = makeStore();
    await store.pinModel('model-a');
    await store.pinModel('model-b');
    await store.pinModel('model-c');
    const pinned = await store.getPinned();
    expect(pinned).toContain('model-a');
    expect(pinned).toContain('model-b');
    expect(pinned).toContain('model-c');
  });
});

// ---------------------------------------------------------------------------
// isModelPinned
// ---------------------------------------------------------------------------

describe('FavoritesStore.isModelPinned', () => {
  test('returns true for a pinned model', async () => {
    const store = makeStore();
    await store.pinModel('pinned-model');
    expect(await store.isModelPinned('pinned-model')).toBe(true);
  });

  test('returns false for an unpinned model', async () => {
    expect(await makeStore().isModelPinned('not-pinned')).toBe(false);
  });

  test('returns false after unpinning', async () => {
    const store = makeStore();
    await store.pinModel('was-pinned');
    await store.unpinModel('was-pinned');
    expect(await store.isModelPinned('was-pinned')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordUsage
// ---------------------------------------------------------------------------

describe('FavoritesStore.recordUsage', () => {
  test('adds a new entry on first use', async () => {
    const store = makeStore();
    await store.recordUsage('new-model');
    const recent = await store.getRecentModels(10);
    expect(recent).toContain('new-model');
  });

  test('increments count on subsequent uses', async () => {
    const store = makeStore();
    await store.recordUsage('counted-model');
    await store.recordUsage('counted-model');
    await store.recordUsage('counted-model');
    const data = await store.load();
    const entry = data.history.find((e) => e.modelId === 'counted-model');
    expect(entry?.count).toBe(3);
  });

  test('updates lastUsed timestamp on each use', async () => {
    const store = makeStore();
    await store.recordUsage('ts-model');
    const data1 = await store.load();
    const ts1 = data1.history.find((e) => e.modelId === 'ts-model')!.lastUsed;

    await new Promise((resolve) => setTimeout(resolve, 5));

    await store.recordUsage('ts-model');
    const data2 = await store.load();
    const ts2 = data2.history.find((e) => e.modelId === 'ts-model')!.lastUsed;

    expect(ts2 > ts1).toBe(true);
  });

  test('caps history — oldest entries evicted when over 100', async () => {
    const store = makeStore();
    const history = Array.from({ length: 105 }, (_, i) => ({
      modelId: `model-${String(i).padStart(3, '0')}`,
      lastUsed: new Date(1_000_000 + i * 1000).toISOString(),
      count: 1,
    }));
    await store.save({ pinned: [], history });
    await store.recordUsage('trigger-eviction');
    const data = await store.load();
    expect(data.history.length).toBeLessThanOrEqual(100);
    const ids = data.history.map((entry) => entry.modelId);
    for (let i = 0; i < 5; i++) {
      expect(ids).not.toContain(`model-${String(i).padStart(3, '0')}`);
    }
    expect(ids).toContain('trigger-eviction');
  });

  test('caps history at 100 entries via sequential recordUsage', async () => {
    const store = makeStore();
    const history = Array.from({ length: 100 }, (_, i) => ({
      modelId: `seq-model-${String(i).padStart(3, '0')}`,
      lastUsed: new Date(1_000_000 + i * 1000).toISOString(),
      count: 1,
    }));
    await store.save({ pinned: [], history });
    await store.recordUsage('seq-model-new');
    const data = await store.load();
    expect(data.history.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// getRecentModels
// ---------------------------------------------------------------------------

describe('FavoritesStore.getRecentModels', () => {
  test('returns models sorted by lastUsed descending', async () => {
    const store = makeStore();
    await store.save({
      pinned: [],
      history: [
        { modelId: 'alpha', lastUsed: '2024-01-01T00:00:00.000Z', count: 1 },
        { modelId: 'beta', lastUsed: '2024-01-02T00:00:00.000Z', count: 1 },
        { modelId: 'gamma', lastUsed: '2024-01-03T00:00:00.000Z', count: 1 },
      ],
    });

    const recent = await store.getRecentModels(3);
    expect(recent[0]).toBe('gamma');
    expect(recent[1]).toBe('beta');
    expect(recent[2]).toBe('alpha');
  });

  test('returns at most N models', async () => {
    const store = makeStore();
    await store.save({
      pinned: [],
      history: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({
        modelId: id,
        lastUsed: new Date(1_000_000 + i * 1000).toISOString(),
        count: 1,
      })),
    });
    const recent = await store.getRecentModels(3);
    expect(recent).toHaveLength(3);
  });

  test('returns empty array when no history', async () => {
    const recent = await makeStore().getRecentModels(5);
    expect(recent).toEqual([]);
  });

  test('most recently used model appears first', async () => {
    const store = makeStore();
    await store.save({
      pinned: [],
      history: [
        { modelId: 'first-used', lastUsed: '2024-01-01T00:00:00.000Z', count: 1 },
        { modelId: 'last-used', lastUsed: '2024-01-02T00:00:00.000Z', count: 1 },
      ],
    });
    const recent = await store.getRecentModels(2);
    expect(recent[0]).toBe('last-used');
  });
});
