import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ArtifactStore } from '../../artifacts/index.ts';
import { ensureBuiltinMediaProviders, MediaProviderRegistry } from '../../media/index.ts';
import type { ProviderRegistry } from '../../providers/registry.ts';
import type { ProviderRuntimeMetadata } from '../../providers/interface.ts';

const BUILTIN_MEDIA_ENV_KEYS = [
  'BYTEPLUS_API_KEY',
  'RUNWAYML_API_SECRET',
  'RUNWAY_API_KEY',
  'MODELSTUDIO_API_KEY',
  'DASHSCOPE_API_KEY',
  'QWEN_API_KEY',
  'FAL_KEY',
  'FAL_API_KEY',
  'COMFY_API_KEY',
  'COMFY_BASE_URL',
] as const;

function makeImageModelRegistry(): Pick<ProviderRegistry, 'describeRuntime' | 'getCurrentModel' | 'getForModel' | 'listModels'> {
  return {
    listModels: () => [],
    describeRuntime: async (): Promise<ProviderRuntimeMetadata> => ({
      policy: { local: false },
    }),
    getCurrentModel: () => ({
      id: 'stub-model',
      provider: 'stub',
      registryKey: 'stub:stub-model',
      displayName: 'Stub Model',
      description: 'Stub multimodal model',
      capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: true },
      contextWindow: 8_192,
      selectable: true,
    }),
    getForModel: () => {
      throw new Error('Stub registry does not resolve models');
    },
  };
}

describe('builtin media generation providers', () => {
  const originalEnv = new Map<string, string | undefined>();
  const artifactStore: Pick<ArtifactStore, 'readContent'> = {
    async readContent() {
      throw new Error('artifact reads are not used in this suite');
    },
  };

  beforeEach(() => {
        for (const key of BUILTIN_MEDIA_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
        for (const key of BUILTIN_MEDIA_ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  test('registers builtin image-understanding and generation providers together', async () => {
    const registry = new MediaProviderRegistry();
    ensureBuiltinMediaProviders(registry, artifactStore, makeImageModelRegistry());

    const ids = new Set(registry.list().map((provider) => provider.id));
    expect(ids.has('builtin:image-understanding')).toBe(true);
    expect(ids.has('byteplus')).toBe(true);
    expect(ids.has('runway')).toBe(true);
    expect(ids.has('alibaba')).toBe(true);
    expect(ids.has('fal')).toBe(true);
    expect(ids.has('comfy')).toBe(true);

    const generator = registry.findProvider('generate');
    expect(generator).not.toBeNull();
    expect(generator?.capabilities.includes('generate')).toBe(true);
  });

  test('surfaces configured generation providers from environment state', async () => {
    process.env['BYTEPLUS_API_KEY'] = 'byteplus-key';
    process.env['RUNWAY_API_KEY'] = 'runway-key';
    process.env['MODELSTUDIO_API_KEY'] = 'alibaba-key';
    process.env['FAL_KEY'] = 'fal-key';
    process.env['COMFY_BASE_URL'] = 'http://127.0.0.1:8188';

    const registry = new MediaProviderRegistry();
    ensureBuiltinMediaProviders(registry, artifactStore, makeImageModelRegistry());
    const statuses = await registry.status();

    expect(statuses.find((entry) => entry.id === 'byteplus')?.configured).toBe(true);
    expect(statuses.find((entry) => entry.id === 'runway')?.configured).toBe(true);
    expect(statuses.find((entry) => entry.id === 'alibaba')?.configured).toBe(true);
    expect(statuses.find((entry) => entry.id === 'fal')?.configured).toBe(true);
    expect(statuses.find((entry) => entry.id === 'comfy')?.configured).toBe(true);
  });
});
