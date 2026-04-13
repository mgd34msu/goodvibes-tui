import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

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

const MAX_HISTORY = 100;

function emptyData(): FavoritesData {
  return { pinned: [], history: [] };
}

export interface FavoritesStoreOptions {
  readonly dir: string;
}

export class FavoritesStore {
  private readonly dir: string;
  private cache: FavoritesData | null = null;

  constructor(options: FavoritesStoreOptions) {
    this.dir = options.dir;
  }

  getDirectory(): string {
    return this.dir;
  }

  getPath(): string {
    return join(this.dir, 'favorites.json');
  }

  async load(): Promise<FavoritesData> {
    const file = Bun.file(this.getPath());
    if (!await file.exists()) {
      const empty = emptyData();
      this.cache = empty;
      return empty;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<FavoritesData>;
      const loaded = {
        pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
      } satisfies FavoritesData;
      this.cache = loaded;
      return loaded;
    } catch {
      const empty = emptyData();
      this.cache = empty;
      return empty;
    }
  }

  async save(data: FavoritesData): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const path = this.getPath();
    const tmp = `${path}.tmp.${randomUUID()}`;
    await Bun.write(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
    this.cache = data;
  }

  async pinModel(id: string): Promise<void> {
    const data = await this.getData();
    if (data.pinned.some((entry) => entry.modelId === id)) return;
    data.pinned.push({ modelId: id, pinnedAt: new Date().toISOString() });
    await this.save(data);
  }

  async unpinModel(id: string): Promise<void> {
    const data = await this.getData();
    data.pinned = data.pinned.filter((entry) => entry.modelId !== id);
    await this.save(data);
  }

  async getPinned(): Promise<string[]> {
    const data = await this.getData();
    return data.pinned.map((entry) => entry.modelId);
  }

  async isModelPinned(id: string): Promise<boolean> {
    const data = await this.getData();
    return data.pinned.some((entry) => entry.modelId === id);
  }

  async recordUsage(id: string): Promise<void> {
    const data = await this.getData();
    const now = new Date().toISOString();
    const existing = data.history.find((entry) => entry.modelId === id);
    if (existing) {
      existing.count += 1;
      existing.lastUsed = now;
    } else {
      data.history.push({ modelId: id, lastUsed: now, count: 1 });
    }
    if (data.history.length > MAX_HISTORY) {
      data.history.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
      data.history = data.history.slice(data.history.length - MAX_HISTORY);
    }
    await this.save(data);
  }

  async getRecentModels(n: number): Promise<string[]> {
    const data = await this.getData();
    return data.history
      .slice()
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
      .slice(0, n)
      .map((entry) => entry.modelId);
  }

  private async getData(): Promise<FavoritesData> {
    if (this.cache) return this.cache;
    return this.load();
  }
}
