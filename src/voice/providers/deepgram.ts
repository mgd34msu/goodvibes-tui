import type { VoiceProvider } from '../types.ts';
import {
  buildStatus,
  normalizeBaseUrl,
  readFirstEnv,
  resolveAudioInput,
} from './shared.ts';

type DeepgramTranscriptionResponse = {
  readonly results?: {
    readonly channels?: ReadonlyArray<{
      readonly alternatives?: ReadonlyArray<{
        readonly transcript?: string;
      }>;
    }>;
  };
};

export function createDeepgramProvider(): VoiceProvider {
  const envVars = ['DEEPGRAM_API_KEY'] as const;
  const baseUrlEnvVars = ['DEEPGRAM_BASE_URL', 'DEEPGRAM_API_BASE'] as const;
  return {
    id: 'deepgram',
    label: 'Deepgram',
    capabilities: ['stt'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus(
        'deepgram',
        'Deepgram',
        ['stt'],
        configured,
        configured
          ? 'Deepgram transcription API key available.'
          : 'Set DEEPGRAM_API_KEY to enable Deepgram transcription.',
        {
          baseUrl: normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.deepgram.com/v1'),
        },
      );
    },
    async transcribe(request) {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('Deepgram API key missing');
      const { buffer, mimeType } = await resolveAudioInput(request.audio);
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.deepgram.com/v1');
      const url = new URL(`${baseUrl}/listen`);
      url.searchParams.set('model', request.modelId?.trim() || 'nova-3');
      if (request.language?.trim()) url.searchParams.set('language', request.language.trim());
      url.searchParams.set('smart_format', 'true');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': mimeType || 'application/octet-stream',
        },
        body: Buffer.from(buffer),
      });
      if (!response.ok) {
        throw new Error(`Deepgram transcription failed: HTTP ${response.status}`);
      }
      const payload = await response.json() as DeepgramTranscriptionResponse;
      const text = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
      if (!text) throw new Error('Deepgram transcription response missing transcript');
      return {
        providerId: 'deepgram',
        text,
        language: request.language,
        metadata: {
          baseUrl,
          modelId: request.modelId?.trim() || 'nova-3',
        },
      };
    },
  };
}
