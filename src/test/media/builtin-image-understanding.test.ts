import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/index.ts';
import {
  createBuiltinImageUnderstandingProvider,
  createLocalImageUnderstandingProvider,
  createOpenAIImageUnderstandingProvider,
} from '../../media/builtin-image-understanding.ts';
import { getProviderRegistry, _resetProviderRegistryForTesting } from '../../providers/registry.ts';

describe('builtin image understanding provider', () => {
  const roots: string[] = [];

  afterEach(() => {
    ArtifactStore.resetActiveForTesting();
    _resetProviderRegistryForTesting();
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  test('analyzes artifact-backed images through the existing multimodal provider contract', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-media-artifacts-'));
    roots.push(root);
    const store = new ArtifactStore({ rootDir: root });
    const created = await store.create({
      filename: 'pixel.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('fake-png-binary').toString('base64'),
      metadata: { source: 'unit-test' },
    });

    const registry = getProviderRegistry() as unknown as {
      listModels: () => unknown[];
      getCurrentModel: () => unknown;
      getForModel: () => unknown;
    };
    const originalListModels = registry.listModels;
    const originalGetCurrentModel = registry.getCurrentModel;
    const originalGetForModel = registry.getForModel;
    let capturedMessages: unknown[] = [];

    registry.listModels = () => [{
      id: 'test-vision',
      registryKey: 'testvision:test-vision',
      provider: 'testvision',
      displayName: 'Test Vision',
      description: 'Test vision model',
      capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: true },
      contextWindow: 8192,
      selectable: true,
    }];
    registry.getCurrentModel = () => (registry.listModels() as Array<Record<string, unknown>>)[0];
    registry.getForModel = () => ({
      name: 'testvision',
      models: ['test-vision'],
      async chat(params: { messages: unknown[] }) {
        capturedMessages = params.messages;
        return {
          content: '{"description":"A login form screenshot","text":"Sign in","labels":["ui","login"]}',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 8 },
          stopReason: 'end' as const,
        };
      },
    });

    try {
      const provider = createBuiltinImageUnderstandingProvider();
      const result = await provider.analyze!({
        artifact: {
          artifactId: created.id,
          mimeType: 'application/octet-stream',
          metadata: {},
        },
      });

      expect(result.description).toBe('A login form screenshot');
      expect(result.text).toBe('Sign in');
      expect(result.labels).toEqual(['ui', 'login']);
      expect(result.metadata.llmProviderId).toBe('testvision');
      expect(result.metadata.modelId).toBe('test-vision');
      const userMessage = capturedMessages[0] as { content: Array<{ type: string; mediaType?: string }> };
      expect(userMessage.content[1]?.type).toBe('image');
      expect(userMessage.content[1]?.mediaType).toBe('image/png');
    } finally {
      registry.listModels = originalListModels;
      registry.getCurrentModel = originalGetCurrentModel;
      registry.getForModel = originalGetForModel;
    }
  });

  test('provider-scoped image understanding selects the matching provider family', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-media-artifacts-'));
    roots.push(root);
    const store = new ArtifactStore({ rootDir: root });
    const created = await store.create({
      filename: 'pixel.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('fake-png-binary').toString('base64'),
      metadata: {},
    });

    const registry = getProviderRegistry() as unknown as {
      listModels: () => unknown[];
      getCurrentModel: () => unknown;
      getForModel: (id: string, providerId: string) => unknown;
    };
    const originalListModels = registry.listModels;
    const originalGetCurrentModel = registry.getCurrentModel;
    const originalGetForModel = registry.getForModel;

    registry.listModels = () => [
      {
        id: 'gpt-vision',
        registryKey: 'openai:gpt-vision',
        provider: 'openai',
        displayName: 'GPT Vision',
        description: 'OpenAI multimodal',
        capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: true },
        contextWindow: 8192,
        selectable: true,
      },
      {
        id: 'local-vision',
        registryKey: 'lm-studio:local-vision',
        provider: 'lm-studio',
        displayName: 'Local Vision',
        description: 'Local multimodal',
        capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: true },
        contextWindow: 8192,
        selectable: true,
      },
    ];
    registry.getCurrentModel = () => (registry.listModels() as Array<Record<string, unknown>>)[0];
    registry.getForModel = (_id, providerId) => ({
      name: providerId,
      models: [providerId === 'openai' ? 'gpt-vision' : 'local-vision'],
      async describeRuntime() {
        return {
          policy: { local: providerId === 'lm-studio' },
        };
      },
      async chat() {
        return {
          content: providerId === 'openai'
            ? '{"description":"openai selection","text":"","labels":["openai"]}'
            : '{"description":"local selection","text":"","labels":["local"]}',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 4 },
          stopReason: 'end' as const,
        };
      },
    });

    try {
      const openaiProvider = createOpenAIImageUnderstandingProvider();
      const openaiResult = await openaiProvider.analyze!({
        artifact: { artifactId: created.id, mimeType: 'image/png', metadata: {} },
      });
      expect(openaiResult.metadata.llmProviderId).toBe('openai');
      expect(openaiResult.labels).toEqual(['openai']);

      const localProvider = createLocalImageUnderstandingProvider();
      const localResult = await localProvider.analyze!({
        artifact: { artifactId: created.id, mimeType: 'image/png', metadata: {} },
      });
      expect(localResult.metadata.llmProviderId).toBe('lm-studio');
      expect(localResult.labels).toEqual(['local']);
    } finally {
      registry.listModels = originalListModels;
      registry.getCurrentModel = originalGetCurrentModel;
      registry.getForModel = originalGetForModel;
    }
  });
});
