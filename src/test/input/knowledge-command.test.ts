import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/index.ts';
import { knowledgeCommand } from '../../input/commands/knowledge.ts';
import { KnowledgeService, KnowledgeStore } from '../../knowledge/index.ts';
import { _resetMemoryRegistryForTesting } from '../../state/index.ts';

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

describe('knowledgeCommand', () => {
  let printed: string[];
  let root: string;

  beforeEach(() => {
    printed = [];
    root = mkdtempSync(join(tmpdir(), 'gv-knowledge-command-'));
    ArtifactStore.resetActiveForTesting();
    KnowledgeStore.resetActiveForTesting();
    KnowledgeService.resetActiveForTesting();
    _resetMemoryRegistryForTesting();
  });

  test('ingests a URL and renders a packet', async () => {
    await knowledgeCommand.handler(['ingest-url', `${baseUrl}/docs`, '--tags', 'example,docs'], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {
        getControlPlaneConfigDir: () => root,
      } as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'session-1',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    });

    expect(printed.join('\n')).toContain('Ingested');

    printed = [];
    await knowledgeCommand.handler(['packet', 'example docs'], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {
        getControlPlaneConfigDir: () => root,
      } as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'session-1',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    });

    expect(printed.join('\n')).toContain('Curated Project Knowledge');
  });
});
