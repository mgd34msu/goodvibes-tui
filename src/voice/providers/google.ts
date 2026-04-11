import type { VoiceProvider } from '../types.ts';
import {
  asRecord,
  buildStatus,
  inferFilename,
  normalizeBaseUrl,
  readFirstEnv,
  resolveAudioInput,
  trimToUndefined,
} from './shared.ts';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GOOGLE_STT_MODEL = 'gemini-2.5-flash';
const GOOGLE_INLINE_AUDIO_LIMIT_BYTES = 20 * 1024 * 1024;

type GoogleGenerateContentResponse = {
  readonly candidates?: ReadonlyArray<{
    readonly content?: {
      readonly parts?: ReadonlyArray<{
        readonly text?: string;
      }>;
    };
  }>;
};

type GoogleFileRecord = {
  readonly name?: string;
  readonly uri?: string;
  readonly mimeType?: string;
  readonly mime_type?: string;
};

type GoogleFileUploadResponse = {
  readonly file?: GoogleFileRecord;
};

function parseGoogleTranscript(payload: GoogleGenerateContentResponse): string {
  const text = (payload.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text?.trim() ?? '')
    .filter((entry) => entry.length > 0)
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('Google transcription response missing transcript');
  }
  return text;
}

function parseGoogleFileRecord(payload: GoogleFileUploadResponse): {
  name: string;
  uri: string;
  mimeType: string;
} {
  const file = payload.file;
  const name = trimToUndefined(file?.name);
  const uri = trimToUndefined(file?.uri);
  const mimeType = trimToUndefined(file?.mimeType) || trimToUndefined(file?.mime_type);
  if (!name || !uri || !mimeType) {
    throw new Error('Google file upload response missing file metadata');
  }
  return { name, uri, mimeType };
}

async function uploadGoogleFile(
  baseUrl: string,
  apiKey: string,
  buffer: Uint8Array,
  mimeType: string,
  displayName: string,
): Promise<{ name: string; uri: string; mimeType: string }> {
  const uploadBaseUrl = baseUrl.replace(/\/v1beta$/, '');
  const startResponse = await fetch(`${uploadBaseUrl}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.byteLength),
      'X-Goog-Upload-Header-Content-Type': mimeType,
    },
    body: JSON.stringify({
      file: {
        display_name: displayName,
      },
    }),
  });
  if (!startResponse.ok) {
    throw new Error(`Google file upload start failed: HTTP ${startResponse.status}`);
  }
  const uploadUrl = trimToUndefined(startResponse.headers.get('x-goog-upload-url'));
  if (!uploadUrl) {
    throw new Error('Google file upload start response missing upload URL');
  }
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(buffer.byteLength),
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: Buffer.from(buffer),
  });
  if (!uploadResponse.ok) {
    throw new Error(`Google file upload finalize failed: HTTP ${uploadResponse.status}`);
  }
  return parseGoogleFileRecord(await uploadResponse.json() as GoogleFileUploadResponse);
}

async function deleteGoogleFile(baseUrl: string, apiKey: string, name: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/${name}`, {
      method: 'DELETE',
      headers: {
        'x-goog-api-key': apiKey,
      },
    });
  } catch {
    // Best-effort cleanup only.
  }
}

export function createGoogleProvider(): VoiceProvider {
  const envVars = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'] as const;
  const baseUrlEnvVars = ['GEMINI_API_BASE_URL', 'GOOGLE_API_BASE_URL'] as const;
  return {
    id: 'google',
    label: 'Google',
    capabilities: ['stt'],
    status() {
      const configured = readFirstEnv(envVars) !== null;
      return buildStatus(
        'google',
        'Google',
        ['stt'],
        configured,
        configured
          ? 'Google Gemini audio transcription is available.'
          : 'Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GEMINI_API_KEY to enable Google transcription.',
        {
          baseUrl: normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), GEMINI_API_BASE_URL),
          defaultModel: DEFAULT_GOOGLE_STT_MODEL,
        },
      );
    },
    async transcribe(request) {
      const apiKey = readFirstEnv(envVars);
      if (!apiKey) throw new Error('Google API key missing');
      const baseUrl = normalizeBaseUrl(readFirstEnv(baseUrlEnvVars), GEMINI_API_BASE_URL);
      const { buffer, mimeType } = await resolveAudioInput(request.audio);
      const model = request.modelId?.trim() || DEFAULT_GOOGLE_STT_MODEL;
      const prompt = request.prompt?.trim() || 'Transcribe the provided audio. Return only the transcript.';
      const metadata = asRecord(request.metadata);
      const effectiveMimeType = mimeType || 'audio/wav';
      const useFilesApi = metadata?.['preferFilesApi'] === true
        || buffer.byteLength > GOOGLE_INLINE_AUDIO_LIMIT_BYTES;
      let uploadedFile: { name: string; uri: string; mimeType: string } | null = null;
      try {
        if (useFilesApi) {
          uploadedFile = await uploadGoogleFile(
            baseUrl,
            apiKey,
            buffer,
            effectiveMimeType,
            inferFilename(request.audio, '.wav'),
          );
        }
        const response = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: uploadedFile
                ? [
                    {
                      file_data: {
                        mime_type: uploadedFile.mimeType,
                        file_uri: uploadedFile.uri,
                      },
                    },
                    { text: prompt },
                  ]
                : [
                    { text: prompt },
                    {
                      inline_data: {
                        mime_type: effectiveMimeType,
                        data: Buffer.from(buffer).toString('base64'),
                      },
                    },
                  ],
            }],
          }),
        });
        if (!response.ok) {
          throw new Error(`Google transcription failed: HTTP ${response.status}`);
        }
        const payload = await response.json() as GoogleGenerateContentResponse;
        return {
          providerId: 'google',
          text: parseGoogleTranscript(payload),
          language: request.language,
          metadata: {
            baseUrl,
            modelId: model,
            uploadMode: uploadedFile ? 'file' : 'inline',
          },
        };
      } finally {
        if (uploadedFile) {
          await deleteGoogleFile(baseUrl, apiKey, uploadedFile.name);
        }
      }
    },
  };
}
