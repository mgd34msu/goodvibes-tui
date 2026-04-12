import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogModel } from '../../providers/model-catalog.ts';
import type { BenchmarkEntry } from '../../providers/model-benchmarks.ts';

export interface ProviderCacheFixture {
  readonly homeDir: string;
  readonly cleanup: () => void;
  readonly restoreEnv: () => void;
}

export interface ProviderCachePaths {
  readonly catalogPath: string;
  readonly benchmarksPath: string;
}

export function createProviderCacheFixture(prefix = 'gv-provider-cache-'): ProviderCacheFixture {
  const homeDir = homedir();
  const cacheDir = join(homeDir, '.goodvibes', 'tui');
  const backupDir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hadExistingCacheDir = existsSync(cacheDir);

  if (hadExistingCacheDir) {
    cpSync(cacheDir, backupDir, { recursive: true });
  }

  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });

  return {
    homeDir,
    cleanup: () => {
      try {
        rmSync(cacheDir, { recursive: true, force: true });
        if (hadExistingCacheDir) {
          cpSync(backupDir, cacheDir, { recursive: true });
          rmSync(backupDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup failures in tests
      }
    },
    restoreEnv: () => {},
  };
}

export function getProviderCachePaths(homeDir = homedir()): ProviderCachePaths {
  const cacheDir = join(homeDir, '.goodvibes', 'tui');
  return {
    catalogPath: join(cacheDir, 'model-catalog.json'),
    benchmarksPath: join(cacheDir, 'benchmarks.json'),
  };
}

export function writeModelCatalogCache(models: CatalogModel[], homeDir = homedir(), fetchedAt = Date.now(), ttlMs = 86_400_000): void {
  const { catalogPath } = getProviderCachePaths(homeDir);
  mkdirSync(join(homeDir, '.goodvibes', 'tui'), { recursive: true });
  const payload = { version: 1 as const, fetchedAt, ttlMs, models };
  writeFileSync(catalogPath, JSON.stringify(payload, null, 2), 'utf-8');
}

export function writeBenchmarksCache(entries: BenchmarkEntry[], homeDir = homedir(), fetchedAt = Date.now(), ttlMs = 86_400_000): void {
  const { benchmarksPath } = getProviderCachePaths(homeDir);
  mkdirSync(join(homeDir, '.goodvibes', 'tui'), { recursive: true });
  const payload = { version: 1 as const, fetchedAt, ttlMs, entries };
  writeFileSync(benchmarksPath, JSON.stringify(payload, null, 2), 'utf-8');
}
