import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  loadFavorites,
  saveFavorites,
  pinModel,
  unpinModel,
  getPinned,
  isModelPinned,
  recordUsage,
  getRecentModels,
  _resetFavoritesCache,
  _setFavoritesDir,
} from '../../providers/favorites.ts';

// ---------------------------------------------------------------------------
// Test isolation — redirect favorites to a per-test temp directory
// ---------------------------------------------------------------------------

const TMP_BASE = join(import.meta.dir, '__favorites_tmp__');

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(TMP_BASE, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  _setFavoritesDir(tmpDir); // resets cache as a side effect
});

afterEach(() => {
  _resetFavoritesCache();
  try { rmSync(TMP_BASE, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// loadFavorites / saveFavorites — round-trip and empty-file handling
// ---------------------------------------------------------------------------

describe('loadFavorites', () => {
  test('returns empty defaults when file does not exist', async () => {
    const data = await loadFavorites();
    expect(data.pinned).toEqual([]);
    expect(data.history).toEqual([]);
  });

  test('persistence round-trip: save then load', async () => {
    const input = {
      pinned: [{ modelId: 'model-a', pinnedAt: '2024-01-01T00:00:00.000Z' }],
      history: [{ modelId: 'model-b', lastUsed: '2024-01-02T00:00:00.000Z', count: 3 }],
    };
    await saveFavorites(input);
    _resetFavoritesCache();
    const loaded = await loadFavorites();
    expect(loaded.pinned).toHaveLength(1);
    expect(loaded.pinned[0].modelId).toBe('model-a');
    expect(loaded.history).toHaveLength(1);
    expect(loaded.history[0].count).toBe(3);
  });

  test('returns empty defaults on invalid JSON', async () => {
    writeFileSync(join(tmpDir, 'favorites.json'), 'not-valid-json', 'utf-8');
    _resetFavoritesCache();
    const data = await loadFavorites();
    expect(data.pinned).toEqual([]);
    expect(data.history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pin / Unpin lifecycle
// ---------------------------------------------------------------------------

describe('pinModel / unpinModel', () => {
  test('pinning a model adds it to pinned list', async () => {
    await pinModel('gpt-4o');
    const pinned = await getPinned();
    expect(pinned).toContain('gpt-4o');
  });

  test('pinning same model twice does not duplicate', async () => {
    await pinModel('gpt-4o');
    await pinModel('gpt-4o');
    const pinned = await getPinned();
    expect(pinned.filter(id => id === 'gpt-4o')).toHaveLength(1);
  });

  test('unpinning removes model from list', async () => {
    await pinModel('claude-opus');
    await unpinModel('claude-opus');
    const pinned = await getPinned();
    expect(pinned).not.toContain('claude-opus');
  });

  test('unpinning a model not in list is a no-op', async () => {
    await unpinModel('nonexistent-model');
    const pinned = await getPinned();
    expect(pinned).not.toContain('nonexistent-model');
  });

  test('pinning multiple models preserves all', async () => {
    await pinModel('model-a');
    await pinModel('model-b');
    await pinModel('model-c');
    const pinned = await getPinned();
    expect(pinned).toContain('model-a');
    expect(pinned).toContain('model-b');
    expect(pinned).toContain('model-c');
  });
});

// ---------------------------------------------------------------------------
// isModelPinned
// ---------------------------------------------------------------------------

describe('isModelPinned', () => {
  test('returns true for a pinned model', async () => {
    await pinModel('pinned-model');
    expect(await isModelPinned('pinned-model')).toBe(true);
  });

  test('returns false for an unpinned model', async () => {
    expect(await isModelPinned('not-pinned')).toBe(false);
  });

  test('returns false after unpinning', async () => {
    await pinModel('was-pinned');
    await unpinModel('was-pinned');
    expect(await isModelPinned('was-pinned')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordUsage
// ---------------------------------------------------------------------------

describe('recordUsage', () => {
  test('adds a new entry on first use', async () => {
    await recordUsage('new-model');
    const recent = await getRecentModels(10);
    expect(recent).toContain('new-model');
  });

  test('increments count on subsequent uses', async () => {
    await recordUsage('counted-model');
    await recordUsage('counted-model');
    await recordUsage('counted-model');
    _resetFavoritesCache();
    const data = await loadFavorites();
    const entry = data.history.find(e => e.modelId === 'counted-model');
    expect(entry?.count).toBe(3);
  });

  test('updates lastUsed timestamp on each use', async () => {
    await recordUsage('ts-model');
    _resetFavoritesCache();
    const data1 = await loadFavorites();
    const ts1 = data1.history.find(e => e.modelId === 'ts-model')!.lastUsed;

    // Small delay to ensure distinct ISO timestamps
    await new Promise(r => setTimeout(r, 5));

    await recordUsage('ts-model');
    _resetFavoritesCache();
    const data2 = await loadFavorites();
    const ts2 = data2.history.find(e => e.modelId === 'ts-model')!.lastUsed;

    expect(ts2 > ts1).toBe(true);
  });

  test('caps history — oldest entries evicted when over 100', async () => {
    // Directly write a dataset of 105 entries with known ascending timestamps
    const history = Array.from({ length: 105 }, (_, i) => ({
      modelId: `model-${String(i).padStart(3, '0')}`,
      lastUsed: new Date(1000000 + i * 1000).toISOString(),
      count: 1,
    }));
    await saveFavorites({ pinned: [], history });
    // Record one more to trigger eviction check
    await recordUsage('trigger-eviction');
    _resetFavoritesCache();
    const data = await loadFavorites();
    expect(data.history.length).toBeLessThanOrEqual(100);
    // The oldest (model-000 through model-004) should be evicted
    const ids = data.history.map(e => e.modelId);
    for (let i = 0; i < 5; i++) {
      expect(ids).not.toContain(`model-${String(i).padStart(3, '0')}`);
    }
    // The most recently added should be retained
    expect(ids).toContain('trigger-eviction');
  });

  test('caps history at 100 entries via sequential recordUsage', async () => {
    // Plant 100 entries with known timestamps, then add one more
    const history = Array.from({ length: 100 }, (_, i) => ({
      modelId: `seq-model-${String(i).padStart(3, '0')}`,
      lastUsed: new Date(1000000 + i * 1000).toISOString(),
      count: 1,
    }));
    await saveFavorites({ pinned: [], history });
    await recordUsage('seq-model-new');
    _resetFavoritesCache();
    const data = await loadFavorites();
    expect(data.history.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// getRecentModels
// ---------------------------------------------------------------------------

describe('getRecentModels', () => {
  test('returns models sorted by lastUsed descending', async () => {
    await saveFavorites({
      pinned: [],
      history: [
        { modelId: 'alpha', lastUsed: '2024-01-01T00:00:00.000Z', count: 1 },
        { modelId: 'beta',  lastUsed: '2024-01-02T00:00:00.000Z', count: 1 },
        { modelId: 'gamma', lastUsed: '2024-01-03T00:00:00.000Z', count: 1 },
      ],
    });

    const recent = await getRecentModels(3);
    expect(recent[0]).toBe('gamma');
    expect(recent[1]).toBe('beta');
    expect(recent[2]).toBe('alpha');
  });

  test('returns at most N models', async () => {
    await saveFavorites({
      pinned: [],
      history: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({
        modelId: id,
        lastUsed: new Date(1000000 + i * 1000).toISOString(),
        count: 1,
      })),
    });
    const recent = await getRecentModels(3);
    expect(recent).toHaveLength(3);
  });

  test('returns empty array when no history', async () => {
    const recent = await getRecentModels(5);
    expect(recent).toEqual([]);
  });

  test('most recently used model appears first', async () => {
    await saveFavorites({
      pinned: [],
      history: [
        { modelId: 'first-used', lastUsed: '2024-01-01T00:00:00.000Z', count: 1 },
        { modelId: 'last-used',  lastUsed: '2024-01-02T00:00:00.000Z', count: 1 },
      ],
    });
    const recent = await getRecentModels(2);
    expect(recent[0]).toBe('last-used');
  });
});
