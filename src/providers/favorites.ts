import { join } from 'path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────────────

export interface FavoriteEntry {
  modelId: string;
  pinnedAt: string;
}

export interface UsageEntry {
  modelId: string;
  lastUsed: string;
  count: number;
}

export interface FavoritesData {
  pinned: FavoriteEntry[];
  history: UsageEntry[];
}

// ── Path configuration ───────────────────────────────────────────────────────

let _favoritesDir: string = join(homedir(), '.goodvibes', 'tui');

/**
 * _setFavoritesDir — Override the directory used for favorites.json.
 * Intended for testing only. Resets the cache as a side effect.
 */
export function _setFavoritesDir(dir: string): void {
  _favoritesDir = dir;
  _cache = undefined;
}

function getFavoritesPath(): string {
  return join(_favoritesDir, 'favorites.json');
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_HISTORY = 100;

// ── Empty defaults ───────────────────────────────────────────────────────────

function emptyData(): FavoritesData {
  return { pinned: [], history: [] };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/**
 * loadFavorites — Load favorites data from ~/.goodvibes/tui/favorites.json.
 * Returns empty defaults if the file does not exist or cannot be parsed.
 */
export async function loadFavorites(): Promise<FavoritesData> {
  const file = Bun.file(getFavoritesPath());
  const exists = await file.exists();
  if (!exists) return emptyData();
  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as Partial<FavoritesData>;
    return {
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return emptyData();
  }
}

/**
 * saveFavorites — Atomically write favorites data to disk.
 * Uses a temp file + rename for crash safety.
 */
async function saveFavorites(data: FavoritesData): Promise<void> {
  const path = getFavoritesPath();
  mkdirSync(_favoritesDir, { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  const { rename } = await import('node:fs/promises');
  await rename(tmp, path);
}

// ── In-memory state (lazy-loaded) ────────────────────────────────────────────

let _cache: FavoritesData | undefined;

async function getCache(): Promise<FavoritesData> {
  if (!_cache) _cache = await loadFavorites();
  return _cache;
}

async function flush(): Promise<void> {
  if (_cache) await saveFavorites(_cache);
}

/** Reset cache (used in tests). */
export function _resetFavoritesCache(): void {
  _cache = undefined;
}

// ── Pinning ──────────────────────────────────────────────────────────────────

/**
 * pinModel — Add modelId to pinned list if not already pinned.
 */
export async function pinModel(id: string): Promise<void> {
  const data = await getCache();
  const alreadyPinned = data.pinned.some(e => e.modelId === id);
  if (alreadyPinned) return;
  data.pinned.push({ modelId: id, pinnedAt: new Date().toISOString() });
  await flush();
}

/**
 * unpinModel — Remove modelId from pinned list.
 */
export async function unpinModel(id: string): Promise<void> {
  const data = await getCache();
  data.pinned = data.pinned.filter(e => e.modelId !== id);
  await flush();
}

/**
 * getPinned — Return all pinned model IDs.
 */
export async function getPinned(): Promise<string[]> {
  const data = await getCache();
  return data.pinned.map(e => e.modelId);
}

/**
 * isModelPinned — Boolean check for whether a model is pinned.
 */
export async function isModelPinned(id: string): Promise<boolean> {
  const data = await getCache();
  return data.pinned.some(e => e.modelId === id);
}

// ── Usage tracking ───────────────────────────────────────────────────────────

/**
 * recordUsage — Increment usage count for a model and update lastUsed timestamp.
 * Adds a new entry if model is not in history. Caps history at 100 entries,
 * evicting the oldest by lastUsed when the cap is exceeded.
 */
export async function recordUsage(id: string): Promise<void> {
  const data = await getCache();
  const now = new Date().toISOString();
  const existing = data.history.find(e => e.modelId === id);
  if (existing) {
    existing.count += 1;
    existing.lastUsed = now;
  } else {
    data.history.push({ modelId: id, lastUsed: now, count: 1 });
  }
  // Cap at MAX_HISTORY — evict oldest by lastUsed
  if (data.history.length > MAX_HISTORY) {
    data.history.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
    data.history = data.history.slice(data.history.length - MAX_HISTORY);
  }
  await flush();
}

/**
 * getRecentModels — Return the last N distinct models used, sorted by lastUsed descending.
 */
export async function getRecentModels(n: number): Promise<string[]> {
  const data = await getCache();
  return data.history
    .slice()
    .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
    .slice(0, n)
    .map(e => e.modelId);
}
