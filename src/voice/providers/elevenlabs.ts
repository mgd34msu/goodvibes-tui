import type {
  VoiceDescriptor,
  VoiceProvider,
  VoiceRealtimeSession,
  VoiceRealtimeSessionRequest,
} from '../types.ts';
import {
  asRecord,
  buildStatus,
  estimateConfidenceFromAvgLogprob,
  inferFilename,
  normalizeBaseUrl,
  readFirstEnv,
  resolveAudioInput,
  trimToUndefined,
} from './shared.ts';

const DEFAULT_ELEVENLABS_STT_MODEL = 'scribe_v2';
const DEFAULT_ELEVENLABS_REALTIME_MODEL = 'scribe_v2_realtime';
const ELEVENLABS_SINGLE_USE_TOKEN_TTL_MS = 15 * 60 * 1000;

type ElevenLabsWord = {
  readonly text?: string;
  readonly start?: number;
  readonly end?: number;
  readonly type?: string;
  readonly speaker_id?: string;
  readonly logprob?: number;
};

type ElevenLabsTranscriptionResponse = {
  readonly language_code?: string;
  readonly language_probability?: number;
  readonly text?: string;
  readonly words?: readonly ElevenLabsWord[];
  readonly transcription_id?: string;
};

type ElevenLabsSingleUseTokenResponse = {
  readonly token?: string;
};

function normalizeBooleanString(value: unknown): string | undefined {
  return typeof value === 'boolean' ? String(value) : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return values.length > 0 ? values : undefined;
}

function parseElevenLabsTranscript(payload: ElevenLabsTranscriptionResponse): {
  text: string;
  language?: string;
  segments: Array<{ text: string; startMs?: number; endMs?: number; confidence?: number }>;
} {
  const text = trimToUndefined(payload.text);
  if (!text) throw new Error('ElevenLabs transcription response missing transcript');
  const segments = (payload.words ?? [])
    .filter((word) => (word.type?.trim() || 'word') === 'word')
    .map((word) => ({
      text: word.text?.trim() ?? '',
      startMs: typeof word.start === 'number' ? Math.round(word.start * 1000) : undefined,
      endMs: typeof word.end === 'number' ? Math.round(word.end * 1000) : undefined,
      confidence: estimateConfidenceFromAvgLogprob(word.logprob),
    }))
    .filter((segment) => segment.text.length > 0);
  return {
    text,
    language: trimToUndefined(payload.language_code),
    segments,
  };
}

function buildElevenLabsRealtimeMetadata(params: {
  baseUrl: string;
  websocketUrl: string;
  token?: string;
  expiresAt?: number;
  request: VoiceRealtimeSessionRequest;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    authMode: params.token ? 'single-use-token' : 'api-key',
    ...(params.token ? { token: params.token } : {}),
    expiresAt: params.expiresAt,
    connect: {
      websocket: {
        url: params.websocketUrl,
        ...(params.token ? {} : { headers: { 'xi-api-key': '<server-managed>' } }),
      },
    },
    request: {
      modelId: params.request.modelId,
      voiceId: params.request.voiceId,
      inputFormat: params.request.inputFormat,
      outputFormat: params.request.outputFormat,
      instructions: params.request.instructions,
      metadata: params.metadata ?? {},
    },
  };
}

