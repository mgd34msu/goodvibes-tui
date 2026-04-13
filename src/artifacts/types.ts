export type ArtifactKind = 'file' | 'image' | 'audio' | 'video' | 'document' | 'archive' | 'data';
export const ARTIFACT_ACQUISITION_MODES = ['inline-data', 'local-path', 'remote-fetch', 'unknown'] as const;
export const ARTIFACT_FETCH_MODES = ['not-applicable', 'public-only', 'allow-private-hosts', 'unknown'] as const;

export type ArtifactAcquisitionMode = typeof ARTIFACT_ACQUISITION_MODES[number];
export type ArtifactFetchMode = typeof ARTIFACT_FETCH_MODES[number];

export interface ArtifactDescriptor {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly mimeType: string;
  readonly filename?: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly sourceUri?: string;
  readonly acquisitionMode: ArtifactAcquisitionMode;
  readonly fetchMode: ArtifactFetchMode;
  readonly metadata: Record<string, unknown>;
}

export interface ArtifactRecord extends ArtifactDescriptor {
  readonly contentPath: string;
  readonly metadataPath: string;
}

export interface ArtifactReference {
  readonly artifactId: string;
  readonly label?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ArtifactAttachment extends ArtifactDescriptor {
  readonly artifactId: string;
  readonly label?: string;
  readonly contentPath: string;
  readonly contentUrl?: string;
  readonly dataBase64?: string;
}

export interface ArtifactCreateInput {
  readonly kind?: ArtifactKind;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly dataBase64?: string;
  readonly text?: string;
  readonly path?: string;
  readonly uri?: string;
  readonly sourceUri?: string;
  readonly retentionMs?: number;
  readonly acquisitionMode?: ArtifactAcquisitionMode;
  readonly fetchMode?: ArtifactFetchMode;
  readonly allowPrivateHosts?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

export function guessMimeType(filename?: string): string {
  if (!filename) return 'application/octet-stream';
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  return EXTENSION_MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function inferArtifactKind(mimeType: string, filename?: string): ArtifactKind {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('video/')) return 'video';
  if (
    lower === 'application/json'
    || lower === 'text/csv'
    || lower === 'text/tab-separated-values'
    || lower === 'application/xml'
    || lower === 'application/yaml'
    || lower.includes('spreadsheetml')
    || lower === 'application/vnd.ms-excel'
  ) {
    return 'data';
  }
  if (
    lower === 'application/pdf'
    || lower.startsWith('text/')
    || lower.includes('wordprocessingml')
    || lower === 'application/msword'
    || lower.includes('presentationml')
    || lower === 'application/vnd.ms-powerpoint'
  ) {
    return 'document';
  }
  if (
    lower === 'application/zip'
    || lower === 'application/gzip'
    || lower === 'application/x-tar'
  ) {
    return 'archive';
  }
  const fromFilename = guessMimeType(filename);
  if (fromFilename !== 'application/octet-stream' && fromFilename !== lower) {
    return inferArtifactKind(fromFilename, undefined);
  }
  return 'file';
}

export function sanitizeArtifactFilename(filename: string | undefined, fallback = 'artifact'): string {
  const trimmed = (filename ?? fallback).trim().replace(/[\\/:*?"<>|]+/g, '-');
  return trimmed.length > 0 ? trimmed : fallback;
}
