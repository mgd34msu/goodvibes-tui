import { readFile } from 'node:fs/promises';
import { ArtifactStore } from '../artifacts/index.ts';
import type { ArtifactDescriptor } from '../artifacts/types.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitKnowledgeCompileCompleted,
  emitKnowledgeExtractionCompleted,
  emitKnowledgeExtractionFailed,
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
  emitKnowledgeProjectionMaterialized,
  emitKnowledgeProjectionRendered,
} from '../runtime/emitters/index.ts';
import { createDefaultKnowledgeConnectorRegistry, KnowledgeConnectorRegistry } from './connectors.ts';
import { extractKnowledgeArtifact } from './extractors.ts';
import { KnowledgeProjectionService } from './projections.ts';
import { KnowledgeStore } from './store.ts';
import type {
  KnowledgeBatchIngestResult,
  KnowledgeBookmarkSeed,
  KnowledgeConnector,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeProjectionBundle,
  KnowledgeProjectionTarget,
  KnowledgeProjectionTargetKind,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
  KnowledgeNodeRecord,
} from './types.ts';
import {
  canonicalizeUri,
  coerceStringArray,
  extractTaggedValues,
  inferSourceTypeFromArtifact,
  isHttpUri,
  mergeTags,
  readMetadataStrings,
  slugify,
  summarizeCompact,
  topKeywords,
  tokenize,
  usageWindowCutoff,
  DAY_MS,
  DEFAULT_PACKET_LIMIT,
  DEFAULT_PACKET_BUDGET,
  LIGHT_CONSOLIDATION_THRESHOLD,
  DEEP_CONSOLIDATION_AUTOPROMOTE_THRESHOLD,
  LINT_NAMESPACE,
  trimForDetail,
} from './internal.ts';

export interface KnowledgeIngestContext {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly connectorRegistry: KnowledgeConnectorRegistry;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
  readonly syncReviewedMemory: () => Promise<void>;
  readonly lint: () => Promise<readonly KnowledgeIssueRecord[]>;
  readonly listConnectors: () => readonly KnowledgeConnector[];
}

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
      allowPrivateHosts: true,
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
      crawlError: error instanceof Error ? error.message : String(error),
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
        allowPrivateHosts: true,
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
      crawlError: error instanceof Error ? error.message : String(error),
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

export async function importKnowledgeBookmarksFromFile(context: KnowledgeIngestContext, input: { readonly path: string; readonly sessionId?: string }): Promise<KnowledgeBatchIngestResult> {
  const content = await readFile(input.path, 'utf-8');
  return ingestKnowledgeWithConnector(context, 'bookmark', content, input.sessionId);
}

export async function importKnowledgeUrlsFromFile(context: KnowledgeIngestContext, input: { readonly path: string; readonly sessionId?: string }): Promise<KnowledgeBatchIngestResult> {
  const content = await readFile(input.path, 'utf-8');
  return ingestKnowledgeWithConnector(context, 'url-list', content, input.sessionId);
}