export function createElevenLabsProvider(): VoiceProvider {
  const envVars = ['ELEVENLABS_API_KEY', 'XI_API_KEY'] as const;
  const baseUrlEnvVars = ['ELEVENLABS_BASE_URL', 'XI_API_BASE'] as const;
  return {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    capabilities: ['tts', 'stt', 'realtime', 'voice-list'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus(
        'elevenlabs',
        'ElevenLabs',
        ['tts', 'stt', 'realtime', 'voice-list'],
        configured,
        configured
          ? 'ElevenLabs speech, transcription, and realtime APIs are available.'
          : 'Set ELEVENLABS_API_KEY or XI_API_KEY to enable ElevenLabs speech and transcription.',
        {
          baseUrl: normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io'),
          defaultSttModel: DEFAULT_ELEVENLABS_STT_MODEL,
          defaultRealtimeModel: DEFAULT_ELEVENLABS_REALTIME_MODEL,
        },
      );
    },
    async listVoices(): Promise<readonly VoiceDescriptor[]> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) return [];
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io');
      const response = await fetch(`${baseUrl}/v1/voices`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (!response.ok) throw new Error(`ElevenLabs voices failed: HTTP ${response.status}`);
      const payload = await response.json() as {
        voices?: Array<{ voice_id?: string; name?: string; category?: string; description?: string }>;
      };
      return (payload.voices ?? [])
        .map((voice) => ({
          id: voice.voice_id?.trim() ?? '',
          label: voice.name?.trim() || voice.voice_id?.trim() || 'Voice',
          metadata: {
            category: voice.category?.trim(),
            description: voice.description?.trim(),
          },
        }))
        .filter((voice) => voice.id.length > 0);
    },
    async synthesize(request) {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('ElevenLabs API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io');
      const voiceId = request.voiceId?.trim() || 'pMsXgVXv3BLzUgSXRplE';
      const response = await fetch(`${baseUrl}/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: request.text,
          model_id: request.modelId?.trim() || 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0,
            use_speaker_boost: true,
            speed: request.speed ?? 1,
          },
        }),
      });
      if (!response.ok) throw new Error(`ElevenLabs synthesis failed: HTTP ${response.status}`);
      const mimeType = response.headers.get('content-type')?.trim() || 'audio/mpeg';
      const dataBase64 = Buffer.from(await response.arrayBuffer()).toString('base64');
      return {
        providerId: 'elevenlabs',
        audio: {
          mimeType,
          format: mimeType.includes('wav') ? 'wav' : 'mp3',
          dataBase64,
          metadata: { voiceId, baseUrl },
        },
        metadata: { voiceId, baseUrl },
      };
    },
    async transcribe(request) {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('ElevenLabs API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io');
      const metadata = asRecord(request.metadata);
      const url = new URL(`${baseUrl}/v1/speech-to-text`);
      if (metadata?.['enableLogging'] === false) {
        url.searchParams.set('enable_logging', 'false');
      }
      const form = new FormData();
      form.append('model_id', request.modelId?.trim() || DEFAULT_ELEVENLABS_STT_MODEL);
      if (request.language?.trim()) form.append('language_code', request.language.trim());
      const uri = trimToUndefined(request.audio.uri);
      const canUseSourceUrl = !request.audio.dataBase64 && uri && /^https?:\/\//i.test(uri);
      if (canUseSourceUrl) {
        form.append('source_url', uri);
      } else {
        const { buffer, mimeType } = await resolveAudioInput(request.audio);
        form.append(
          'file',
          new Blob([Buffer.from(buffer)], { type: mimeType || 'application/octet-stream' }),
          inferFilename(request.audio, '.wav'),
        );
        form.append('file_format', request.audio.format === 'pcm16' ? 'pcm_s16le_16' : 'other');
      }
      if (metadata?.['tagAudioEvents'] !== undefined) {
        const value = normalizeBooleanString(metadata['tagAudioEvents']);
        if (value) form.append('tag_audio_events', value);
      }
      if (metadata?.['diarize'] !== undefined) {
        const value = normalizeBooleanString(metadata['diarize']);
        if (value) form.append('diarize', value);
      }
      if (
        typeof metadata?.['diarizationThreshold'] === 'number'
        && Number.isFinite(metadata['diarizationThreshold'])
      ) {
        form.append('diarization_threshold', String(metadata['diarizationThreshold']));
      }
      if (
        typeof metadata?.['numSpeakers'] === 'number'
        && Number.isFinite(metadata['numSpeakers'])
      ) {
        form.append('num_speakers', String(Math.round(metadata['numSpeakers'])));
      }
      if (
        typeof metadata?.['temperature'] === 'number'
        && Number.isFinite(metadata['temperature'])
      ) {
        form.append('temperature', String(metadata['temperature']));
      }
      if (typeof metadata?.['seed'] === 'number' && Number.isFinite(metadata['seed'])) {
        form.append('seed', String(Math.round(metadata['seed'])));
      }
      if (metadata?.['useMultiChannel'] !== undefined) {
        const value = normalizeBooleanString(metadata['useMultiChannel']);
        if (value) form.append('use_multi_channel', value);
      }
      if (metadata?.['noVerbatim'] !== undefined) {
        const value = normalizeBooleanString(metadata['noVerbatim']);
        if (value) form.append('no_verbatim', value);
      }
      const timestampsGranularity = trimToUndefined(metadata?.['timestampsGranularity']);
      if (timestampsGranularity && ['none', 'word', 'character'].includes(timestampsGranularity)) {
        form.append('timestamps_granularity', timestampsGranularity);
      }
      const keyterms = asStringArray(metadata?.['keyterms']);
      for (const keyterm of keyterms ?? []) form.append('keyterms', keyterm);
      const entityDetection = metadata?.['entityDetection'];
      if (typeof entityDetection === 'string' && entityDetection.trim()) {
        form.append('entity_detection', entityDetection.trim());
      } else {
        for (const entry of asStringArray(entityDetection) ?? []) {
          form.append('entity_detection', entry);
        }
      }
      const entityRedaction = metadata?.['entityRedaction'];
      if (typeof entityRedaction === 'string' && entityRedaction.trim()) {
        form.append('entity_redaction', entityRedaction.trim());
      } else {
        for (const entry of asStringArray(entityRedaction) ?? []) {
          form.append('entity_redaction', entry);
        }
      }
      const entityRedactionMode = trimToUndefined(metadata?.['entityRedactionMode']);
      if (entityRedactionMode) form.append('entity_redaction_mode', entityRedactionMode);
      if (metadata?.['webhookMetadata'] !== undefined) {
        form.append('webhook_metadata', JSON.stringify(metadata['webhookMetadata']));
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
        },
        body: form,
      });
      if (!response.ok) throw new Error(`ElevenLabs transcription failed: HTTP ${response.status}`);
      const payload = await response.json() as ElevenLabsTranscriptionResponse;
      const parsed = parseElevenLabsTranscript(payload);
      return {
        providerId: 'elevenlabs',
        text: parsed.text,
        language: parsed.language || request.language,
        segments: parsed.segments,
        metadata: {
          baseUrl,
          modelId: request.modelId?.trim() || DEFAULT_ELEVENLABS_STT_MODEL,
          transcriptionId: trimToUndefined(payload.transcription_id),
          sourceMode: canUseSourceUrl ? 'source_url' : 'file',
        },
      };
    },
    async openRealtimeSession(request): Promise<VoiceRealtimeSession> {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('ElevenLabs API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), 'https://api.elevenlabs.io');
      const metadata = asRecord(request.metadata);
      const model = request.modelId?.trim() || DEFAULT_ELEVENLABS_REALTIME_MODEL;
      const websocketBase = baseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
      const websocketUrl = new URL(`${websocketBase}/v1/speech-to-text/realtime`);
      websocketUrl.searchParams.set('model_id', model);
      if (metadata?.['includeTimestamps'] !== undefined) {
        const value = normalizeBooleanString(metadata['includeTimestamps']);
        if (value) websocketUrl.searchParams.set('include_timestamps', value);
      }
      if (metadata?.['includeLanguageDetection'] !== undefined) {
        const value = normalizeBooleanString(metadata['includeLanguageDetection']);
        if (value) websocketUrl.searchParams.set('include_language_detection', value);
      }
      const audioFormat = trimToUndefined(metadata?.['audioFormat'])
        || (request.inputFormat === 'pcm16' ? 'pcm_16000' : undefined);
      if (audioFormat) websocketUrl.searchParams.set('audio_format', audioFormat);
      const languageCode = trimToUndefined(metadata?.['languageCode']);
      if (languageCode) websocketUrl.searchParams.set('language_code', languageCode);
      const commitStrategy = trimToUndefined(metadata?.['commitStrategy']);
      if (commitStrategy && ['manual', 'vad'].includes(commitStrategy)) {
        websocketUrl.searchParams.set('commit_strategy', commitStrategy);
      }
      if (
        typeof metadata?.['vadSilenceThresholdSecs'] === 'number'
        && Number.isFinite(metadata['vadSilenceThresholdSecs'])
      ) {
        websocketUrl.searchParams.set(
          'vad_silence_threshold_secs',
          String(metadata['vadSilenceThresholdSecs']),
        );
      }
      if (
        typeof metadata?.['vadThreshold'] === 'number'
        && Number.isFinite(metadata['vadThreshold'])
      ) {
        websocketUrl.searchParams.set('vad_threshold', String(metadata['vadThreshold']));
      }
      if (
        typeof metadata?.['minSpeechDurationMs'] === 'number'
        && Number.isFinite(metadata['minSpeechDurationMs'])
      ) {
        websocketUrl.searchParams.set(
          'min_speech_duration_ms',
          String(Math.round(metadata['minSpeechDurationMs'])),
        );
      }
      if (
        typeof metadata?.['minSilenceDurationMs'] === 'number'
        && Number.isFinite(metadata['minSilenceDurationMs'])
      ) {
        websocketUrl.searchParams.set(
          'min_silence_duration_ms',
          String(Math.round(metadata['minSilenceDurationMs'])),
        );
      }
      if (metadata?.['enableLogging'] !== undefined) {
        const value = normalizeBooleanString(metadata['enableLogging']);
        if (value) websocketUrl.searchParams.set('enable_logging', value);
      }
      const tokenResponse = await fetch(`${baseUrl}/v1/single-use-token/realtime_scribe`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
        },
      });
      if (!tokenResponse.ok) {
        throw new Error(`ElevenLabs realtime token failed: HTTP ${tokenResponse.status}`);
      }
      const tokenPayload = await tokenResponse.json() as ElevenLabsSingleUseTokenResponse;
      const token = trimToUndefined(tokenPayload.token);
      if (!token) throw new Error('ElevenLabs realtime token response missing token');
      websocketUrl.searchParams.set('token', token);
      const expiresAt = Date.now() + ELEVENLABS_SINGLE_USE_TOKEN_TTL_MS;
      return {
        providerId: 'elevenlabs',
        sessionId: `elevenlabs-realtime-${Date.now()}`,
        transport: 'websocket',
        url: websocketUrl.toString(),
        expiresAt,
        metadata: buildElevenLabsRealtimeMetadata({
          baseUrl,
          websocketUrl: websocketUrl.toString(),
          token,
          expiresAt,
          request,
          metadata,
        }),
      };
    },
  };
}
