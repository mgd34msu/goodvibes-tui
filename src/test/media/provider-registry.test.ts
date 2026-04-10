import { describe, expect, test } from 'bun:test';
import { MediaProviderRegistry } from '../../media/index.ts';

describe('MediaProviderRegistry', () => {
  test('registers media providers and dispatches capability lookups', async () => {
    const registry = new MediaProviderRegistry();
    registry.register({
      id: 'media-test',
      label: 'Media Test',
      capabilities: ['understand'],
      async analyze(request) {
        return {
          providerId: 'media-test',
          description: `saw ${request.artifact.mimeType}`,
          metadata: {},
        };
      },
    });

    expect(registry.list().map((entry) => entry.id)).toEqual(['media-test']);
    const provider = registry.findProvider('understand');
    expect(provider?.id).toBe('media-test');
    await expect(provider!.analyze!({
      artifact: { mimeType: 'image/png', dataBase64: 'x', metadata: {} },
    })).resolves.toEqual({
      providerId: 'media-test',
      description: 'saw image/png',
      metadata: {},
    });
  });
});
