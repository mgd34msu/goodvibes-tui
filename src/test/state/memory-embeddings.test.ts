import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_MEMORY_EMBEDDING_DIMS,
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
} from '../../state/index.ts';

describe('MemoryEmbeddingProviderRegistry', () => {
  afterEach(() => {
    MemoryEmbeddingProviderRegistry.resetActiveForTesting();
  });

  test('keeps hashed local embeddings as the default sqlite-vec-compatible provider', async () => {
    const registry = new MemoryEmbeddingProviderRegistry();
    const doctor = await registry.doctor();

    expect(doctor.activeProviderId).toBe(HASHED_MEMORY_EMBEDDING_PROVIDER.id);
    expect(doctor.syncProviders).toContain(HASHED_MEMORY_EMBEDDING_PROVIDER.id);
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
