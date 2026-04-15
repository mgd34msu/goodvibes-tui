import { describe, expect, test } from 'bun:test';
import { VoiceProviderRegistry, VoiceService } from '@pellux/goodvibes-sdk/platform/voice/index';

describe('VoiceProviderRegistry and VoiceService', () => {
  test('registers TS-only TTS providers and routes synthesis', async () => {
    const registry = new VoiceProviderRegistry();
    const service = new VoiceService(registry);

    registry.register({
      id: 'voice-test',
      label: 'Voice Test',
      capabilities: ['tts'],
      async synthesize(request) {
        return {
          providerId: 'voice-test',
          audio: {
            mimeType: 'audio/wav',
            format: 'wav',
            dataBase64: Buffer.from(request.text).toString('base64'),
            metadata: {},
          },
          metadata: {},
        };
      },
    });

    const status = await service.getStatus(true);
    expect(status.providerCount).toBe(1);
    const result = await service.synthesize(undefined, { text: 'hello' });
    expect(result.providerId).toBe('voice-test');
    expect(result.audio.dataBase64).toBe(Buffer.from('hello').toString('base64'));
  });
});
