import type {
  VoiceDescriptor,
  VoiceProvider,
  VoiceRealtimeSession,
  VoiceRealtimeSessionRequest,
} from '../types.ts';
import {
  asFiniteNumber,
  asRecord,
  buildStatus,
  estimateConfidenceFromAvgLogprob,
  inferFilename,
  mimeTypeForVoiceFormat,
  normalizeBaseUrl,
  readFirstEnv,
  resolveAudioInput,
  trimToUndefined,
} from './shared.ts';

const OPENAI_AUDIO_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;
const DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_OPENAI_REALTIME_MODEL = 'gpt-realtime';
const DEFAULT_OPENAI_VOICE = 'coral';
const DEFAULT_OPENAI_REALTIME_TTL_SECONDS = 600;

type OpenAITranscriptionVerboseSegment = {
  readonly text?: string;
  readonly start?: number;
  readonly end?: number;
  readonly avg_logprob?: number;
};

type OpenAITranscriptionVerboseResponse = {
  readonly text?: string;
  readonly language?: string;
  readonly segments?: readonly OpenAITranscriptionVerboseSegment[];
};

type OpenAIRealtimeClientSecretResponse = {
  readonly client_secret?: {
    readonly value?: string;
    readonly expires_at?: number;
  };
  readonly id?: string;
  readonly model?: string;
};

function resolveOpenAISpeechFormat(format: string | undefined): string {
  const normalized = format?.trim().toLowerCase();
  switch (normalized) {
    case 'wav':
    case 'aac':
    case 'flac':
    case 'mp3':
      return normalized;
    case 'ogg':
    case 'opus':
    case 'webm':
      return 'opus';
    case 'pcm16':
    case 'pcm':
      return 'pcm';
    default:
      return 'mp3';
  }
}

function resolveOpenAIRealtimeAudioFormat(
  format: string | undefined,
): { type: 'audio/pcm'; rate: 24000 } | { type: 'audio/pcmu' } | { type: 'audio/pcma' } {
  const normalized = format?.trim().toLowerCase();
  if (normalized === 'pcmu' || normalized === 'g711_ulaw') {
    return { type: 'audio/pcmu' };
  }
  if (normalized === 'pcma' || normalized === 'g711_alaw') {
    return { type: 'audio/pcma' };
  }
  return { type: 'audio/pcm', rate: 24000 };
}

