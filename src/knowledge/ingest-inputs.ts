import { readFile } from 'node:fs/promises';
import {
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
} from '../runtime/emitters/index.ts';
import { summarizeError } from '../utils/error-display.ts';
import { finalizeKnowledgeIngestedSource } from './ingest-compile.ts';
import type { KnowledgeIngestContext } from './ingest-context.ts';
import {
  DAY_MS,
  canonicalizeUri,
  inferSourceTypeFromArtifact,
  isHttpUri,
  mergeTags,
} from './internal.ts';
import type {
  KnowledgeBatchIngestResult,
  KnowledgeBookmarkSeed,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from './types.ts';

export async function ingestKnowledgeUrl(
  context: KnowledgeIngestContext,
  input: {
    readonly url: string;
    readonly title?: string;
    readonly tags?: readonly string[];
    readonly folderPath?: string;
    readonly sessionId?: string;
    readonly sourceType?: KnowledgeSourceType;
    readonly connectorId?: string;
    readonly allowPrivateHosts?: boolean;
    readonly metadata?: Record<string, unknown>;
  },
): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
  await context.store.init();
  const pending = await context.store.upsertSource({
    connectorId: input.connectorId ?? (input.sourceType === 'bookmark' ? 'bookmark' : 'url'),
    sourceType: input.sourceType ?? 'url',
    title: input.title,
    sourceUri: input.url,
    canonicalUri: canonicalizeUri(input.url) ?? undefined,
    tags: input.tags,
    folderPath: input.folderPath,
    status: 'pending',
    sessionId: input.sessionId,
    metadata: input.metadata,
  });
  context.emitIfReady((bus, ctx) => emitKnowledgeIngestStarted(bus, ctx, {
    sourceId: pending.id,
    connectorId: pending.connectorId,
    sourceType: pending.sourceType,
    uri: input.url,
  }), pending.sessionId);
  try {
    const artifact = await context.artifactStore.create({
      uri: input.url,
      allowPrivateHosts: input.allowPrivateHosts,
      metadata: {
        sourceConnector: pending.connectorId,
        requestedAt: Date.now(),
      },
    });
    const result = await finalizeKnowledgeIngestedSource(context, {
      sourceId: pending.id,
      artifactId: artifact.id,
      inputTitle: input.title,
      sourceType: input.sourceType ?? pending.sourceType,
      connectorId: pending.connectorId,
      tags: mergeTags(pending.tags, input.tags),
      folderPath: input.folderPath ?? pending.folderPath,
      sessionId: input.sessionId ?? pending.sessionId,
      metadata: {
        ...pending.metadata,
        ...(input.metadata ?? {}),
      },
    });
    const issues = await context.lint();
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestCompleted(bus, ctx, {
      sourceId: result.source.id,
      status: result.source.status,
      artifactId: result.artifactId,
      title: result.source.title,
    }), result.source.sessionId);
    return { ...result, issues };
  } catch (error) {
    const failed = await context.store.upsertSource({
      id: pending.id,
      connectorId: pending.connectorId,
      sourceType: pending.sourceType,
      title: pending.title,
      sourceUri: pending.sourceUri,
      canonicalUri: pending.canonicalUri,
      tags: pending.tags,
      folderPath: pending.folderPath,
      status: 'failed',
      crawlError: summarizeError(error),
      sessionId: pending.sessionId,
      metadata: pending.metadata,
    });
    await context.syncReviewedMemory();
    const issues = await context.lint();
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestFailed(bus, ctx, {
      sourceId: failed.id,
      error: failed.crawlError ?? 'Knowledge ingest failed.',
    }), failed.sessionId);
    return { source: failed, issues };
  }
}

