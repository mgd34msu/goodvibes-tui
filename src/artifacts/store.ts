import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { logger } from '../utils/logger.ts';
import { classifyHostTrustTier, extractHostname } from '../tools/fetch/trust-tiers.ts';
import type { ConfigKey } from '../config/schema.ts';
import type {
  ArtifactAttachment,
  ArtifactCreateInput,
  ArtifactDescriptor,
  ArtifactRecord,
  ArtifactReference,
} from './types.ts';
import {
  guessMimeType,
  inferArtifactKind,
  sanitizeArtifactFilename,
} from './types.ts';

export interface ArtifactStoreConfig {
  readonly rootDir?: string;
  readonly configManager?: {
    getControlPlaneConfigDir?: () => string;
    get?: (key: ConfigKey) => unknown;
  };
  readonly maxBytes?: number;
  readonly defaultRetentionMs?: number;
  readonly maxRetentionMs?: number;
  readonly trustedHosts?: readonly string[];
  readonly blockedHosts?: readonly string[];
  readonly allowPrivateHostFetches?: boolean;
}

const DEFAULT_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function resolveArtifactRootDir(config: ArtifactStoreConfig): string {
  const controlPlaneDir = typeof config.configManager?.getControlPlaneConfigDir === 'function'
    ? config.configManager.getControlPlaneConfigDir()
    : undefined;
  const rootDir = config.rootDir ?? (controlPlaneDir ? join(controlPlaneDir, 'artifacts') : undefined);
  if (!rootDir) {
    throw new Error('ArtifactStore requires an explicit rootDir or configManager.getControlPlaneConfigDir().');
  }
  return rootDir;
}

function normalizeMimeType(value: string | undefined, fallbackFilename?: string): string {
  const normalized = value?.split(';')[0]?.trim().toLowerCase();
  if (normalized && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(normalized)) {
    return normalized;
  }
  return guessMimeType(fallbackFilename);
}

function sanitizeRetentionMs(
  requested: number | undefined,
  defaultRetentionMs: number,
  maxRetentionMs: number,
): number | undefined {
  if (requested === 0) return undefined;
  const candidate = Number.isFinite(requested) ? Number(requested) : defaultRetentionMs;
  if (candidate <= 0) return undefined;
  return Math.min(candidate, maxRetentionMs);
}

function filenameFromUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    const candidate = basename(url.pathname);
    return candidate && candidate !== '/' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export class ArtifactStore {
  private readonly rootDir: string;
  private readonly records = new Map<string, ArtifactRecord>();
  private readonly maxBytes: number;
  private readonly defaultRetentionMs: number;
  private readonly maxRetentionMs: number;
  private readonly trustedHosts: readonly string[];
  private readonly blockedHosts: readonly string[];
  private readonly allowPrivateHostFetches: boolean;

  constructor(config: ArtifactStoreConfig) {
    this.rootDir = resolveArtifactRootDir(config);
    this.maxBytes = Math.max(1, config.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES);
    this.defaultRetentionMs = Math.max(0, config.defaultRetentionMs ?? DEFAULT_ARTIFACT_RETENTION_MS);
    this.maxRetentionMs = Math.max(this.defaultRetentionMs, config.maxRetentionMs ?? DEFAULT_MAX_RETENTION_MS);
    this.trustedHosts = [...(config.trustedHosts ?? [])];
    this.blockedHosts = [...(config.blockedHosts ?? [])];
    this.allowPrivateHostFetches = config.allowPrivateHostFetches
      ?? Boolean(config.configManager?.get?.('network.remoteFetch.allowPrivateHosts'));
    mkdirSync(this.rootDir, { recursive: true });
    this.loadExisting();
  }

  get storagePath(): string {
    return this.rootDir;
  }

  list(limit = 100): ArtifactDescriptor[] {
    this.pruneExpired();
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit))
      .map((record) => this.toDescriptor(record));
  }

  get(id: string): ArtifactDescriptor | null {
    this.pruneExpired();
    const record = this.records.get(id);
    return record ? this.toDescriptor(record) : null;
  }

  getRecord(id: string): ArtifactRecord | null {
    this.pruneExpired();
    return this.records.get(id) ?? null;
  }

  async readContent(id: string): Promise<{ record: ArtifactRecord; buffer: Buffer }> {
    this.pruneExpired();
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown artifact: ${id}`);
    return {
      record,
      buffer: await readFile(record.contentPath),
    };
  }

  async create(input: ArtifactCreateInput): Promise<ArtifactDescriptor> {
    const resolved = await this.resolveInput(input);
    if (resolved.buffer.length > this.maxBytes) {
      throw new Error(`Artifact exceeds the ${this.maxBytes}-byte limit.`);
    }
    const id = `artifact-${randomUUID().slice(0, 8)}`;
    const filename = sanitizeArtifactFilename(resolved.filename, 'artifact');
    const contentPath = join(this.rootDir, `${id}.data`);
    const metadataPath = join(this.rootDir, `${id}.json`);
    const retentionMs = sanitizeRetentionMs(input.retentionMs, this.defaultRetentionMs, this.maxRetentionMs);
    await mkdir(this.rootDir, { recursive: true });
    if (resolved.path) {
      await copyFile(resolved.path, contentPath);
    } else {
      await writeFile(contentPath, resolved.buffer);
    }
    const record: ArtifactRecord = {
      id,
      kind: input.kind ?? inferArtifactKind(resolved.mimeType, filename),
      mimeType: resolved.mimeType,
      filename,
      sizeBytes: resolved.buffer.length,
      sha256: createHash('sha256').update(resolved.buffer).digest('hex'),
      createdAt: Date.now(),
      ...(retentionMs ? { expiresAt: Date.now() + retentionMs } : {}),
      ...(resolved.sourceUri ? { sourceUri: resolved.sourceUri } : {}),
      metadata: input.metadata ?? {},
      contentPath,
      metadataPath,
    };
    await writeFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    this.records.set(id, record);
    return this.toDescriptor(record);
  }

  async toAttachment(
    reference: ArtifactReference,
    options: {
      readonly contentUrl?: string;
      readonly includeBase64IfSmallerThan?: number;
    } = {},
  ): Promise<ArtifactAttachment> {
    const record = this.records.get(reference.artifactId);
    if (!record) throw new Error(`Unknown artifact: ${reference.artifactId}`);
    const relativeContentPath = `/api/artifacts/${encodeURIComponent(record.id)}/content`;
    const attachment: ArtifactAttachment = {
      artifactId: record.id,
      label: reference.label,
      metadata: {
        ...record.metadata,
        ...(reference.metadata ?? {}),
      },
      id: record.id,
      kind: record.kind,
      mimeType: record.mimeType,
      filename: record.filename,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      createdAt: record.createdAt,
      contentPath: relativeContentPath,
      ...(options.contentUrl ? { contentUrl: options.contentUrl } : {}),
    };
    if (
      typeof options.includeBase64IfSmallerThan === 'number'
      && record.sizeBytes <= Math.max(0, options.includeBase64IfSmallerThan)
    ) {
      const { buffer } = await this.readContent(record.id);
      return {
        ...attachment,
        dataBase64: buffer.toString('base64'),
      };
    }
    return attachment;
  }

  private toDescriptor(record: ArtifactRecord): ArtifactDescriptor {
    return {
      id: record.id,
      kind: record.kind,
      mimeType: record.mimeType,
      filename: record.filename,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      createdAt: record.createdAt,
      ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {}),
      ...(typeof record.sourceUri === 'string' ? { sourceUri: record.sourceUri } : {}),
      metadata: record.metadata,
    };
  }

  private loadExisting(): void {
    if (!existsSync(this.rootDir)) return;
    for (const entry of readdirSync(this.rootDir)) {
      if (!entry.endsWith('.json')) continue;
      const metadataPath = join(this.rootDir, entry);
      try {
        const parsed = JSON.parse(readFileSync(metadataPath, 'utf-8')) as ArtifactRecord;
        if (!parsed?.id || typeof parsed.contentPath !== 'string' || !existsSync(parsed.contentPath)) continue;
        if (typeof parsed.expiresAt === 'number' && parsed.expiresAt <= Date.now()) {
          this.removeRecordFiles(parsed);
          continue;
        }
        this.records.set(parsed.id, parsed);
      } catch (error) {
        logger.debug('[artifacts] skipping unreadable artifact metadata', {
          path: metadataPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private pruneExpired(now = Date.now()): void {
    for (const record of this.records.values()) {
      if (typeof record.expiresAt === 'number' && record.expiresAt <= now) {
        this.removeRecordFiles(record);
      }
    }
  }

  private removeRecordFiles(record: ArtifactRecord): void {
    this.records.delete(record.id);
    try {
      if (existsSync(record.contentPath)) rmSync(record.contentPath, { force: true });
      if (existsSync(record.metadataPath)) rmSync(record.metadataPath, { force: true });
    } catch (error) {
      logger.debug('[artifacts] failed to prune expired artifact files', {
        artifactId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolveInput(input: ArtifactCreateInput): Promise<{
    buffer: Buffer;
    mimeType: string;
    filename: string;
    path?: string;
    sourceUri?: string;
  }> {
    if (typeof input.dataBase64 === 'string') {
      const filename = sanitizeArtifactFilename(input.filename, 'artifact');
      return {
        buffer: Buffer.from(input.dataBase64, 'base64'),
        mimeType: normalizeMimeType(input.mimeType, filename),
        filename,
        ...(typeof input.sourceUri === 'string' && input.sourceUri.trim().length > 0 ? { sourceUri: input.sourceUri.trim() } : {}),
      };
    }
    if (typeof input.text === 'string') {
      const filename = sanitizeArtifactFilename(input.filename, 'artifact.txt');
      return {
        buffer: Buffer.from(input.text, 'utf-8'),
        mimeType: normalizeMimeType(input.mimeType ?? guessMimeType(filename) ?? 'text/plain', filename),
        filename,
        ...(typeof input.sourceUri === 'string' && input.sourceUri.trim().length > 0 ? { sourceUri: input.sourceUri.trim() } : {}),
      };
    }
    if (typeof input.path === 'string' && input.path.trim().length > 0) {
      const normalizedPath = input.path.trim();
      const buffer = await readFile(normalizedPath);
      const filename = sanitizeArtifactFilename(input.filename ?? basename(normalizedPath), 'artifact');
      let mimeType = input.mimeType;
      if (!mimeType) {
        const bunType = Bun.file(normalizedPath).type;
        mimeType = bunType && bunType.trim().length > 0 ? bunType : guessMimeType(filename);
      }
      if (buffer.length > this.maxBytes) {
        throw new Error(`Artifact exceeds the ${this.maxBytes}-byte limit.`);
      }
      return {
        buffer,
        mimeType: normalizeMimeType(mimeType ?? 'application/octet-stream', filename),
        filename,
        path: normalizedPath,
        ...(typeof input.sourceUri === 'string' && input.sourceUri.trim().length > 0 ? { sourceUri: input.sourceUri.trim() } : {}),
      };
    }
    if (typeof input.uri === 'string' && input.uri.trim().length > 0) {
      return this.resolveRemoteInput(input.uri.trim(), input.mimeType, input.filename, Boolean(input.allowPrivateHosts));
    }
    throw new Error('Artifact input requires dataBase64, text, path, or uri');
  }

  private async resolveRemoteInput(
    uri: string,
    mimeTypeOverride?: string,
    filenameOverride?: string,
    allowPrivateHosts = false,
  ): Promise<{
    buffer: Buffer;
    mimeType: string;
    filename: string;
    sourceUri: string;
  }> {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported artifact URI scheme: ${parsed.protocol}`);
    }

    let current = parsed.toString();
    for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
      if (allowPrivateHosts && !this.allowPrivateHostFetches) {
        throw new Error('Private-host remote artifact fetches are disabled by config.');
      }
      this.assertRemoteHostAllowed(current, allowPrivateHosts);
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`Artifact URI redirect missing location header: ${current}`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`Artifact URI fetch failed (${response.status}) for ${current}`);
      }
      const contentLength = Number(response.headers.get('content-length') ?? NaN);
      if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
        throw new Error(`Remote artifact exceeds the ${this.maxBytes}-byte limit.`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > this.maxBytes) {
        throw new Error(`Remote artifact exceeds the ${this.maxBytes}-byte limit.`);
      }
      const filename = sanitizeArtifactFilename(
        filenameOverride
          ?? this.filenameFromContentDisposition(response.headers.get('content-disposition'))
          ?? filenameFromUrl(current),
        'artifact',
      );
      return {
        buffer,
        mimeType: normalizeMimeType(mimeTypeOverride ?? response.headers.get('content-type') ?? undefined, filename),
        filename,
        sourceUri: current,
      };
    }
    throw new Error(`Artifact URI exceeded redirect limit: ${uri}`);
  }

  private filenameFromContentDisposition(header: string | null): string | undefined {
    if (!header) return undefined;
    const match = header.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    if (!match?.[1]) return undefined;
    try {
      return decodeURIComponent(match[1].replace(/^"|"$/g, ''));
    } catch {
      return match[1].replace(/^"|"$/g, '');
    }
  }

  private assertRemoteHostAllowed(uri: string, allowPrivateHosts = false): void {
    const hostname = extractHostname(uri);
    if (!hostname) {
      throw new Error(`Could not resolve artifact URI host: ${uri}`);
    }
    const result = classifyHostTrustTier(hostname, {
      trustedHosts: [...this.trustedHosts],
      blockedHosts: [...this.blockedHosts],
    });
    if (result.tier === 'blocked' && (!allowPrivateHosts || !result.isSsrf)) {
      throw new Error(`Artifact URI blocked by SSRF policy: ${result.reason}`);
    }
  }
}
