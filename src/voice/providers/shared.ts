import type {
  VoiceAudioArtifact,
  VoiceProvider,
  VoiceProviderStatus,
} from '../types.ts';

export function trimToUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readFirstEnv(envVars: readonly string[]): string | null {
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function normalizeBaseUrl(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return (trimmed && trimmed.length > 0 ? trimmed : fallback).replace(/\/+$/, '');
}

export async function resolveAudioInput(
  audio: VoiceAudioArtifact,
): Promise<{ buffer: Uint8Array; mimeType: string }> {
  if (typeof audio.dataBase64 === 'string' && audio.dataBase64.trim().length > 0) {
    return {
      buffer: Uint8Array.from(Buffer.from(audio.dataBase64, 'base64')),
      mimeType: audio.mimeType,
    };
  }
  if (typeof audio.uri === 'string' && audio.uri.trim().length > 0) {
    const response = await fetch(audio.uri);
    if (!response.ok) throw new Error(`Failed to load audio URI: HTTP ${response.status}`);
    return {
      buffer: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type')?.trim() || audio.mimeType,
    };
  }
  throw new Error('Voice audio input requires dataBase64 or uri.');
}

export function buildStatus(
  id: string,
  label: string,
  capabilities: VoiceProvider['capabilities'],
  configured: boolean,
  detail: string,
  metadata: Record<string, unknown> = {},
): VoiceProviderStatus {
  return {
    id,
    label,
    state: configured ? 'healthy' : 'unconfigured',
    capabilities: [...capabilities],
    configured,
    detail,
    metadata,
  };
}

export function inferMimeFromExtension(ext: string): string {
  switch (ext) {
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.webm':
      return 'audio/webm';
    case '.flac':
      return 'audio/flac';
    case '.aac':
      return 'audio/aac';
    case '.pcm':
      return 'audio/pcm';
    default:
      return 'audio/mpeg';
  }
}

export function inferExtFromOutputFormat(outputFormat: string): string {
  const lower = outputFormat.toLowerCase();
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('ogg')) return '.ogg';
  if (lower.includes('flac')) return '.flac';
  if (lower.includes('aac')) return '.aac';
  if (lower.includes('wav') || lower.includes('riff')) return '.wav';
  if (lower.includes('pcm')) return '.pcm';
  return '.mp3';
}

export function inferFilename(audio: VoiceAudioArtifact, fallbackExt: string): string {
  const metadata = asRecord(audio.metadata);
  const explicit = trimToUndefined(metadata?.['filename']);
  if (explicit) return explicit;
  return `audio${fallbackExt}`;
}

export function mimeTypeForVoiceFormat(format: string): string {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'pcm':
      return 'audio/pcm';
    default:
      return 'audio/mpeg';
  }
}

export function estimateConfidenceFromAvgLogprob(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const bounded = Math.max(0, Math.min(1, Math.exp(value)));
  return Number.isFinite(bounded) ? bounded : undefined;
}
