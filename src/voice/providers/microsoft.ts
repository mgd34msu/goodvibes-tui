import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeTTS } from 'node-edge-tts';
import {
  CHROMIUM_FULL_VERSION,
  TRUSTED_CLIENT_TOKEN,
  generateSecMsGecToken,
} from 'node-edge-tts/dist/drm.js';
import type { VoiceDescriptor, VoiceProvider } from '../types.ts';
import {
  buildStatus,
  inferExtFromOutputFormat,
  inferMimeFromExtension,
} from './shared.ts';

type MicrosoftVoiceListEntry = {
  ShortName?: string;
  FriendlyName?: string;
  Locale?: string;
  Gender?: string;
  VoiceTag?: {
    ContentCategories?: string[];
    VoicePersonalities?: string[];
  };
};

function buildMicrosoftVoiceHeaders(): Record<string, string> {
  const major = CHROMIUM_FULL_VERSION.split('.')[0] || '0';
  return {
    Authority: 'speech.platform.bing.com',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Accept: '*/*',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
    'Sec-MS-GEC': generateSecMsGecToken(),
    'Sec-MS-GEC-Version': `1-${CHROMIUM_FULL_VERSION}`,
  };
}

async function listMicrosoftVoices(): Promise<readonly VoiceDescriptor[]> {
  const response = await fetch(
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`,
    { headers: buildMicrosoftVoiceHeaders() },
  );
  if (!response.ok) throw new Error(`Microsoft voices failed: HTTP ${response.status}`);
  const payload = await response.json() as MicrosoftVoiceListEntry[];
  return Array.isArray(payload)
    ? payload
        .map((voice) => ({
          id: voice.ShortName?.trim() ?? '',
          label: voice.FriendlyName?.trim() || voice.ShortName?.trim() || 'Voice',
          locale: voice.Locale?.trim(),
          gender: voice.Gender?.trim(),
          metadata: {
            categories: voice.VoiceTag?.ContentCategories ?? [],
            personalities: voice.VoiceTag?.VoicePersonalities ?? [],
          },
        }))
        .filter((voice) => voice.id.length > 0)
    : [];
}

export function createMicrosoftProvider(): VoiceProvider {
  return {
    id: 'microsoft',
    label: 'Microsoft',
    capabilities: ['tts', 'voice-list'],
    status() {
      return buildStatus(
        'microsoft',
        'Microsoft',
        ['tts', 'voice-list'],
        true,
        'Microsoft Edge speech does not require an API key and remains optional operator convenience.',
      );
    },
    async listVoices() {
      return listMicrosoftVoices();
    },
    async synthesize(request) {
      const outputFormat = request.format === 'wav'
        ? 'riff-24khz-16bit-mono-pcm'
        : 'audio-24khz-48kbitrate-mono-mp3';
      const ext = inferExtFromOutputFormat(outputFormat);
      const dir = mkdtempSync(join(tmpdir(), 'gv-edge-tts-'));
      const outPath = join(dir, `speech${ext}`);
      try {
        const tts = new EdgeTTS({
          voice: request.voiceId?.trim() || 'en-US-MichelleNeural',
          lang: 'en-US',
          outputFormat,
          rate: typeof request.speed === 'number' && Number.isFinite(request.speed)
            ? `${Math.round((request.speed - 1) * 100)}%`
            : 'default',
        });
        await tts.ttsPromise(request.text, outPath);
        const buffer = readFileSync(outPath);
        return {
          providerId: 'microsoft',
          audio: {
            mimeType: inferMimeFromExtension(ext),
            format: ext === '.wav' ? 'wav' : 'mp3',
            dataBase64: buffer.toString('base64'),
            metadata: {
              voiceId: request.voiceId?.trim() || 'en-US-MichelleNeural',
            },
          },
          metadata: {},
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
