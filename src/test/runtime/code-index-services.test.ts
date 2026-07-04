// ---------------------------------------------------------------------------
// code-index-services.test.ts — Wave 5 (wo804)
//
// Integration test against a REAL CodeIndexStore (not a fake) on a scratch
// fixture tree, proving the TUI's OWN wiring (createCodeIndexServices)
// produces a working store rooted at the right path, honors the config-gated
// default-OFF auto-start contract, and that an explicit build indexes real
// files — degraded/lexical mode is expected and fine (no embedding provider
// is configured; the HASHED_MEMORY_EMBEDDING_PROVIDER default is a weak
// lexical-ish signal, not "no provider" — see the SDK's own degradation
// doc). Mirrors workstream-services.test.ts's scratch-project-root harness
// and memory-store.test.ts's ConfigManager construction.
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import {
  CODE_INDEX_ENABLED_CONFIG_KEY,
  codeIndexDbPath,
  createCodeIndexServices,
  isCodeIndexAutoStartEnabled,
} from '../../runtime/code-index-services.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeScratchWorkingDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-code-index-services-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'demo.ts'),
    'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
  );
  writeFileSync(join(dir, 'src', 'other.ts'), 'export const answer = 42;\n');
  return dir;
}

function makeConfigManager(workingDir: string): ConfigManager {
  const configDir = join(workingDir, '.goodvibes', 'tui');
  mkdirSync(configDir, { recursive: true });
  return new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir });
}

async function waitUntilNotBuilding(store: { isBuilding(): boolean }, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (store.isBuilding()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for build to finish');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('createCodeIndexServices — real CodeIndexStore wiring', () => {
  test('constructs a store rooted under .goodvibes/tui/code-index.sqlite, schema-initialized but with no build run', () => {
    const workingDirectory = makeScratchWorkingDirectory();
    const configManager = makeConfigManager(workingDirectory);
    const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });

    const { codeIndexStore } = createCodeIndexServices({ workingDirectory, configManager, memoryEmbeddingRegistry });

    expect(codeIndexDbPath(workingDirectory)).toBe(join(workingDirectory, '.goodvibes', 'tui', 'code-index.sqlite'));
    expect(existsSync(codeIndexDbPath(workingDirectory))).toBe(true);

    const stats = codeIndexStore.stats();
    expect(stats.available).toBe(true);
    expect(stats.indexedFiles).toBe(0);
    expect(stats.lastBuild).toBeNull();
    expect(codeIndexStore.isBuilding()).toBe(false);

    codeIndexStore.close();
  });

  test('auto-start is OFF by default — construction never schedules a build', async () => {
    const workingDirectory = makeScratchWorkingDirectory();
    const configManager = makeConfigManager(workingDirectory);
    const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });

    expect(isCodeIndexAutoStartEnabled(configManager)).toBe(false);
    const { codeIndexStore } = createCodeIndexServices({ workingDirectory, configManager, memoryEmbeddingRegistry });

    // Give any accidental fire-and-forget build a moment to have started.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(codeIndexStore.isBuilding()).toBe(false);
    expect(codeIndexStore.stats().lastBuild).toBeNull();

    codeIndexStore.close();
  });

  test('enabling storage.codeIndexEnabled before construction auto-schedules a build that indexes real files', async () => {
    const workingDirectory = makeScratchWorkingDirectory();
    const configManager = makeConfigManager(workingDirectory);
    configManager.set(CODE_INDEX_ENABLED_CONFIG_KEY as ConfigKey, true as never);
    expect(isCodeIndexAutoStartEnabled(configManager)).toBe(true);

    const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    const { codeIndexStore } = createCodeIndexServices({ workingDirectory, configManager, memoryEmbeddingRegistry });

    await waitUntilNotBuilding(codeIndexStore);
    const stats = codeIndexStore.stats();
    expect(stats.indexedFiles).toBeGreaterThan(0);
    expect(stats.lastBuild).not.toBeNull();
    expect(stats.lastBuild!.filesIndexed).toBeGreaterThan(0);

    // Honest degradation: no real embedding provider is configured in this
    // scratch harness, so semantic retrieval is unavailable and search
    // results must say so rather than implying more precision than exists.
    expect(stats.semanticRetrievalAvailable).toBe(false);
    expect(codeIndexStore.describeDegradation()).toBe(
      'code auto-retrieval disabled: no semantic embedding provider configured',
    );
    const results = codeIndexStore.search('greet');
    for (const result of results) expect(result.label).toBe('lexical');

    codeIndexStore.close();
  });

  test('reroot moves the store to a new working directory + db path', async () => {
    const workingDirectory = makeScratchWorkingDirectory();
    const configManager = makeConfigManager(workingDirectory);
    const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    const { codeIndexStore } = createCodeIndexServices({ workingDirectory, configManager, memoryEmbeddingRegistry });

    const newWorkingDirectory = makeScratchWorkingDirectory();
    await codeIndexStore.reroot(newWorkingDirectory, codeIndexDbPath(newWorkingDirectory));

    expect(existsSync(codeIndexDbPath(newWorkingDirectory))).toBe(true);
    expect(codeIndexStore.stats().path).toBe(codeIndexDbPath(newWorkingDirectory));

    codeIndexStore.close();
  });
});
