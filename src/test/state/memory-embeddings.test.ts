import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MEMORY_EMBEDDING_DIMS,
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
} from '@pellux/goodvibes-sdk/platform/state/index';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';

describe('MemoryEmbeddingProviderRegistry', () => {
  let previousHome: string | undefined;
  let configManager: ConfigManager;
  let tempRoot = '';

  beforeEach(() => {
    previousHome = process.env.HOME;
    tempRoot = mkdtempSync(join(tmpdir(), 'gv-memory-embeddings-'));
    process.env.HOME = tempRoot;
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(tempRoot, '.goodvibes', 'tui') });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  test('keeps hashed local embeddings as the default sqlite-vec-compatible provider', async () => {
    const registry = new MemoryEmbeddingProviderRegistry({ configManager });
    const doctor = await registry.doctor();
    const providerIds = registry.list().map((provider) => provider.id);

    expect(doctor.activeProviderId).toBe(HASHED_MEMORY_EMBEDDING_PROVIDER.id);
    expect(doctor.syncProviders).toContain(HASHED_MEMORY_EMBEDDING_PROVIDER.id);
    expect(doctor.asyncProviders).toEqual(expect.arrayContaining([
      'openai',
      'openai-compatible',
      'gemini',
      'mistral',
      'ollama',
    ]));
    expect(providerIds).toEqual(expect.arrayContaining([
      'hashed-local',
      'openai',
      'openai-compatible',
      'gemini',
      'mistral',
      'ollama',
    ]));
    const embedded = registry.embedSync({
      text: 'runtime automation memory',
      dimensions: DEFAULT_MEMORY_EMBEDDING_DIMS,
      usage: 'query',
    });
    expect(embedded.vector.length).toBe(DEFAULT_MEMORY_EMBEDDING_DIMS);
  });

  test('can register custom providers and switch the active provider', async () => {
    const registry = new MemoryEmbeddingProviderRegistry({ configManager });
    registry.register({
      id: 'test-sync',
      label: 'Test Sync',
      dimensions: DEFAULT_MEMORY_EMBEDDING_DIMS,
      embedSync(request) {
        return {
          vector: new Float32Array(request.dimensions).fill(1),
          dimensions: request.dimensions,
        };
      },
    }, { makeDefault: true });

    const doctor = await registry.doctor();
    expect(doctor.activeProviderId).toBe('test-sync');
    expect(doctor.syncProviders).toContain('test-sync');
  });
});
