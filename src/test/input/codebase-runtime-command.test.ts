// ---------------------------------------------------------------------------
// codebase-runtime-command.test.ts, /codebase
//
// Command-layer test against a REAL CodeIndexStore (via
// createCodeIndexServices) on a scratch fixture tree, no fake/stub store.
// Degraded/lexical mode is expected and fine (no embedding provider is
// configured beyond the SDK's own hashed default). Exercises: the
// store-absent guard, status before/after a build, an explicit build, the
// "already building" no-op path, search's honest empty-index state vs a
// real post-build search labeled 'lexical', and config surfacing
// (auto-build on/off reflected in status).
// ---------------------------------------------------------------------------

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { CodeIndexStore } from '@pellux/goodvibes-sdk/platform/state';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerCodebaseRuntimeCommands } from '../../input/commands/codebase-runtime.ts';
import { CODE_INDEX_ENABLED_CONFIG_KEY, createCodeIndexServices } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeScratchWorkingDirectory(): string {
  const dir = makeProjectTempDir('gv-codebase-command');
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

function makeRealStore(): { store: CodeIndexStore; configManager: ConfigManager } {
  const workingDirectory = makeScratchWorkingDirectory();
  const configManager = makeConfigManager(workingDirectory);
  const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const { codeIndexStore } = createCodeIndexServices({ workingDirectory, surfaceRoot: 'tui', configManager, memoryEmbeddingRegistry });
  return { store: codeIndexStore, configManager };
}

async function waitUntilNotBuilding(store: CodeIndexStore, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (store.isBuilding()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for build to finish');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function makeCtx(
  store: CodeIndexStore | undefined,
  configManager: ConfigManager,
  extras: { flagEnabled?: boolean; reindexActivity?: unknown } = {},
) {
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    session: {
      codeIndexStore: store,
      isPassiveCodeInjectionFlagEnabled: () => extras.flagEnabled ?? false,
      codeIndexReindexScheduler: { lastActivity: () => extras.reindexActivity ?? null },
    },
    platform: { configManager },
    workspace: {},
    provider: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed };
}

describe('codebase-runtime command registration', () => {
  test('registers /codebase', () => {
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    expect(registry.get('codebase')).toBeDefined();
  });
});

describe('/codebase: store-absent guard', () => {
  test('prints an honest "not available" message when ctx.session.codeIndexStore is missing', () => {
    const { configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(undefined, configManager);
    registry.get('codebase')!.handler([], ctx);
    expect(printed[0]).toMatch(/not available in this session/);
  });
});

describe('/codebase status', () => {
  test('before any build: honest zero counts, never-built, auto-build off by default', () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager);

    registry.get('codebase')!.handler(['status'], ctx);
    const output = printed.join('\n');
    expect(output).toContain('available: yes');
    expect(output).toContain('indexed: 0 file(s), 0 chunk(s)');
    expect(output).toContain('last build: never; run /codebase build');
    expect(output).toContain('auto-build on startup: off');
    expect(output).toMatch(/bounds: max \d+ files/);

    store.close();
  });

  test('bare /codebase (no subcommand) is the same as status', () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager);

    registry.get('codebase')!.handler([], ctx);
    expect(printed.join('\n')).toContain('Code index: backend: sqlite-vec');

    store.close();
  });

  test('auto-injection off by default states BOTH gates (flag off + setting off)', () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager); // flag off, setting off

    registry.get('codebase')!.handler(['status'], ctx);
    const output = printed.join('\n');
    expect(output).toContain('auto-injection: off');
    expect(output).toContain('agent-passive-code-injection flag off');
    expect(output).toContain('storage.codeIndexEnabled off');
    store.close();
  });

  test('auto-injection on when the flag AND storage.codeIndexEnabled are both on', () => {
    const { store, configManager } = makeRealStore();
    configManager.set(CODE_INDEX_ENABLED_CONFIG_KEY as ConfigKey, true as never);
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager, { flagEnabled: true });

    registry.get('codebase')!.handler(['status'], ctx);
    expect(printed.join('\n')).toContain('auto-injection: on');
    store.close();
  });

  test('flag on but setting off states only the setting reason', () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager, { flagEnabled: true }); // setting still off

    registry.get('codebase')!.handler(['status'], ctx);
    const output = printed.join('\n');
    expect(output).toContain('auto-injection: off');
    expect(output).toContain('storage.codeIndexEnabled off');
    expect(output).not.toContain('agent-passive-code-injection flag off');
    store.close();
  });

  test('last-reindex activity is surfaced honestly (none, then indexed)', () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);

    const none = makeCtx(store, configManager);
    registry.get('codebase')!.handler(['status'], none.ctx);
    expect(none.printed.join('\n')).toContain('last reindex: none this session');

    const withActivity = makeCtx(store, configManager, {
      reindexActivity: { path: '/repo/src/demo.ts', at: Date.now(), status: 'indexed', mode: 'symbols' },
    });
    registry.get('codebase')!.handler(['status'], withActivity.ctx);
    const output = withActivity.printed.join('\n');
    expect(output).toContain('last reindex: /repo/src/demo.ts');
    expect(output).toContain('indexed (symbols)');
    store.close();
  });

  test('reflects auto-build-on when storage.codeIndexEnabled is set', () => {
    const { store, configManager } = makeRealStore();
    configManager.set(CODE_INDEX_ENABLED_CONFIG_KEY as ConfigKey, true as never);
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager);

    registry.get('codebase')!.handler(['status'], ctx);
    expect(printed.join('\n')).toContain('auto-build on startup: on');

    store.close();
  });
});

