import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { CommandContext } from '../../input/command-registry.ts';
import { knowledgeCommand } from '../../input/commands/knowledge.ts';
import { createKnowledgeApi, KnowledgeService, KnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import { MemoryRegistry, MemoryStore } from '@pellux/goodvibes-sdk/platform/state/index';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state/index';

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response('<html><head><title>Example Page</title></head><body><h1>Example</h1><p>Knowledge command test page.</p></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

function makeKnowledgeCommandContext(
  root: string,
  printed: string[],
  knowledgeService: KnowledgeService,
  memoryRegistry: MemoryRegistry,
  sessionId = 'session-1',
): CommandContext {
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const configManager = {
    getControlPlaneConfigDir: () => root,
  } as never;
  return {
    session: {
      conversationManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId,
      },
    },
    provider: {
      providerRegistry,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      knowledgeService,
    },
    clients: {
      knowledgeApi: createKnowledgeApi(knowledgeService, { memoryRegistry }),
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
}

describe('knowledgeCommand', () => {
  let printed: string[];
  let root: string;
  let memoryStore: MemoryStore;
  let memoryRegistry: MemoryRegistry;
  let configManager: ConfigManager;

  beforeEach(() => {
    printed = [];
    root = mkdtempSync(join(tmpdir(), 'gv-knowledge-command-'));
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(root, '.goodvibes', 'tui'), workingDir: root });
    memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    memoryRegistry = new MemoryRegistry(memoryStore);
  });

  test('ingests a URL and renders a packet', async () => {
    const artifactStore = new ArtifactStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    const knowledgeStore = new KnowledgeStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    await memoryStore.init();
    const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry });

    await knowledgeCommand.handler(
      ['ingest-url', `${baseUrl}/docs`, '--tags', 'example,docs'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Ingested');

    printed = [];
    await knowledgeCommand.handler(
      ['packet', 'example docs'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Curated Project Knowledge');
  });
});