export async function ingestKnowledgeBookmarkSeeds(
  context: KnowledgeIngestContext,
  seeds: readonly KnowledgeBookmarkSeed[],
  sessionId?: string,
  sourceType: KnowledgeSourceType = 'bookmark',
  connectorId = 'bookmark',
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
        metadata: seed.metadata,
      });
      sources.push(result.source);
      if (result.source.status === 'failed') failed += 1;
      else imported += 1;
    } catch (error) {
      failed += 1;
      errors.push(`${seed.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { imported, failed, sources, errors };
}

export async function ingestKnowledgeWithConnector(
  context: KnowledgeIngestContext,
  connectorId: string,
  input: unknown,
  sessionId?: string,
): Promise<KnowledgeBatchIngestResult> {
  const resolved = await context.connectorRegistry.resolve(connectorId, input);
  return ingestKnowledgeBookmarkSeeds(
    context,
    resolved.seeds,
    sessionId,
    resolved.sourceType ?? 'other',
    resolved.connectorId ?? connectorId,
  );
}

export async function ingestKnowledgeConnectorInput(context: KnowledgeIngestContext, input: {
  readonly connectorId: string;
  readonly input?: unknown;
  readonly content?: string;
  readonly path?: string;
  readonly sessionId?: string;
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
  return ingestKnowledgeWithConnector(context, connectorId, resolvedInput, input.sessionId);
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
  context: { readonly store: KnowledgeStore },
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

export async function finalizeKnowledgeIngestedSource(
  context: KnowledgeIngestContext,
  input: {
    readonly sourceId: string;
    readonly artifactId: string;
    readonly inputTitle?: string;
    readonly sourceType: KnowledgeSourceType;
    readonly connectorId: string;
    readonly tags: readonly string[];
    readonly folderPath?: string;
    readonly sessionId?: string;
    readonly metadata: Record<string, unknown>;
  },
): Promise<{ source: KnowledgeSourceRecord; artifactId: string; extraction: KnowledgeExtractionRecord }> {
  const content = await context.artifactStore.readContent(input.artifactId);
  const record = content.record;
  const canonicalUri = canonicalizeUri(record.sourceUri ?? '');
  try {
    const extracted = await extractKnowledgeArtifact(record, content.buffer);
    const extraction = await context.store.upsertExtraction({
      sourceId: input.sourceId,
      artifactId: input.artifactId,
      extractorId: extracted.extractorId,
      format: extracted.format,
      title: extracted.title,
      summary: extracted.summary,
      excerpt: extracted.excerpt,
      sections: extracted.sections,
      links: extracted.links,
      estimatedTokens: extracted.estimatedTokens,
      structure: extracted.structure,
      metadata: extracted.metadata,
    });
    context.emitIfReady((bus, ctx) => emitKnowledgeExtractionCompleted(bus, ctx, {
      sourceId: input.sourceId,
      extractionId: extraction.id,
      format: extraction.format,
      estimatedTokens: extraction.estimatedTokens,
    }), input.sessionId);

    const source = await context.store.upsertSource({
      id: input.sourceId,
      connectorId: input.connectorId,
      sourceType: input.sourceType,
      title: input.inputTitle?.trim() || extraction.title || record.filename,
      sourceUri: record.sourceUri,
      canonicalUri: canonicalUri ?? undefined,
      summary: extraction.summary,
      description: extraction.excerpt,
      tags: input.tags,
      folderPath: input.folderPath,
      status: 'indexed',
      artifactId: input.artifactId,
      contentHash: record.sha256,
      lastCrawledAt: Date.now(),
      sessionId: input.sessionId,
      metadata: {
        ...input.metadata,
        contentType: record.mimeType,
        extractionId: extraction.id,
        extractionFormat: extraction.format,
        outboundLinks: extraction.links,
      },
    });

    await compileKnowledgeSource(context, source, extraction);
    await context.syncReviewedMemory();
    return { source, artifactId: input.artifactId, extraction };
  } catch (error) {
    context.emitIfReady((bus, ctx) => emitKnowledgeExtractionFailed(bus, ctx, {
      sourceId: input.sourceId,
      error: error instanceof Error ? error.message : String(error),
    }), input.sessionId);
    throw error;
  }
}

export async function recompileKnowledgeSource(context: KnowledgeIngestContext, source: KnowledgeSourceRecord): Promise<void> {
  const extraction = source.id ? context.store.getExtractionBySourceId(source.id) : null;
  if (!extraction && source.artifactId) {
    const content = await context.artifactStore.readContent(source.artifactId);
    const extracted = await extractKnowledgeArtifact(content.record, content.buffer);
    await context.store.upsertExtraction({
      sourceId: source.id,
      artifactId: source.artifactId,
      extractorId: extracted.extractorId,
      format: extracted.format,
      title: extracted.title,
      summary: extracted.summary,
      excerpt: extracted.excerpt,
      sections: extracted.sections,
      links: extracted.links,
      estimatedTokens: extracted.estimatedTokens,
      structure: extracted.structure,
      metadata: extracted.metadata,
    });
  }
  await compileKnowledgeSource(context, context.store.getSource(source.id) ?? source, context.store.getExtractionBySourceId(source.id));
}

export async function compileKnowledgeSource(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction?: KnowledgeExtractionRecord | null,
): Promise<void> {
  const initialNodeCount = context.store.status().nodeCount;
  const initialEdgeCount = context.store.status().edgeCount;

  if (source.artifactId) {
    await context.store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'artifact',
      toId: source.artifactId,
      relation: 'snapshotted_as',
    });
  }

  const domain = source.canonicalUri ?? source.sourceUri;
  if (domain) {
    try {
      const hostname = new URL(domain).hostname.toLowerCase();
      const domainNode = await context.store.upsertNode({
        kind: 'domain',
        slug: slugify(hostname),
        title: hostname,
        summary: `Knowledge sources cataloged under ${hostname}.`,
        aliases: [hostname],
        metadata: { hostname },
      });
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: domainNode.id,
        relation: 'belongs_to_domain',
      });
    } catch {
      // invalid URLs are linted separately
    }
  }

  if (source.folderPath) {
    const segments = source.folderPath.split('/').map((entry) => entry.trim()).filter(Boolean);
    let previousNode: KnowledgeNodeRecord | null = null;
    let accumulated = '';
    for (const segment of segments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const folderNode = await context.store.upsertNode({
        kind: 'bookmark_folder',
        slug: slugify(accumulated),
        title: segment,
        summary: `Bookmark folder ${accumulated}.`,
        aliases: [accumulated],
        metadata: { folderPath: accumulated },
      });
      if (previousNode) {
        await context.store.upsertEdge({
          fromKind: 'node',
          fromId: previousNode.id,
          toKind: 'node',
          toId: folderNode.id,
          relation: 'contains_folder',
        });
      }
      previousNode = folderNode;
    }
    if (previousNode) {
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: previousNode.id,
        relation: 'cataloged_in_folder',
      });
    }
  }

  for (const tag of source.tags) {
    const topicNode = await context.store.upsertNode({
      kind: 'topic',
      slug: slugify(tag),
      title: tag,
      summary: `Topic tag ${tag}.`,
      aliases: [tag],
      metadata: { tag },
    });
    await context.store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: topicNode.id,
      relation: 'tagged_with',
    });
  }

  await compileKnowledgeStructuredEntityHints(context, source, extraction);

  if (extraction) {
    const tagSlugs = new Set(source.tags.map((tag) => slugify(tag)));
    for (const section of extraction.sections.slice(0, 12)) {
      if (tagSlugs.has(slugify(section))) continue;
      const topicNode = await context.store.upsertNode({
        kind: 'topic',
        slug: slugify(section),
        title: section,
        summary: `Compiled section or concept from source ${source.id}.`,
        aliases: [section],
        metadata: {
          sourceId: source.id,
          extractionId: extraction.id,
        },
      });
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: topicNode.id,
        relation: 'mentions_section',
      });
    }
    for (const outbound of extraction.links.slice(0, 24)) {
      const canonicalOutbound = canonicalizeUri(outbound);
      if (!canonicalOutbound) continue;
      const linked = context.store.getSourceByCanonicalUri(canonicalOutbound);
      if (!linked) continue;
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'source',
        toId: linked.id,
        relation: 'links_to_source',
      });
    }
  }

  if (source.sessionId) {
    await context.store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'session',
      toId: source.sessionId,
      relation: 'ingested_during',
    });
  }

  const finalStatus = context.store.status();
  context.emitIfReady((bus, ctx) => emitKnowledgeCompileCompleted(bus, ctx, {
    sourceId: source.id,
    nodeCount: Math.max(0, finalStatus.nodeCount - initialNodeCount),
    edgeCount: Math.max(0, finalStatus.edgeCount - initialEdgeCount),
  }), source.sessionId);
}

export async function compileKnowledgeStructuredEntityHints(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction?: KnowledgeExtractionRecord | null,
): Promise<void> {
  const metadata = source.metadata ?? {};
  const topicKeywords = topKeywords([
    source.title ?? '',
    source.summary ?? '',
    extraction?.summary ?? '',
    extraction?.sections.join(' ') ?? '',
  ].join(' '), 4);
  const entitySpecs: Array<{
    kind: KnowledgeNodeRecord['kind'];
    values: readonly string[];
    relation: string;
    summaryPrefix: string;
  }> = [
    {
      kind: 'project',
      values: mergeTags(
        extractTaggedValues(source.tags, ['project', 'proj']),
        readMetadataStrings(metadata, ['project', 'projects']),
      ),
      relation: 'belongs_to_project',
      summaryPrefix: 'Project',
    },
    {
      kind: 'capability',
      values: mergeTags(
        extractTaggedValues(source.tags, ['capability', 'feature']),
        readMetadataStrings(metadata, ['capability', 'capabilities', 'feature', 'features']),
      ),
      relation: 'documents_capability',
      summaryPrefix: 'Capability',
    },
    {
      kind: 'repo',
      values: mergeTags(
        extractTaggedValues(source.tags, ['repo', 'repository']),
        readMetadataStrings(metadata, ['repo', 'repository', 'repositories']),
        source.sourceType === 'repo' ? [source.title ?? source.sourceUri ?? source.id] : [],
      ),
      relation: 'references_repo',
      summaryPrefix: 'Repository',
    },
    {
      kind: 'provider',
      values: mergeTags(
        extractTaggedValues(source.tags, ['provider']),
        readMetadataStrings(metadata, ['provider', 'providers']),
      ),
      relation: 'references_provider',
      summaryPrefix: 'Provider',
    },
    {
      kind: 'service',
      values: mergeTags(
        extractTaggedValues(source.tags, ['service']),
        readMetadataStrings(metadata, ['service', 'services']),
      ),
      relation: 'references_service',
      summaryPrefix: 'Service',
    },
    {
      kind: 'environment',
      values: mergeTags(
        extractTaggedValues(source.tags, ['env', 'environment']),
        readMetadataStrings(metadata, ['env', 'environment', 'environments']),
      ),
      relation: 'references_environment',
      summaryPrefix: 'Environment',
    },
    {
      kind: 'user',
      values: mergeTags(
        extractTaggedValues(source.tags, ['user', 'owner']),
        readMetadataStrings(metadata, ['user', 'users', 'owner', 'owners']),
      ),
      relation: 'references_user',
      summaryPrefix: 'User',
    },
  ];

  for (const spec of entitySpecs) {
    for (const value of spec.values.slice(0, 8)) {
      const title = value.trim();
      if (!title) continue;
      const node = await context.store.upsertNode({
        kind: spec.kind,
        slug: slugify(title),
        title,
        summary: `${spec.summaryPrefix} entity compiled from structured knowledge sources.`,
        aliases: topicKeywords,
        metadata: {
          compiledFrom: source.id,
          tags: [...source.tags],
        },
      });
      await context.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: node.id,
        relation: spec.relation,
      });
    }
  }
}