describe('/codebase build', () => {
  test('schedules a build; status afterward shows real indexed counts and an honest skip report', async () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager);

    registry.get('codebase')!.handler(['build'], ctx);
    expect(printed[0]).toMatch(/Build scheduled/);

    await waitUntilNotBuilding(store);

    const { ctx: statusCtx, printed: statusPrinted } = makeCtx(store, configManager);
    registry.get('codebase')!.handler(['status'], statusCtx);
    const output = statusPrinted.join('\n');
    expect(output).toMatch(/indexed: [1-9]\d* file\(s\), [1-9]\d* chunk\(s\)/);
    expect(output).toMatch(/last build: \d+ indexed/);
    expect(output).toMatch(/skipped: (none|.+)/);

    store.close();
  });

  test('a build already in progress is reported, not silently re-triggered', () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);

    store.scheduleBuild();
    expect(store.isBuilding()).toBe(true);

    const { ctx, printed } = makeCtx(store, configManager);
    registry.get('codebase')!.handler(['build'], ctx);
    expect(printed[0]).toMatch(/already in progress/);

    store.close();
  });
});

describe('/codebase search', () => {
  test('honest empty state before any build', () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager);

    registry.get('codebase')!.handler(['search', 'greet'], ctx);
    expect(printed[0]).toMatch(/index is empty.*\/codebase build/);

    store.close();
  });

  test('missing query prints usage', () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager);

    registry.get('codebase')!.handler(['search'], ctx);
    expect(printed[0]).toMatch(/Usage: \/codebase search/);

    store.close();
  });

  test('after a real build, returns results honestly labeled "lexical" (no embedding provider configured)', async () => {
    const { store, configManager } = makeRealStore();
    await store.buildFull();

    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager);

    registry.get('codebase')!.handler(['search', 'greet'], ctx);
    const output = printed.join('\n');
    expect(output).toMatch(/^\d+ result\(s\):/);
    expect(output).toContain('[lexical]');
    expect(output).not.toContain('[semantic]');

    store.close();
  });

  test('--limit clamps the number of results', async () => {
    const { store, configManager } = makeRealStore();
    await store.buildFull();
    expect(store.stats().indexedChunks).toBeGreaterThan(1);

    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager);

    registry.get('codebase')!.handler(['search', 'greet', '--limit', '1'], ctx);
    const output = printed.join('\n');
    expect(output).toMatch(/^1 result\(s\):/);

    store.close();
  });
});

describe('/codebase: unknown subcommand', () => {
  test('prints usage for an unrecognized subcommand', () => {
    const { store, configManager } = makeRealStore();
    const registry = new CommandRegistry();
    registerCodebaseRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(store, configManager);

    registry.get('codebase')!.handler(['bogus'], ctx);
    expect(printed[0]).toMatch(/Usage:/);

    store.close();
  });
});
