import type { VoiceDescriptor, VoiceProvider } from '../types.ts';
import {
  buildStatus,
  normalizeBaseUrl,
  readFirstEnv,
} from './shared.ts';

export function createVydraProvider(): VoiceProvider {
  const envVars = ['VYDRA_API_KEY'] as const;
  const baseUrlEnvVars = ['VYDRA_BASE_URL'] as const;
  return {
    id: 'vydra',
    label: 'Vydra',
    capabilities: ['tts', 'voice-list'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus(
        'vydra',
        'Vydra',
        ['tts', 'voice-list'],
        configured,
        configured
          ? 'Vydra speech API key available.'
          : 'Set VYDRA_API_KEY to enable Vydra speech synthesis.',
        {
          baseUrl: normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://www.vydra.ai/api/v1'),
        },
      );
    },
    async listVoices(): Promise<readonly VoiceDescriptor[]> {
      return [{
        id: '21m00Tcm4TlvDq8ikWAM',
        label: 'Rachel',
        metadata: {},
      }];
    },
    async synthesize(request) {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('Vydra API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://www.vydra.ai/api/v1');
      const model = request.modelId?.trim() || 'elevenlabs/tts';
      const response = await fetch(`${baseUrl}/models/${model}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: request.text,
          voice_id: request.voiceId?.trim() || '21m00Tcm4TlvDq8ikWAM',
        }),
      });
      if (!response.ok) throw new Error(`Vydra synthesis failed: HTTP ${response.status}`);
      const payload = await response.json() as Record<string, unknown>;
      const urls = [
        typeof payload['audio_url'] === 'string' ? payload['audio_url'] : null,
        ...(Array.isArray(payload['output'])
          ? (payload['output'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
          : []),
        ...(Array.isArray(payload['results'])
          ? (payload['results'] as Array<Record<string, unknown>>)
              .map((entry) => typeof entry['url'] === 'string' ? entry['url'] : null)
              .filter((entry): entry is string => Boolean(entry))
          : []),
      ].filter((value): value is string => Boolean(value && value.trim()));
      const audioUrl = urls[0];
      if (!audioUrl) throw new Error('Vydra speech synthesis response missing audio URL');
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) throw new Error(`Vydra audio download failed: HTTP ${audioResponse.status}`);
      const mimeType = audioResponse.headers.get('content-type')?.trim() || 'audio/mpeg';
      return {
        providerId: 'vydra',
        audio: {
          mimeType,
          format: mimeType.includes('wav') ? 'wav' : 'mp3',
          dataBase64: Buffer.from(await audioResponse.arrayBuffer()).toString('base64'),
          metadata: { sourceUrl: audioUrl, baseUrl },
        },
        metadata: { sourceUrl: audioUrl, baseUrl },
      };
    },
  };
}