function buildOpenAIRealtimeMetadata(params: {
  baseUrl: string;
  model: string;
  clientSecret: string;
  expiresAt?: number;
  request: VoiceRealtimeSessionRequest;
  sessionPayload: Record<string, unknown>;
}): Record<string, unknown> {
  const trimmedBase = params.baseUrl.replace(/\/+$/, '');
  const httpUrl = `${trimmedBase}/realtime?model=${encodeURIComponent(params.model)}`;
  const websocketBase = trimmedBase.replace(/^http/i, 'ws');
  const wsUrl = `${websocketBase}/realtime?model=${encodeURIComponent(params.model)}`;
  return {
    authMode: 'ephemeral-client-secret',
    clientSecret: params.clientSecret,
    expiresAt: params.expiresAt,
    connect: {
      webrtc: {
        url: httpUrl,
        method: 'POST',
        contentType: 'application/sdp',
        authorization: 'Bearer <client_secret>',
      },
      websocket: {
        url: wsUrl,
        headers: {
          Authorization: `Bearer ${params.clientSecret}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      },
    },
    request: {
      modelId: params.request.modelId,
      voiceId: params.request.voiceId,
      inputFormat: params.request.inputFormat,
      outputFormat: params.request.outputFormat,
    },
    session: params.sessionPayload,
  };
}

export function createOpenAIProvider(): VoiceProvider {
  const envVars = ['OPENAI_API_KEY', 'OPENAI_KEY'] as const;
  const baseUrlEnvVars = ['OPENAI_BASE_URL', 'OPENAI_API_BASE'] as const;
  return {
    id: 'openai',
    label: 'OpenAI',
    capabilities: ['tts', 'stt', 'realtime', 'voice-list'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus(
        'openai',
        'OpenAI',
        ['tts', 'stt', 'realtime', 'voice-list'],
        configured,
        configured
          ? 'OpenAI audio and realtime APIs are available.'
          : 'Set OPENAI_API_KEY or OPENAI_KEY to enable OpenAI TTS, STT, and realtime voice.',
        {
          baseUrl: normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), OPENAI_AUDIO_BASE_URL),
          defaultTtsModel: DEFAULT_OPENAI_TTS_MODEL,
          defaultSttModel: DEFAULT_OPENAI_STT_MODEL,
          defaultRealtimeModel: DEFAULT_OPENAI_REALTIME_MODEL,
        },
      );
    },
    async listVoices(): Promise<readonly VoiceDescriptor[]> {
      return OPENAI_VOICES.map((voice) => ({
        id: voice,
        label: voice,
        metadata: {
          builtin: true,
        },
      }));
    },
    async synthesize(request) {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('OpenAI API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), OPENAI_AUDIO_BASE_URL);
      const responseFormat = resolveOpenAISpeechFormat(request.format);
      const metadata = asRecord(request.metadata);
      const response = await fetch(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/octet-stream',
        },
        body: JSON.stringify({
          input: request.text,
          model: request.modelId?.trim() || DEFAULT_OPENAI_TTS_MODEL,
          voice: request.voiceId?.trim() || DEFAULT_OPENAI_VOICE,
          response_format: responseFormat,
          ...(typeof request.speed === 'number' && Number.isFinite(request.speed)
            ? { speed: request.speed }
            : {}),
          ...(trimToUndefined(metadata?.['instructions'])
            ? { instructions: trimToUndefined(metadata?.['instructions']) }
            : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI synthesis failed: HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        providerId: 'openai',
        audio: {
          mimeType: mimeTypeForVoiceFormat(responseFormat),
          format: responseFormat === 'pcm' ? 'pcm16' : responseFormat,
          dataBase64: buffer.toString('base64'),
          metadata: {
            baseUrl,
            modelId: request.modelId?.trim() || DEFAULT_OPENAI_TTS_MODEL,
            voiceId: request.voiceId?.trim() || DEFAULT_OPENAI_VOICE,
          },
        },
        metadata: {
          baseUrl,
          modelId: request.modelId?.trim() || DEFAULT_OPENAI_TTS_MODEL,
          voiceId: request.voiceId?.trim() || DEFAULT_OPENAI_VOICE,
        },
      };
    },
    async transcribe(request) {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('OpenAI API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), OPENAI_AUDIO_BASE_URL);
      const { buffer, mimeType } = await resolveAudioInput(request.audio);
      const form = new FormData();
      form.append(
        'file',
        new Blob([Buffer.from(buffer)], { type: mimeType || 'application/octet-stream' }),
        inferFilename(request.audio, '.wav'),
      );
      form.append('model', request.modelId?.trim() || DEFAULT_OPENAI_STT_MODEL);
      form.append('response_format', 'verbose_json');
      if (request.language?.trim()) form.append('language', request.language.trim());
      if (request.prompt?.trim()) form.append('prompt', request.prompt.trim());

      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
      });
      if (!response.ok) {
        throw new Error(`OpenAI transcription failed: HTTP ${response.status}`);
      }
      const payload = await response.json() as OpenAITranscriptionVerboseResponse;
      const text = payload.text?.trim();
      if (!text) throw new Error('OpenAI transcription response missing transcript');
      return {
        providerId: 'openai',
        text,
        language: payload.language?.trim() || request.language,
        segments: (payload.segments ?? [])
          .map((segment) => ({
            text: segment.text?.trim() ?? '',
            startMs: typeof segment.start === 'number' ? Math.round(segment.start * 1000) : undefined,
            endMs: typeof segment.end === 'number' ? Math.round(segment.end * 1000) : undefined,
            confidence: estimateConfidenceFromAvgLogprob(segment.avg_logprob),
          }))
          .filter((segment) => segment.text.length > 0),
        metadata: {
          baseUrl,
          modelId: request.modelId?.trim() || DEFAULT_OPENAI_STT_MODEL,
        },
      };
    },
    async openRealtimeSession(request): Promise<VoiceRealtimeSession> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('OpenAI API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), OPENAI_AUDIO_BASE_URL);
      const metadata = asRecord(request.metadata);
      const model = request.modelId?.trim() || DEFAULT_OPENAI_REALTIME_MODEL;
      const ttlSeconds = Math.max(
        10,
        Math.min(
          7200,
          Math.round(asFiniteNumber(metadata?.['ttlSeconds']) ?? DEFAULT_OPENAI_REALTIME_TTL_SECONDS),
        ),
      );
      const voice = request.voiceId?.trim() || DEFAULT_OPENAI_VOICE;
      const inputFormat = resolveOpenAIRealtimeAudioFormat(request.inputFormat);
      const outputFormat = resolveOpenAIRealtimeAudioFormat(request.outputFormat);
      const response = await fetch(`${baseUrl}/realtime/client_secrets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expires_after: {
            anchor: 'created_at',
            seconds: ttlSeconds,
          },
          session: {
            type: 'realtime',
            model,
            instructions: request.instructions?.trim() || undefined,
            output_modalities: ['audio'],
            audio: {
              input: {
                format: inputFormat,
                transcription: {
                  model: trimToUndefined(metadata?.['transcriptionModel']) || DEFAULT_OPENAI_STT_MODEL,
                  ...(trimToUndefined(metadata?.['transcriptionLanguage'])
                    ? { language: trimToUndefined(metadata?.['transcriptionLanguage']) }
                    : {}),
                  ...(trimToUndefined(metadata?.['transcriptionPrompt'])
                    ? { prompt: trimToUndefined(metadata?.['transcriptionPrompt']) }
                    : {}),
                },
              },
              output: {
                format: outputFormat,
                voice,
                ...(typeof metadata?.['speed'] === 'number' && Number.isFinite(metadata['speed'])
                  ? { speed: metadata['speed'] }
                  : {}),
              },
            },
            ...(metadata?.['includeLogprobs'] === true
              ? { include: ['item.input_audio_transcription.logprobs'] }
              : {}),
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI realtime session failed: HTTP ${response.status}`);
      }
      const payload = await response.json() as OpenAIRealtimeClientSecretResponse & Record<string, unknown>;
      const clientSecret = payload.client_secret?.value?.trim();
      if (!clientSecret) throw new Error('OpenAI realtime session response missing client secret');
      const expiresAt = typeof payload.client_secret?.expires_at === 'number'
        ? payload.client_secret.expires_at * 1000
        : undefined;
      return {
        providerId: 'openai',
        sessionId: trimToUndefined(payload.id) || `openai-realtime-${Date.now()}`,
        transport: 'webrtc',
        url: `${baseUrl}/realtime?model=${encodeURIComponent(model)}`,
        expiresAt,
        metadata: buildOpenAIRealtimeMetadata({
          baseUrl,
          model,
          clientSecret,
          expiresAt,
          request,
          sessionPayload: payload,
        }),
      };
    },
  };
}
