import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WatcherRecord } from '../runtime/store/domains/watchers.ts';

export interface WatcherStoreSnapshot {
  readonly version: 1;
  readonly watchers: readonly WatcherRecord[];
}

function sortWatchers(watchers: readonly WatcherRecord[]): WatcherRecord[] {
  return [...watchers].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function getWatcherStorePath(rootPath: string): string {
  return join(rootPath, '.goodvibes', 'tui', 'watchers.json');
}

export function resolveWatcherStorePath(storePath?: string): string {
  if (!storePath) {
    throw new Error('Watcher store requires an explicit storePath');
  }
  return storePath;
}

export function loadWatcherSnapshot(storePath: string): WatcherStoreSnapshot | null {
  return loadWatcherSnapshotFromPath(storePath);
}

export function loadWatcherSnapshotFromPath(storePath: string): WatcherStoreSnapshot | null {
  if (!existsSync(storePath)) return null;
  try {
    const raw = readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WatcherStoreSnapshot>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.watchers)) return null;
    return {
      version: 1,
      watchers: parsed.watchers.filter((record): record is WatcherRecord => Boolean(record && typeof record.id === 'string')),
    };
  } catch {
    return null;
  }
}

export function saveWatcherSnapshot(watchers: readonly WatcherRecord[], storePath: string): void {
  saveWatcherSnapshotToPath(watchers, storePath);
}

export function saveWatcherSnapshotToPath(watchers: readonly WatcherRecord[], storePath: string): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const snapshot: WatcherStoreSnapshot = {
    version: 1,
    watchers: sortWatchers(watchers),
  };
  writeFileSync(storePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
}
