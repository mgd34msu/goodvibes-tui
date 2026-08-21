// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
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
  // Envelope version 4 = the sdk's current CATALOG_CACHE_VERSION. Version 4
  // added `inputModalities` (the models.dev `modalities.input` list, which
  // decides `multimodal` per model rather than by vendor); version 3 before it
  // added `reasoningOptions`. An older envelope is discarded as stale, which
  // reads here as an empty catalog rather than as a parse error, which is
  // exactly how a stale version number in this helper shows up: every
  // catalog-backed assertion in the suite silently sees zero models.
  const payload = { version: 4 as const, fetchedAt, ttlMs, models };
  writeFileSync(catalogPath, JSON.stringify(payload, null, 2), 'utf-8');
}

export function writeBenchmarksCache(entries: BenchmarkEntry[], cacheDir: string, fetchedAt = Date.now(), ttlMs = 86_400_000): void {
  const { benchmarksPath } = getProviderCachePaths(cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  const payload = { version: 1 as const, fetchedAt, ttlMs, entries };
  writeFileSync(benchmarksPath, JSON.stringify(payload, null, 2), 'utf-8');
}
