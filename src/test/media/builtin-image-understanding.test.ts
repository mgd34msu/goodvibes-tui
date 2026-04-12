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
import type { LLMProvider, ProviderMessage } from '../../providers/interface.ts';
import type { ModelDefinition, ProviderRegistry } from '../../providers/registry.ts';

type ImageModelRegistry = Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels'>;

function makeImageModelRegistry(
  models: ModelDefinition[],
  providerLookup: Map<string, LLMProvider>,
): ImageModelRegistry {
  return {
    listModels: () => models,
    getCurrentModel: () => {
      if (models.length === 0) {
        throw new Error('No multimodal models configured');
      }
      return models[0]!;
    },
    getForModel: (_modelId: string, providerId?: string) => {
      if (!providerId) throw new Error('Provider id is required');
      const provider = providerLookup.get(providerId);
      if (!provider) throw new Error(`Provider not found: ${providerId}`);
      return provider;
    },
  };
}

describe('builtin image understanding provider', () => {
  const roots: string[] = [];

  afterEach(() => {
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

    let capturedMessages: ProviderMessage[] = [];
    const providerLookup = new Map<string, LLMProvider>();
    const registry = makeImageModelRegistry([{
      id: 'test-vision',
      registryKey: 'testvision:test-vision',
      provider: 'testvision',
      displayName: 'Test Vision',
      description: 'Test vision model',
      capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: true },
      contextWindow: 8192,
      selectable: true,
    }], providerLookup);
    providerLookup.set('testvision', {
      name: 'testvision',
      models: ['test-vision'],
      async chat(params) {
        capturedMessages = params.messages;
        return {
          content: '{"description":"A login form screenshot","text":"Sign in","labels":["ui","login"]}',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 8 },
          stopReason: 'end',
        };
      },
    });

    const provider = createBuiltinImageUnderstandingProvider(registry, store);
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
    const userMessage = capturedMessages[0] as ProviderMessage & { content: Array<{ type: string; mediaType?: string }> };
    expect(userMessage.content[1]?.type).toBe('image');
    expect(userMessage.content[1]?.mediaType).toBe('image/png');
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

    const providerLookup = new Map<string, LLMProvider>();
    const registry = makeImageModelRegistry([
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
    ], providerLookup);
    providerLookup.set('openai', {
      name: 'openai',
      models: ['gpt-vision'],
      async describeRuntime() {
        return {
          policy: { local: false },
        };
      },
      async chat() {
        return {
          content: '{"description":"openai selection","text":"","labels":["openai"]}',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 4 },
          stopReason: 'end',
        };
      },
    });
    providerLookup.set('lm-studio', {
      name: 'lm-studio',
      models: ['local-vision'],
      async describeRuntime() {
        return {
          policy: { local: true },
        };
      },
      async chat() {
        return {
          content: '{"description":"local selection","text":"","labels":["local"]}',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 4 },
          stopReason: 'end',
        };
      },
    });

    const openaiProvider = createOpenAIImageUnderstandingProvider(registry, store);
    const openaiResult = await openaiProvider.analyze!({
      artifact: { artifactId: created.id, mimeType: 'image/png', metadata: {} },
    });
    expect(openaiResult.metadata.llmProviderId).toBe('openai');
    expect(openaiResult.labels).toEqual(['openai']);

    const localProvider = createLocalImageUnderstandingProvider(registry, store);
    const localResult = await localProvider.analyze!({
      artifact: { artifactId: created.id, mimeType: 'image/png', metadata: {} },
    });
    expect(localResult.metadata.llmProviderId).toBe('lm-studio');
    expect(localResult.labels).toEqual(['local']);
  });
});