export async function ingestKnowledgeArtifact(
  context: KnowledgeIngestContext,
  input: {
    readonly artifactId?: string;
    readonly path?: string;
    readonly uri?: string;
    readonly title?: string;
    readonly tags?: readonly string[];
    readonly folderPath?: string;
    readonly sessionId?: string;
    readonly sourceType?: KnowledgeSourceType;
    readonly connectorId?: string;
    readonly allowPrivateHosts?: boolean;
    readonly metadata?: Record<string, unknown>;
  },
): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
  await context.store.init();
  let artifactId = input.artifactId;
  let sourceUri = input.uri;
  if (!artifactId) {
    if (input.path) {
      const artifact = await context.artifactStore.create({
        path: input.path,
        metadata: {
          sourceConnector: input.connectorId ?? 'artifact',
          requestedAt: Date.now(),
        },
      });
      artifactId = artifact.id;
      sourceUri = input.path;
    } else if (input.uri) {
      const artifact = await context.artifactStore.create({
        uri: input.uri,
        allowPrivateHosts: input.allowPrivateHosts,
        metadata: {
          sourceConnector: input.connectorId ?? 'artifact',
          requestedAt: Date.now(),
        },
      });
      artifactId = artifact.id;
      sourceUri = artifact.sourceUri ?? input.uri;
    }
  }
  if (!artifactId) throw new Error('Artifact ingest requires artifactId, path, or uri.');
  const record = context.artifactStore.getRecord(artifactId);
  if (!record) throw new Error(`Unknown artifact: ${artifactId}`);
  const pending = await context.store.upsertSource({
    connectorId: input.connectorId ?? 'artifact',
    sourceType: input.sourceType ?? inferSourceTypeFromArtifact(record),
    title: input.title ?? record.filename,
    sourceUri,
    canonicalUri: canonicalizeUri(sourceUri ?? '') ?? undefined,
    tags: input.tags,
    folderPath: input.folderPath,
    status: 'pending',
    sessionId: input.sessionId,
    metadata: {
      ...(input.metadata ?? {}),
      artifactMimeType: record.mimeType,
    },
  });
  context.emitIfReady((bus, ctx) => emitKnowledgeIngestStarted(bus, ctx, {
    sourceId: pending.id,
    connectorId: pending.connectorId,
    sourceType: pending.sourceType,
    uri: sourceUri,
  }), pending.sessionId);
  try {
    const result = await finalizeKnowledgeIngestedSource(context, {
      sourceId: pending.id,
      artifactId,
      inputTitle: input.title,
      sourceType: pending.sourceType,
      connectorId: pending.connectorId,
      tags: mergeTags(pending.tags, input.tags),
      folderPath: pending.folderPath,
      sessionId: input.sessionId ?? pending.sessionId,
      metadata: {
        ...pending.metadata,
        ...(input.metadata ?? {}),
      },
    });
    const issues = await context.lint();
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestCompleted(bus, ctx, {
      sourceId: result.source.id,
      status: result.source.status,
      artifactId: result.artifactId,
      title: result.source.title,
    }), result.source.sessionId);
    return { ...result, issues };
  } catch (error) {
    const failed = await context.store.upsertSource({
      id: pending.id,
      connectorId: pending.connectorId,
      sourceType: pending.sourceType,
      title: pending.title,
      sourceUri: pending.sourceUri,
      canonicalUri: pending.canonicalUri,
      tags: pending.tags,
      folderPath: pending.folderPath,
      status: 'failed',
      crawlError: summarizeError(error),
      sessionId: pending.sessionId,
      metadata: pending.metadata,
    });
    await context.syncReviewedMemory();
    const issues = await context.lint();
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestFailed(bus, ctx, {
      sourceId: failed.id,
      error: failed.crawlError ?? 'Artifact ingest failed.',
    }), failed.sessionId);
    return { source: failed, issues };
  }
}

export async function importKnowledgeBookmarksFromFile(
  context: KnowledgeIngestContext,
  input: { readonly path: string; readonly sessionId?: string; readonly allowPrivateHosts?: boolean },
): Promise<KnowledgeBatchIngestResult> {
  const content = await readFile(input.path, 'utf-8');
  return ingestKnowledgeWithConnector(context, 'bookmark', content, input.sessionId, input.allowPrivateHosts);
}

export async function importKnowledgeUrlsFromFile(
  context: KnowledgeIngestContext,
  input: { readonly path: string; readonly sessionId?: string; readonly allowPrivateHosts?: boolean },
): Promise<KnowledgeBatchIngestResult> {
  const content = await readFile(input.path, 'utf-8');
  return ingestKnowledgeWithConnector(context, 'url-list', content, input.sessionId, input.allowPrivateHosts);
}

export async function ingestKnowledgeBookmarkSeeds(
  context: KnowledgeIngestContext,
  seeds: readonly KnowledgeBookmarkSeed[],
  sessionId?: string,
  sourceType: KnowledgeSourceType = 'bookmark',
  connectorId = 'bookmark',
  allowPrivateHosts?: boolean,
): Promise<KnowledgeBatchIngestResult> {
  const sources: KnowledgeSourceRecord[] = [];
  const errors: string[] = [];
  let imported = 0;
  let failed = 0;
  for (const seed of seeds) {
    try {
      const result = await ingestKnowledgeUrl(context, {
        url: seed.url,
        title: seed.title,
        tags: seed.tags,
        folderPath: seed.folderPath,
        sessionId,
        sourceType,
        connectorId,
        allowPrivateHosts,
        metadata: seed.metadata,
      });
      sources.push(result.source);
      if (result.source.status === 'failed') failed += 1;
      else imported += 1;
    } catch (error) {
      failed += 1;
      errors.push(`${seed.url}: ${summarizeError(error)}`);
    }
  }
  return { imported, failed, sources, errors };
}

