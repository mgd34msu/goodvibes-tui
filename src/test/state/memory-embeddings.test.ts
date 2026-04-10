import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MEMORY_EMBEDDING_DIMS,
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
} from '../../state/index.ts';
import { ConfigManager, _resetConfigManagerForTesting } from '../../config/index.ts';

describe('MemoryEmbeddingProviderRegistry', () => {
  let previousHome: string | undefined;
  let previousTestMode: string | undefined;
  let tempRoot = '';

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousTestMode = ConfigManager.getTestMode();
    tempRoot = mkdtempSync(join(tmpdir(), 'gv-memory-embeddings-'));
    process.env.HOME = tempRoot;
    ConfigManager.setTestMode(join(tempRoot, '.goodvibes', 'tui'));
    _resetConfigManagerForTesting();
  });

  afterEach(() => {
    _resetConfigManagerForTesting();
    ConfigManager.setTestMode(previousTestMode);
    MemoryEmbeddingProviderRegistry.resetActiveForTesting();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  test('keeps hashed local embeddings as the default sqlite-vec-compatible provider', async () => {
    const registry = new MemoryEmbeddingProviderRegistry();
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
    const registry = new MemoryEmbeddingProviderRegistry();
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
