import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ensureBuiltinVoiceProviders, VoiceProviderRegistry, VoiceService } from '../../voice/index.ts';

const BUILTIN_VOICE_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_KEY',
  'OPENAI_BASE_URL',
  'DEEPGRAM_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'GEMINI_API_BASE_URL',
  'ELEVENLABS_API_KEY',
  'XI_API_KEY',
  'VYDRA_API_KEY',
] as const;

function makeJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

function makeBinaryResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      ...(init.headers ?? {}),
    },
  });
}

describe('builtin voice providers', () => {
  const originalEnv = new Map<string, string | undefined>();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    VoiceProviderRegistry.resetActiveForTesting();
    for (const key of BUILTIN_VOICE_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    VoiceProviderRegistry.resetActiveForTesting();
    for (const key of BUILTIN_VOICE_ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    globalThis.fetch = originalFetch;
  });

  test('registers builtins and exposes expected capability coverage', async () => {
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const service = new VoiceService(registry);

    const descriptors = registry.list();
    const ids = new Set(descriptors.map((provider) => provider.id));
    expect(ids.has('openai')).toBe(true);
    expect(ids.has('deepgram')).toBe(true);
    expect(ids.has('google')).toBe(true);
    expect(ids.has('elevenlabs')).toBe(true);
    expect(ids.has('microsoft')).toBe(true);
    expect(ids.has('vydra')).toBe(true);

    const statuses = await registry.status();
    expect(statuses.find((entry) => entry.id === 'microsoft')?.configured).toBe(true);
    expect(statuses.find((entry) => entry.id === 'openai')?.configured).toBe(false);
    expect(statuses.find((entry) => entry.id === 'deepgram')?.configured).toBe(false);
    expect(statuses.find((entry) => entry.id === 'google')?.configured).toBe(false);

    const serviceStatus = await service.getStatus(true);
    expect(serviceStatus.providerCount).toBe(6);
  });

  test('detects configured builtin voice providers from environment state', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test-key';
    process.env['DEEPGRAM_API_KEY'] = 'deepgram-test-key';
    process.env['GEMINI_API_KEY'] = 'gemini-test-key';
    process.env['ELEVENLABS_API_KEY'] = 'elevenlabs-test-key';
    process.env['VYDRA_API_KEY'] = 'vydra-test-key';

    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const statuses = await registry.status();

    expect(statuses.find((entry) => entry.id === 'openai')?.configured).toBe(true);
    expect(statuses.find((entry) => entry.id === 'deepgram')?.configured).toBe(true);
    expect(statuses.find((entry) => entry.id === 'google')?.configured).toBe(true);
    expect(statuses.find((entry) => entry.id === 'elevenlabs')?.configured).toBe(true);
    expect(statuses.find((entry) => entry.id === 'vydra')?.configured).toBe(true);
  });

  test('uses OpenAI as the default TTS provider and maps audio output', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test-key';
    process.env['OPENAI_BASE_URL'] = 'https://openai.example/v1';
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const service = new VoiceService(registry);

    let requestUrl = '';
    let requestHeaders: Headers | null = null;
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return makeBinaryResponse('OPENAI_TTS_BYTES', {
        headers: { 'Content-Type': 'audio/wav' },
      });
    }) as typeof globalThis.fetch;

    const result = await service.synthesize(undefined, {
      text: 'hello world',
      format: 'wav',
      metadata: { instructions: 'Speak clearly.' },
    });

    expect(result.providerId).toBe('openai');
    expect(result.audio.mimeType).toBe('audio/wav');
    expect(result.audio.format).toBe('wav');
    expect(Buffer.from(result.audio.dataBase64 ?? '', 'base64').toString()).toBe('OPENAI_TTS_BYTES');
    expect(requestUrl).toBe('https://openai.example/v1/audio/speech');
    expect(requestHeaders).not.toBeNull();
    expect(requestBody).not.toBeNull();
    const headers = requestHeaders!;
    const body = requestBody!;
    expect(headers.get('authorization')).toBe('Bearer openai-test-key');
    expect(body).toMatchObject({
      input: 'hello world',
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      response_format: 'wav',
      instructions: 'Speak clearly.',
    });
  });

  test('uses OpenAI as the default STT provider and parses verbose transcription output', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test-key';
    process.env['OPENAI_BASE_URL'] = 'https://openai.example/v1';
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const service = new VoiceService(registry);

    let requestUrl = '';
    let requestHeaders: Headers | null = null;
    let requestBody: FormData | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = init?.body as FormData;
      return makeJsonResponse({
        text: 'transcribed text',
        language: 'en',
        segments: [{ text: 'transcribed text', start: 0, end: 1.25, avg_logprob: -0.1 }],
      });
    }) as typeof globalThis.fetch;

    const result = await service.transcribe(undefined, {
      audio: {
        mimeType: 'audio/wav',
        format: 'wav',
        dataBase64: Buffer.from('VOICE_BYTES').toString('base64'),
        metadata: { filename: 'sample.wav' },
      },
      prompt: 'Transcribe exactly.',
      language: 'en',
    });

    expect(result.providerId).toBe('openai');
    expect(result.text).toBe('transcribed text');
    expect(result.language).toBe('en');
    expect(result.segments?.[0]).toMatchObject({
      text: 'transcribed text',
      startMs: 0,
      endMs: 1250,
    });
    expect((result.segments?.[0]?.confidence ?? 0)).toBeGreaterThan(0.8);
    expect(requestUrl).toBe('https://openai.example/v1/audio/transcriptions');
    expect(requestHeaders).not.toBeNull();
    expect(requestBody).not.toBeNull();
    const headers = requestHeaders!;
    const form = requestBody!;
    expect(headers.get('authorization')).toBe('Bearer openai-test-key');
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('prompt')).toBe('Transcribe exactly.');
    expect(form.get('language')).toBe('en');
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('sample.wav');
    expect(Buffer.from(await (file as File).arrayBuffer()).toString()).toBe('VOICE_BYTES');
  });

  test('opens an OpenAI realtime session with WebRTC metadata', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test-key';
    process.env['OPENAI_BASE_URL'] = 'https://openai.example/v1';
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const service = new VoiceService(registry);

    let requestUrl = '';
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return makeJsonResponse({
        id: 'rt_123',
        model: 'gpt-realtime',
        client_secret: {
          value: 'ephemeral-secret',
          expires_at: 1_700_000_000,
        },
      });
    }) as typeof globalThis.fetch;

    const result = await service.openRealtimeSession(undefined, {
      instructions: 'Be concise.',
      outputFormat: 'pcm16',
      metadata: { ttlSeconds: 300, transcriptionPrompt: 'Transcribe the caller.' },
    });

    expect(result.providerId).toBe('openai');
    expect(result.sessionId).toBe('rt_123');
    expect(result.transport).toBe('webrtc');
    expect(result.url).toBe('https://openai.example/v1/realtime?model=gpt-realtime');
    expect(result.expiresAt).toBe(1_700_000_000_000);
    expect((result.metadata['clientSecret'] as string)).toBe('ephemeral-secret');
    const connect = result.metadata['connect'] as Record<string, unknown>;
    expect(connect).toBeDefined();
    expect((connect['webrtc'] as Record<string, unknown>)['url']).toBe('https://openai.example/v1/realtime?model=gpt-realtime');
    expect(requestUrl).toBe('https://openai.example/v1/realtime/client_secrets');
    expect(requestBody).toMatchObject({
      expires_after: { anchor: 'created_at', seconds: 300 },
      session: {
        type: 'realtime',
        model: 'gpt-realtime',
        instructions: 'Be concise.',
        output_modalities: ['audio'],
      },
    });
  });

  test('transcribes audio with Google inline audio input', async () => {
    process.env['GEMINI_API_KEY'] = 'gemini-test-key';
    process.env['GEMINI_API_BASE_URL'] = 'https://gemini.example/v1beta';
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const service = new VoiceService(registry);

    let requestUrl = '';
    let requestHeaders: Headers | null = null;
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return makeJsonResponse({
        candidates: [{
          content: {
            parts: [{ text: 'google transcript' }],
          },
        }],
      });
    }) as typeof globalThis.fetch;

    const result = await service.transcribe('google', {
      audio: {
        mimeType: 'audio/webm',
        format: 'webm',
        dataBase64: Buffer.from('GOOGLE_INLINE_BYTES').toString('base64'),
        metadata: {},
      },
    });

    expect(result.providerId).toBe('google');
    expect(result.text).toBe('google transcript');
    expect(result.metadata['uploadMode']).toBe('inline');
    expect(requestUrl).toBe('https://gemini.example/v1beta/models/gemini-2.5-flash:generateContent');
    expect(requestHeaders).not.toBeNull();
    expect(requestBody).not.toBeNull();
    const headers = requestHeaders!;
    const body = requestBody!;
    expect(headers.get('x-goog-api-key')).toBe('gemini-test-key');
    const contents = body['contents'] as unknown as Array<Record<string, unknown>>;
    const parts = contents[0]?.['parts'] as Array<Record<string, unknown>>;
    expect((parts[0]?.['text'] as string)).toContain('Transcribe the provided audio');
    expect(((parts[1]?.['inline_data'] as Record<string, unknown>)['mime_type'] as string)).toBe('audio/webm');
  });

  test('uses the Google Files API when file-mode is requested', async () => {
    process.env['GEMINI_API_KEY'] = 'gemini-test-key';
    process.env['GEMINI_API_BASE_URL'] = 'https://gemini.example/v1beta';
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const service = new VoiceService(registry);

    const requests: string[] = [];
    const uploadUrl = 'https://upload.example/google-file';
    let generateBody: Record<string, unknown> | null = null;
    let deleteUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === 'https://gemini.example/upload/v1beta/files') {
        return makeJsonResponse({}, {
          headers: { 'x-goog-upload-url': uploadUrl },
        });
      }
      if (url === uploadUrl) {
        return makeJsonResponse({
          file: {
            name: 'files/abc123',
            uri: 'google://files/abc123',
            mimeType: 'audio/wav',
          },
        });
      }
      if (url === 'https://gemini.example/v1beta/models/gemini-2.5-flash:generateContent') {
        generateBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return makeJsonResponse({
          candidates: [{
            content: {
              parts: [{ text: 'google uploaded transcript' }],
            },
          }],
        });
      }
      if (url === 'https://gemini.example/v1beta/files/abc123') {
        deleteUrl = url;
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await service.transcribe('google', {
      audio: {
        mimeType: 'audio/wav',
        format: 'wav',
        dataBase64: Buffer.from('GOOGLE_FILE_BYTES').toString('base64'),
        metadata: { filename: 'voice.wav' },
      },
      metadata: { preferFilesApi: true },
    });

    expect(result.providerId).toBe('google');
    expect(result.text).toBe('google uploaded transcript');
    expect(result.metadata['uploadMode']).toBe('file');
    expect(requests).toEqual([
      'https://gemini.example/upload/v1beta/files',
      'https://upload.example/google-file',
      'https://gemini.example/v1beta/models/gemini-2.5-flash:generateContent',
      'https://gemini.example/v1beta/files/abc123',
    ]);
    expect(generateBody).not.toBeNull();
    const contents = generateBody!['contents'] as unknown as Array<Record<string, unknown>>;
    const parts = contents[0]?.['parts'] as Array<Record<string, unknown>>;
    expect((parts[0]?.['file_data'] as Record<string, unknown>)['file_uri']).toBe('google://files/abc123');
    expect((parts[0]?.['file_data'] as Record<string, unknown>)['mime_type']).toBe('audio/wav');
    expect(deleteUrl).toBe('https://gemini.example/v1beta/files/abc123');
  });

  test('transcribes audio with ElevenLabs speech-to-text and supports source URLs', async () => {
    process.env['ELEVENLABS_API_KEY'] = 'elevenlabs-test-key';
    process.env['ELEVENLABS_BASE_URL'] = 'https://elevenlabs.example';
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const service = new VoiceService(registry);

    let requestUrl = '';
    let requestHeaders: Headers | null = null;
    let requestBody: FormData | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = init?.body as FormData;
      return makeJsonResponse({
        transcription_id: 'tr_123',
        language_code: 'en',
        text: 'elevenlabs transcript',
        words: [
          { text: 'elevenlabs', start: 0, end: 0.5, type: 'word', logprob: -0.2, speaker_id: 'speaker_0' },
          { text: 'transcript', start: 0.55, end: 1.1, type: 'word', logprob: -0.1, speaker_id: 'speaker_0' },
        ],
      });
    }) as typeof globalThis.fetch;

    const result = await service.transcribe('elevenlabs', {
      audio: {
        mimeType: 'audio/mpeg',
        format: 'mp3',
        uri: 'https://cdn.example/audio.mp3',
        metadata: {},
      },
      language: 'en',
      metadata: {
        diarize: true,
        numSpeakers: 2,
        timestampsGranularity: 'word',
        enableLogging: false,
      },
    });

    expect(result.providerId).toBe('elevenlabs');
    expect(result.text).toBe('elevenlabs transcript');
    expect(result.language).toBe('en');
    expect(result.metadata['sourceMode']).toBe('source_url');
    expect(result.metadata['transcriptionId']).toBe('tr_123');
    expect(requestUrl).toBe('https://elevenlabs.example/v1/speech-to-text?enable_logging=false');
    expect(requestHeaders).not.toBeNull();
    expect(requestBody).not.toBeNull();
    const headers = requestHeaders!;
    const form = requestBody!;
    expect(headers.get('xi-api-key')).toBe('elevenlabs-test-key');
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('source_url')).toBe('https://cdn.example/audio.mp3');
    expect(form.get('language_code')).toBe('en');
    expect(form.get('diarize')).toBe('true');
    expect(form.get('num_speakers')).toBe('2');
    expect(form.get('timestamps_granularity')).toBe('word');
  });

  test('opens an ElevenLabs realtime STT session using a single-use token', async () => {
    process.env['ELEVENLABS_API_KEY'] = 'elevenlabs-test-key';
    process.env['ELEVENLABS_BASE_URL'] = 'https://elevenlabs.example';
    const registry = new VoiceProviderRegistry();
    ensureBuiltinVoiceProviders(registry);
    const service = new VoiceService(registry);

    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url === 'https://elevenlabs.example/v1/single-use-token/realtime_scribe') {
        return makeJsonResponse({ token: 'sutkn_1234567890' });
      }
      return new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await service.openRealtimeSession('elevenlabs', {
      metadata: {
        includeTimestamps: true,
        includeLanguageDetection: true,
        audioFormat: 'pcm_16000',
        commitStrategy: 'manual',
        languageCode: 'en',
        vadThreshold: 0.6,
      },
    });

    expect(result.providerId).toBe('elevenlabs');
    expect(result.transport).toBe('websocket');
    expect(result.url).toContain('wss://elevenlabs.example/v1/speech-to-text/realtime');
    expect(result.url).toContain('model_id=scribe_v2_realtime');
    expect(result.url).toContain('token=sutkn_1234567890');
    expect(result.url).toContain('include_timestamps=true');
    expect(result.url).toContain('include_language_detection=true');
    expect(result.url).toContain('audio_format=pcm_16000');
    expect(result.url).toContain('commit_strategy=manual');
    expect(result.url).toContain('language_code=en');
    expect((result.metadata['token'] as string)).toBe('sutkn_1234567890');
    const connect = result.metadata['connect'] as Record<string, unknown>;
    expect((connect['websocket'] as Record<string, unknown>)['url']).toBe(result.url);
    expect(requests).toEqual([
      {
        url: 'https://elevenlabs.example/v1/single-use-token/realtime_scribe',
        method: 'POST',
      },
    ]);
  });
});