export async function ingestKnowledgeWithConnector(
  context: KnowledgeIngestContext,
  connectorId: string,
  input: unknown,
  sessionId?: string,
  allowPrivateHosts?: boolean,
): Promise<KnowledgeBatchIngestResult> {
  const resolved = await context.connectorRegistry.resolve(connectorId, input);
  return ingestKnowledgeBookmarkSeeds(
    context,
    resolved.seeds,
    sessionId,
    resolved.sourceType ?? 'other',
    resolved.connectorId ?? connectorId,
    allowPrivateHosts,
  );
}

export async function ingestKnowledgeConnectorInput(context: KnowledgeIngestContext, input: {
  readonly connectorId: string;
  readonly input?: unknown;
  readonly content?: string;
  readonly path?: string;
  readonly sessionId?: string;
  readonly allowPrivateHosts?: boolean;
}): Promise<KnowledgeBatchIngestResult> {
  const connectorId = input.connectorId.trim();
  if (!connectorId) throw new Error('Missing connectorId');
  let resolvedInput: unknown;
  if (Object.hasOwn(input, 'input')) {
    resolvedInput = input.input;
  } else if (typeof input.content === 'string') {
    resolvedInput = input.content;
  } else if (typeof input.path === 'string' && input.path.trim()) {
    resolvedInput = await readFile(input.path, 'utf-8');
  } else {
    throw new Error('Connector ingest requires input, content, or path.');
  }
  return ingestKnowledgeWithConnector(context, connectorId, resolvedInput, input.sessionId, input.allowPrivateHosts);
}

export async function refreshKnowledgeSources(context: KnowledgeIngestContext, sources: readonly KnowledgeSourceRecord[]): Promise<number> {
  let refreshed = 0;
  for (const source of sources) {
    const result = await ingestKnowledgeUrl(context, {
      url: source.sourceUri ?? source.canonicalUri ?? '',
      title: source.title,
      tags: source.tags,
      folderPath: source.folderPath,
      sessionId: source.sessionId,
      sourceType: source.sourceType,
      connectorId: source.connectorId,
      metadata: {
        ...source.metadata,
        refreshedAt: Date.now(),
      },
    });
    if (result.source.status === 'indexed') refreshed += 1;
  }
  return refreshed;
}

export function pickKnowledgeRefreshCandidates(
  context: { readonly store: { listSources(limit: number): KnowledgeSourceRecord[] } },
  mode: 'stale' | 'bookmark',
  explicitIds: readonly string[] | undefined,
  limit = 25,
): KnowledgeSourceRecord[] {
  const max = Math.max(1, limit);
  let sources = context.store.listSources(10_000);
  if (explicitIds?.length) {
    const wanted = new Set(explicitIds);
    sources = sources.filter((source) => wanted.has(source.id));
  }
  if (mode === 'bookmark') {
    sources = sources.filter((source) => source.connectorId === 'bookmark' || source.connectorId === 'url-list');
  } else {
    sources = sources.filter((source) => (
      source.status === 'stale'
      || source.status === 'failed'
      || isSourcePastRefreshWindow(source)
    ));
  }
  return sources.filter((source) => isHttpUri(source.sourceUri)).slice(0, max);
}

export function isSourcePastRefreshWindow(source: KnowledgeSourceRecord): boolean {
  if (!source.lastCrawledAt) return source.status === 'stale';
  return source.lastCrawledAt < (Date.now() - getSourceRefreshWindowMs(source));
}

export function getSourceRefreshWindowMs(source: KnowledgeSourceRecord): number {
  const connectorKey = source.connectorId === 'url-list' ? 'url-list' : source.connectorId;
  return {
    bookmark: 7 * DAY_MS,
    'bookmark-list': 7 * DAY_MS,
    'url-list': 7 * DAY_MS,
    url: 14 * DAY_MS,
    repo: 14 * DAY_MS,
    document: 21 * DAY_MS,
    image: 21 * DAY_MS,
    dataset: 30 * DAY_MS,
    manual: 45 * DAY_MS,
    other: 30 * DAY_MS,
  }[connectorKey] ?? 30 * DAY_MS;
}
