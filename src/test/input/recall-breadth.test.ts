import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../../config/manager.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';
import { createMemoryApi } from '../../knowledge/knowledge-api.ts';
import { MemoryRegistry, MemoryStore } from '../../state/memory-store.ts';
import { MemoryEmbeddingProviderRegistry } from '../../state/index.ts';
import { createShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';

function makeBaseContext(registry: MemoryRegistry, printed: string[]): CommandContext {
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const configManager = {} as never;
  const shellPaths = createShellPathService({ workingDirectory: process.cwd(), homeDirectory: process.cwd() });
  return {
    session: {
      conversationManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'session-1',
      },
    },
    provider: {
      providerRegistry,
    },
    workspace: {
      shellPaths,
    },
    platform: {
      config: {} as never,
      configManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: { listServerSecurity: () => [] } as never,
      memoryRegistry: registry,
    },
    clients: {
      knowledgeApi: {
        memory: createMemoryApi(registry),
      } as never,
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
}

describe('recall command breadth', () => {
  let dir: string;
  let store: MemoryStore;
  let registry: MemoryRegistry;
  let printed: string[];
  let configManager: ConfigManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gv-recall-'));
    configManager = new ConfigManager({ configDir: join(dir, '.goodvibes', 'tui'), workingDir: dir });
    store = new MemoryStore(join(dir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    await store.init();
    registry = new MemoryRegistry(store);
    printed = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('supports scoped add, queue, and review flows', async () => {
    const context = makeBaseContext(registry, printed);

    await recallCommand.handler(['add', 'runbook', 'Deploy', 'runbook', '--scope', 'team', '--tags', 'ops,release'], context);
    const created = registry.getAll()[0];
    expect(created?.scope).toBe('team');

    recallCommand.handler(['queue', '5'], context);
    expect(printed.some((line) => line.includes('Review queue'))).toBe(true);

    printed.length = 0;
    recallCommand.handler(['review', created!.id, 'reviewed', '--confidence', '92', '--by', 'operator'], context);
    expect(registry.get(created!.id)?.reviewState).toBe('reviewed');
    expect(registry.get(created!.id)?.confidence).toBe(92);
    expect(printed.some((line) => line.includes('Reviewed'))).toBe(true);
  });

  test('supports sqlite-vec semantic search and vector status commands', async () => {
    const context = makeBaseContext(registry, printed);
    await registry.add({
      scope: 'project',
      cls: 'runbook',
      summary: 'Use orchestration graph runtime edits for node scheduling changes',
      tags: ['runtime', 'orchestration'],
      review: { state: 'reviewed', confidence: 92 },
    });
    await registry.add({
      scope: 'project',
      cls: 'fact',
      summary: 'Slack channel adapter handles slash commands',
      tags: ['slack'],
      review: { state: 'reviewed', confidence: 90 },
    });

    recallCommand.handler(['search', '--semantic', 'orchestration', 'runtime', '--limit', '1'], context);
    expect(printed.join('\n')).toContain('semantic record');
    expect(printed.join('\n')).toContain('orchestration graph runtime edits');
    expect(printed.join('\n')).toContain('sim ');

    printed.length = 0;
    recallCommand.handler(['vector', 'status'], context);
    expect(printed.join('\n')).toContain('backend: sqlite-vec');
    expect(printed.join('\n')).toContain('indexed records: 2');

    printed.length = 0;
    recallCommand.handler(['vector', 'rebuild'], context);
    expect(printed.join('\n')).toContain('rebuild complete');
  });

  test('exports and imports durable memory bundles', async () => {
    const context = makeBaseContext(registry, printed);

    await registry.add({ scope: 'team', cls: 'decision', summary: 'Shared deploy decision' });
    const exportPath = join(dir, 'knowledge', 'team-bundle.json');

    recallCommand.handler(['export', exportPath, '--scope', 'team'], context);
    const bundleText = readFileSync(exportPath, 'utf-8');
    expect(bundleText).toContain('"scope": "team"');
    expect(bundleText).toContain('"recordCount": 1');

    const importDir = mkdtempSync(join(tmpdir(), 'gv-recall-import-'));
    const importConfig = new ConfigManager({ configDir: join(importDir, '.goodvibes', 'tui'), workingDir: importDir });
    const importStore = new MemoryStore(join(importDir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: importConfig }),
    });
    await importStore.init();
    const importRegistry = new MemoryRegistry(importStore);
    const importPrinted: string[] = [];

    try {
      const importContext = makeBaseContext(importRegistry, importPrinted);
      await recallCommand.handler(['import', exportPath], importContext);
      expect(importRegistry.getAll()).toHaveLength(1);
      expect(importRegistry.getAll()[0]?.scope).toBe('team');
      expect(importPrinted.some((line) => line.includes('Imported bundle'))).toBe(true);
    } finally {
      importStore.close();
      rmSync(importDir, { recursive: true, force: true });
    }
  });

  test('supports handoff inspection and import flows', async () => {
    const context = makeBaseContext(registry, printed);
    await registry.add({ scope: 'team', cls: 'runbook', summary: 'Shared rollout checklist' });
    const handoffPath = join(dir, 'handoff', 'team.json');

    recallCommand.handler(['handoff-export', handoffPath, '--scope', 'team'], context);
    expect(readFileSync(handoffPath, 'utf-8')).toContain('"scope": "team"');

    printed.length = 0;
    recallCommand.handler(['handoff-inspect', handoffPath], context);
    expect(printed.some((line) => line.includes('Memory Handoff Review'))).toBe(true);

    const importDir = mkdtempSync(join(tmpdir(), 'gv-recall-handoff-import-'));
    const importConfig = new ConfigManager({ configDir: join(importDir, '.goodvibes', 'tui'), workingDir: importDir });
    const importStore = new MemoryStore(join(importDir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: importConfig }),
    });
    await importStore.init();
    const importRegistry = new MemoryRegistry(importStore);
    const importPrinted: string[] = [];

    try {
      const importContext = makeBaseContext(importRegistry, importPrinted);
      await recallCommand.handler(['handoff-import', handoffPath], importContext);
      expect(importRegistry.getAll()).toHaveLength(1);
      expect(importPrinted.some((line) => line.includes('Imported bundle'))).toBe(true);
    } finally {
      importStore.close();
      rmSync(importDir, { recursive: true, force: true });
    }
  });
});
