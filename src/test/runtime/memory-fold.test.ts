import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore, MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import { ConfigManager } from '../../config/index.ts';
import { foldTuiLegacyMemory } from '../../runtime/memory-fold.ts';

// foldTuiLegacyMemory folds a project's legacy per-project TUI memory
// store into the home-scoped canonical store at boot. Hermetic: an ephemeral temp
// canonical store, no daemon. Cleaned up in afterEach so no sqlite files leak.

let root: string;
let canonical: MemoryStore;
let registry: MemoryEmbeddingProviderRegistry;

beforeEach(async () => {
  root = join(tmpdir(), `gv-memory-fold-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: root, homeDir: root, workingDir: root });
  registry = new MemoryEmbeddingProviderRegistry({ configManager });
  canonical = new MemoryStore(join(root, 'canonical-memory.sqlite'), { embeddingRegistry: registry });
  await canonical.init();
});

afterEach(() => {
  try {
    canonical.close();
  } catch {
    // best effort
  }
  rmSync(root, { recursive: true, force: true });
});

describe('foldTuiLegacyMemory (boot fold)', () => {
  test('a project with no legacy store imports nothing and records the missing source (idempotent, non-fatal)', async () => {
    // `root` has no .goodvibes/tui/memory.sqlite — the legacy source is missing, not an error.
    const workingDir = root;

    const report = await foldTuiLegacyMemory(canonical, registry, workingDir);
    expect(report.totalImported).toBe(0);
    expect(report.failedSources).toHaveLength(0);
    expect(report.missingSources.length).toBeGreaterThan(0);
    // The report names the legacy per-project TUI store for this working dir.
    expect(report.missingSources.some((label) => label.includes(workingDir))).toBe(true);

    // Idempotent: re-running still imports nothing and never throws.
    const rerun = await foldTuiLegacyMemory(canonical, registry, workingDir);
    expect(rerun.totalImported).toBe(0);
  });
});
