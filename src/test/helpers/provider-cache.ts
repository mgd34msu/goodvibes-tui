import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogModel } from '@pellux/goodvibes-sdk/platform/providers';
import type { BenchmarkEntry } from '@pellux/goodvibes-sdk/platform/providers';

export interface ProviderCacheFixture {
  readonly cacheDir: string;
  readonly cleanup: () => void;
  readonly restoreEnv: () => void;
}

export interface ProviderCachePaths {
  readonly catalogPath: string;
  readonly benchmarksPath: string;
}

export function createProviderCacheFixture(cacheDir: string): ProviderCacheFixture {
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });

  return {
    cacheDir,
    cleanup: () => {
      try {
        rmSync(cacheDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures in tests
      }
    },
    restoreEnv: () => {},
  };
}

export function getProviderCachePaths(cacheDir: string): ProviderCachePaths {
  return {
    catalogPath: join(cacheDir, 'model-catalog.json'),
    benchmarksPath: join(cacheDir, 'benchmarks.json'),
  };
}

export function writeModelCatalogCache(models: CatalogModel[], cacheDir: string, fetchedAt = Date.now(), ttlMs = 86_400_000): void {
  const { catalogPath } = getProviderCachePaths(cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  // Envelope version 2 = the sdk's current CATALOG_CACHE_VERSION (the
  // store-versioning round); an older version is rejected as malformed.
  const payload = { version: 2 as const, fetchedAt, ttlMs, models };
  writeFileSync(catalogPath, JSON.stringify(payload, null, 2), 'utf-8');
}

export function writeBenchmarksCache(entries: BenchmarkEntry[], cacheDir: string, fetchedAt = Date.now(), ttlMs = 86_400_000): void {
  const { benchmarksPath } = getProviderCachePaths(cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  const payload = { version: 1 as const, fetchedAt, ttlMs, entries };
  writeFileSync(benchmarksPath, JSON.stringify(payload, null, 2), 'utf-8');
}
