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

function makeKnowledgeAskCommandContext(printed: string[], askResult: unknown): CommandContext {
  return {
    session: {
      conversationManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'session-ask',
      },
    },
    provider: {
      providerRegistry: {} as never,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager: {} as never,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      knowledgeService: {
        ask: async () => askResult,
      } as never,
    },
    clients: {
      knowledgeApi: {} as never,
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

  test('reviews a knowledge issue', async () => {
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
    await knowledgeStore.upsertIssue({
      id: 'issue-1',
      severity: 'warning',
      code: 'needs-review',
      message: 'Generated issue needs operator review.',
      status: 'open',
      metadata: {},
    });
    const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry });

    await knowledgeCommand.handler(
      ['review-issue', 'issue-1', 'resolve', '--reviewer', 'test'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Reviewed issue issue-1');
    expect(knowledgeStore.getIssue('issue-1')?.status).toBe('resolved');
  });

  test('asks knowledge and renders SDK semantic answer fields', async () => {
    await knowledgeCommand.handler(
      ['ask', 'what', 'does', 'the', 'manual', 'say?', '--space', 'homeassistant:test', '--mode', 'detailed'],
      makeKnowledgeAskCommandContext(printed, {
        ok: true,
        spaceId: 'homeassistant:test',
        query: 'what does the manual say?',
        answer: {
          text: 'The SDK answer text.',
          mode: 'detailed',
          confidence: 91,
          synthesized: true,
          sources: [{
            id: 'src-1',
            connectorId: 'homeassistant',
            sourceType: 'document',
            title: 'Device manual.pdf',
            tags: [],
            status: 'indexed',
            summary: 'Official manual.',
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          }],
          facts: [{
            id: 'fact-1',
            kind: 'feature',
            slug: 'feature-1',
            title: 'Supports HDMI',
            summary: 'HDMI support is documented.',
            aliases: [],
            status: 'active',
            confidence: 88,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          }],
          linkedObjects: [{
            id: 'device-1',
            kind: 'ha_device',
            slug: 'device-1',
            title: 'Living Room TV',
            summary: 'LG TV',
            aliases: [],
            status: 'active',
            confidence: 90,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          }],
          gaps: [{
            id: 'gap-1',
            kind: 'gap',
            slug: 'gap-1',
            title: 'Missing warranty',
            summary: 'No warranty document linked.',
            aliases: [],
            status: 'open',
            confidence: 60,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          }],
        },
        results: [{
          kind: 'source',
          id: 'src-1',
          score: 1,
          reason: 'This local snippet should not be rendered.',
        }],
      }),
    );

    const output = printed.join('\n');
    expect(output).toContain('The SDK answer text.');
    expect(output).toContain('Sources:');
    expect(output).toContain('Device manual.pdf');
    expect(output).toContain('Facts:');
    expect(output).toContain('Supports HDMI');
    expect(output).toContain('Linked objects:');
    expect(output).toContain('Living Room TV');
    expect(output).toContain('Gaps:');
    expect(output).toContain('Missing warranty');
    expect(output).not.toContain('This local snippet should not be rendered.');
  });
});
