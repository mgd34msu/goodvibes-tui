import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  getNextAutomationOccurrence,
  normalizeCronSchedule,
  normalizeEverySchedule,
  type AutomationScheduleDefinition,
} from '../automation/schedules.ts';
import { ArtifactStore } from '../artifacts/index.ts';
import type { ArtifactDescriptor } from '../artifacts/types.ts';
import { getMemoryRegistry } from '../state/index.ts';
import type { MemoryClass, MemoryRecord, MemoryScope } from '../state/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { createDefaultKnowledgeConnectorRegistry, KnowledgeConnectorRegistry } from './connectors.ts';
import { KnowledgeProjectionService } from './projections.ts';
import { KnowledgeStore } from './store.ts';
import type {
  KnowledgeBatchIngestResult,
  KnowledgeBookmarkSeed,
  KnowledgeConnector,
  KnowledgeConnectorDoctorReport,
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeJobMode,
  KnowledgeJobRecord,
  KnowledgeJobRunRecord,
  KnowledgeMaterializedProjection,
  KnowledgeItemView,
  KnowledgeNodeRecord,
  KnowledgePacket,
  KnowledgePacketDetail,
  KnowledgePacketItem,
  KnowledgeProjectionBundle,
  KnowledgeProjectionTarget,
  KnowledgeProjectionTargetKind,
  KnowledgeScheduleRecord,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
  KnowledgeStatus,
  KnowledgeUsageRecord,
} from './types.ts';
import {
  buildKnowledgePacket,
  buildKnowledgePacketSync,
  buildKnowledgePromptPacket,
  buildKnowledgePromptPacketSync,
  searchKnowledge,
} from './packet.ts';
import {
  ingestKnowledgeArtifact,
  ingestKnowledgeBookmarkSeeds,
  ingestKnowledgeConnectorInput,
  ingestKnowledgeUrl,
  ingestKnowledgeWithConnector,
  importKnowledgeBookmarksFromFile,
  importKnowledgeUrlsFromFile,
  refreshKnowledgeSources,
  pickKnowledgeRefreshCandidates,
  finalizeKnowledgeIngestedSource,
  recompileKnowledgeSource,
  compileKnowledgeSource,
  compileKnowledgeStructuredEntityHints,
} from './ingest.ts';
import {
  decideKnowledgeConsolidationCandidate,
  refreshKnowledgeConsolidationCandidates,
  runKnowledgeConsolidation,
  syncReviewedKnowledgeMemory,
} from './consolidation.ts';
import { KnowledgeScheduleService } from './scheduling.ts';
import { lintKnowledgeStore } from './lint.ts';
import {
  emitKnowledgeCompileCompleted,
  emitKnowledgeExtractionCompleted,
  emitKnowledgeExtractionFailed,
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
  emitKnowledgeJobCompleted,
  emitKnowledgeJobFailed,
  emitKnowledgeJobQueued,
  emitKnowledgeJobStarted,
  emitKnowledgePacketBuilt,
  emitKnowledgeProjectionMaterialized,
  emitKnowledgeProjectionRendered,
} from '../runtime/emitters/index.ts';
import { extractKnowledgeArtifact } from './extractors.ts';
import {
  canonicalizeUri as internalCanonicalizeUri,
  coerceStringArray as internalCoerceStringArray,
  DAY_MS as internalDayMs,
  DEFAULT_PACKET_BUDGET as internalDefaultPacketBudget,
  DEFAULT_PACKET_LIMIT as internalDefaultPacketLimit,
  DEEP_CONSOLIDATION_AUTOPROMOTE_THRESHOLD as internalDeepConsolidationAutoPromoteThreshold,
  estimateTokens as internalEstimateTokens,
  extractTaggedValues as internalExtractTaggedValues,
  inferSourceTypeFromArtifact as internalInferSourceTypeFromArtifact,
  isHttpUri as internalIsHttpUri,
  LINT_NAMESPACE as internalLintNamespace,
  LIGHT_CONSOLIDATION_THRESHOLD as internalLightConsolidationThreshold,
  mergeTags as internalMergeTags,
  readMetadataStrings as internalReadMetadataStrings,
  renderPacket as internalRenderPacket,
  scoreHaystack as internalScoreHaystack,
  slugify as internalSlugify,
  summarizeCompact as internalSummarizeCompact,
  tokenize as internalTokenize,
  topKeywords as internalTopKeywords,
  trimForDetail as internalTrimForDetail,
  usageWindowCutoff as internalUsageWindowCutoff,
} from './internal.ts';

const LINT_NAMESPACE = 'knowledge-lint';
const DEFAULT_PACKET_LIMIT = 6;
const DEFAULT_PACKET_BUDGET: Record<KnowledgePacketDetail, number> = {
  compact: 320,
  standard: 720,
  detailed: 1400,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_REFRESH_WINDOWS_MS: Record<string, number> = {
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
};
const LIGHT_CONSOLIDATION_THRESHOLD = 45;
const DEEP_CONSOLIDATION_AUTOPROMOTE_THRESHOLD = 72;

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function canonicalizeUri(input: string): string | null {
  try {
    const url = new URL(input);
    url.hash = '';
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !/^utm_/i.test(key) && key !== 'gclid' && key !== 'fbclid' && key !== 'ref')
      .sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [key, value] of params) {
      url.searchParams.append(key, value);
    }
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return null;
  }
}

function mergeTags(...groups: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const entry of group ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function scoreHaystack(haystack: string, taskTokens: readonly string[], scopeTokens: readonly string[]): { score: number; reason: string } {
  let score = 0;
  let reason = 'matched general knowledge index';
  for (const token of taskTokens) {
    if (haystack.includes(token)) {
      score += 25;
      reason = `matched task token "${token}"`;
    }
  }
  for (const token of scopeTokens) {
    if (haystack.includes(token)) {
      score += 18;
      reason = `matched write scope "${token}"`;
    }
  }
  return { score, reason };
}

function estimateTokens(...chunks: Array<string | undefined>): number {
  const total = chunks.reduce((sum, chunk) => sum + (chunk?.length ?? 0), 0);
  return Math.max(1, Math.ceil(total / 4));
}

function trimForDetail(value: string | undefined, detail: KnowledgePacketDetail): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const maxLength = detail === 'compact' ? 140 : detail === 'standard' ? 260 : 420;
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1).trim()}…`;
}

function renderPacket(items: readonly KnowledgePacketItem[], packet: Pick<KnowledgePacket, 'detail' | 'budgetLimit' | 'estimatedTokens' | 'strategy'>): string | null {
  if (items.length === 0) return null;
  const lines = [
    '## Curated Project Knowledge',
    `Packet detail: ${packet.detail} | estimated tokens: ${packet.estimatedTokens}/${packet.budgetLimit} | strategy: ${packet.strategy}`,
    'The runtime selected these structured knowledge records for this task. Prefer them over re-discovering the same context.',
  ];
  for (const item of items) {
    const related = item.related.length > 0 ? ` | related: ${item.related.join(', ')}` : '';
    const uri = item.uri ? ` | ${item.uri}` : '';
    const evidence = item.evidence.length > 0 ? ` | evidence: ${item.evidence.join(' ; ')}` : '';
    lines.push(`- [${item.id}] (${item.kind}) ${item.title}${uri} — ${item.summary ?? 'no summary'} — ${item.reason}${related}${evidence}`);
  }
  return lines.join('\n');
}

function inferSourceTypeFromArtifact(artifact: ArtifactDescriptor): KnowledgeSourceType {
  switch (artifact.kind) {
    case 'document':
      return 'document';
    case 'data':
      return 'dataset';
    case 'image':
      return 'image';
    default:
      return 'other';
  }
}

function isHttpUri(value: string | undefined): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function summarizeCompact(value: string | undefined, maxLength = 220): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trim()}…`;
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function topKeywords(input: string, limit = 6): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(input)) {
    if (token.length < 3) continue;
    if (/^(https?|www|com|org|net|the|and|for|with|from|this|that|into|over)$/.test(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, limit))
    .map(([token]) => token);
}

function readMetadataStrings(metadata: Record<string, unknown>, keys: readonly string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    values.push(...coerceStringArray(metadata[key]));
  }
  return mergeTags(values);
}

function extractTaggedValues(tags: readonly string[], prefixes: readonly string[]): string[] {
  const values: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim();
    if (!normalized) continue;
    const separatorIndex = normalized.indexOf(':');
    if (separatorIndex <= 0) continue;
    const prefix = normalized.slice(0, separatorIndex).trim().toLowerCase();
    if (!prefixes.includes(prefix)) continue;
    const value = normalized.slice(separatorIndex + 1).trim();
    if (value) values.push(value);
  }
  return mergeTags(values);
}

function usageWindowCutoff(days = 30): number {
  return Date.now() - (days * DAY_MS);
}

export interface KnowledgeServiceConfig {
  readonly configManager?: {
    getControlPlaneConfigDir?: () => string;
  };
  readonly runtimeBus?: RuntimeEventBus | null;
}

export interface KnowledgeServiceStatus extends KnowledgeStatus {
  readonly note: string;
}

export class KnowledgeService {
  private static active: KnowledgeService | null = null;

  private readonly projectionService: KnowledgeProjectionService;
  private readonly scheduleService: KnowledgeScheduleService;
  private runtimeBus: RuntimeEventBus | null;
  private readonly jobs: readonly KnowledgeJobRecord[];
  private readonly scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private schedulesInitialized = false;

  constructor(
    private readonly store = KnowledgeStore.getActive(),
    private readonly artifactStore = ArtifactStore.getActive(),
    private readonly connectorRegistry = createDefaultKnowledgeConnectorRegistry(),
    options: { readonly runtimeBus?: RuntimeEventBus | null } = {},
  ) {
    this.runtimeBus = options.runtimeBus ?? null;
    void this.store.init();
    this.projectionService = new KnowledgeProjectionService(this.store, this.artifactStore, {
      connectors: () => this.listConnectors(),
    });
    this.jobs = [
      {
        id: 'knowledge-lint',
        kind: 'lint',
        title: 'Lint Knowledge Store',
        description: 'Run knowledge health checks and refresh the issue queue.',
        defaultMode: 'inline',
        metadata: { category: 'quality' },
      },
      {
        id: 'knowledge-reindex',
        kind: 'reindex',
        title: 'Reindex Knowledge',
        description: 'Re-run compile and memory mirroring across the current store.',
        defaultMode: 'background',
        metadata: { category: 'maintenance' },
      },
      {
        id: 'knowledge-refresh-stale',
        kind: 'refresh-stale',
        title: 'Refresh Stale Sources',
        description: 'Recrawl stale, failed, or aging remote sources.',
        defaultMode: 'background',
        metadata: { category: 'maintenance' },
      },
      {
        id: 'knowledge-refresh-bookmarks',
        kind: 'refresh-bookmarks',
        title: 'Refresh Bookmarks',
        description: 'Recrawl bookmark and URL-list sources to refresh summaries and links.',
        defaultMode: 'background',
        metadata: { category: 'maintenance' },
      },
      {
        id: 'knowledge-rebuild-projections',
        kind: 'rebuild-projections',
        title: 'Rebuild Projections',
        description: 'Render and materialize the major derived markdown/wiki projections.',
        defaultMode: 'background',
        metadata: { category: 'projection' },
      },
      {
        id: 'knowledge-light-consolidation',
        kind: 'light-consolidation',
        title: 'Light Consolidation',
        description: 'Score recent usage, refresh candidate promotions, and write a deterministic consolidation report.',
        defaultMode: 'background',
        metadata: { category: 'consolidation' },
      },
      {
        id: 'knowledge-deep-consolidation',
        kind: 'deep-consolidation',
        title: 'Deep Consolidation',
        description: 'Run the full consolidation loop, including high-confidence memory promotion and deterministic reporting.',
        defaultMode: 'background',
        metadata: { category: 'consolidation' },
      },
    ];
    this.scheduleService = new KnowledgeScheduleService({
      store: this.store,
      emitIfReady: this.emitIfReady.bind(this),
      runJobByKind: this.runJobByKind.bind(this),
    });
    KnowledgeService.active = this;
  }

  private getIngestContext() {
    return {
      store: this.store,
      artifactStore: this.artifactStore,
      connectorRegistry: this.connectorRegistry,
      emitIfReady: this.emitIfReady.bind(this),
      syncReviewedMemory: this.syncReviewedMemory.bind(this),
      lint: this.lint.bind(this),
      listConnectors: () => this.listConnectors(),
    };
  }

  private getPacketContext() {
    return {
      store: this.store,
      deferUsage: this.deferUsage.bind(this),
      emitIfReady: this.emitIfReady.bind(this),
    };
  }

  private getConsolidationContext() {
    return {
      store: this.store,
      syncReviewedMemory: this.syncReviewedMemory.bind(this),
    };
  }

  static getActive(config: KnowledgeServiceConfig = {}): KnowledgeService {
    const store = KnowledgeStore.getActive({ configManager: config.configManager });
    const artifacts = ArtifactStore.getActive({ configManager: config.configManager });
    if (!KnowledgeService.active || KnowledgeService.active.store.storagePath !== store.storagePath) {
      KnowledgeService.active?.dispose();
      KnowledgeService.active = new KnowledgeService(store, artifacts, createDefaultKnowledgeConnectorRegistry(), {
        runtimeBus: config.runtimeBus ?? null,
      });
    } else if (config.runtimeBus) {
      KnowledgeService.active.attachRuntimeBus(config.runtimeBus);
    }
    return KnowledgeService.active;
  }

  static resetActiveForTesting(): void {
    KnowledgeService.active?.dispose();
    KnowledgeService.active = null;
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null | undefined): void {
    if (runtimeBus) this.runtimeBus = runtimeBus;
  }

  async getStatus(): Promise<KnowledgeServiceStatus> {
    await this.store.init();
    return {
      ...this.store.status(),
      note: 'Structured knowledge uses SQL-backed sources, nodes, edges, issues, extractions, and job runs. Markdown is an optional projection, not the source of truth.',
    };
  }

  listUsageRecords(
    limit = 100,
    input: {
      readonly targetKind?: KnowledgeUsageRecord['targetKind'];
      readonly targetId?: string;
      readonly usageKind?: KnowledgeUsageRecord['usageKind'];
    } = {},
  ): readonly KnowledgeUsageRecord[] {
    return this.store.listUsageRecords(limit, input);
  }

  listConsolidationCandidates(
    limit = 100,
    input: {
      readonly status?: KnowledgeConsolidationCandidateRecord['status'];
      readonly subjectKind?: KnowledgeConsolidationCandidateRecord['subjectKind'];
      readonly subjectId?: string;
    } = {},
  ): readonly KnowledgeConsolidationCandidateRecord[] {
    return this.store.listConsolidationCandidates(limit, input);
  }

  getConsolidationCandidate(id: string): KnowledgeConsolidationCandidateRecord | null {
    return this.store.getConsolidationCandidate(id);
  }

  listConsolidationReports(limit = 100): readonly KnowledgeConsolidationReportRecord[] {
    return this.store.listConsolidationReports(limit);
  }

  getConsolidationReport(id: string): KnowledgeConsolidationReportRecord | null {
    return this.store.getConsolidationReport(id);
  }

  listSchedules(limit = 100): readonly KnowledgeScheduleRecord[] {
    return this.store.listSchedules(limit);
  }

  getSchedule(id: string): KnowledgeScheduleRecord | null {
    return this.store.getSchedule(id);
  }

  listSources(limit = 100): KnowledgeSourceRecord[] {
    return this.store.listSources(limit);
  }

  querySources(input: {
    readonly limit?: number;
    readonly offset?: number;
    readonly status?: string;
    readonly connectorId?: string;
    readonly sourceType?: string;
    readonly tag?: string;
    readonly query?: string;
  } = {}): { total: number; items: KnowledgeSourceRecord[] } {
    const limit = Math.max(1, input.limit ?? 100);
    const offset = Math.max(0, input.offset ?? 0);
    const queryTokens = tokenize(input.query ?? '');
    const items = this.store.listSources(10_000).filter((source) => {
      if (input.status && source.status !== input.status) return false;
      if (input.connectorId && source.connectorId !== input.connectorId) return false;
      if (input.sourceType && source.sourceType !== input.sourceType) return false;
      if (input.tag && !source.tags.includes(input.tag)) return false;
      if (queryTokens.length === 0) return true;
      const extraction = this.store.getExtractionBySourceId(source.id);
      const haystack = [
        source.title ?? '',
        source.summary ?? '',
        source.description ?? '',
        source.sourceUri ?? '',
        source.canonicalUri ?? '',
        source.folderPath ?? '',
        source.tags.join(' '),
        extraction?.summary ?? '',
        extraction?.excerpt ?? '',
        extraction?.sections.join(' ') ?? '',
      ].join(' ').toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    });
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
    };
  }

  listNodes(limit = 100): KnowledgeNodeRecord[] {
    return this.store.listNodes(limit);
  }

  queryNodes(input: {
    readonly limit?: number;
    readonly offset?: number;
    readonly kind?: string;
    readonly status?: string;
    readonly query?: string;
  } = {}): { total: number; items: KnowledgeNodeRecord[] } {
    const limit = Math.max(1, input.limit ?? 100);
    const offset = Math.max(0, input.offset ?? 0);
    const queryTokens = tokenize(input.query ?? '');
    const items = this.store.listNodes(10_000).filter((node) => {
      if (input.kind && node.kind !== input.kind) return false;
      if (input.status && node.status !== input.status) return false;
      if (queryTokens.length === 0) return true;
      const haystack = [
        node.title,
        node.summary ?? '',
        node.aliases.join(' '),
        JSON.stringify(node.metadata),
      ].join(' ').toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    });
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
    };
  }

  listIssues(limit = 100): KnowledgeIssueRecord[] {
    return this.store.listIssues(limit);
  }

  queryIssues(input: {
    readonly limit?: number;
    readonly offset?: number;
    readonly severity?: string;
    readonly status?: string;
    readonly code?: string;
    readonly query?: string;
  } = {}): { total: number; items: KnowledgeIssueRecord[] } {
    const limit = Math.max(1, input.limit ?? 100);
    const offset = Math.max(0, input.offset ?? 0);
    const queryTokens = tokenize(input.query ?? '');
    const items = this.store.listIssues(10_000).filter((issue) => {
      if (input.severity && issue.severity !== input.severity) return false;
      if (input.status && issue.status !== input.status) return false;
      if (input.code && issue.code !== input.code) return false;
      if (queryTokens.length === 0) return true;
      const haystack = [issue.message, issue.code, JSON.stringify(issue.metadata)].join(' ').toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    });
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
    };
  }

  listExtractions(limit = 100, sourceId?: string): KnowledgeExtractionRecord[] {
    const records = this.store.listExtractions(sourceId ? 10_000 : limit);
    return sourceId ? records.filter((entry) => entry.sourceId === sourceId).slice(0, Math.max(1, limit)) : records;
  }

  getExtraction(id: string): KnowledgeExtractionRecord | null {
    return this.store.getExtraction(id);
  }

  getSourceExtraction(sourceId: string): KnowledgeExtractionRecord | null {
    return this.store.getExtractionBySourceId(sourceId);
  }

  listConnectors(): readonly KnowledgeConnector[] {
    return this.connectorRegistry.list();
  }

  getConnector(id: string): KnowledgeConnector | null {
    return this.connectorRegistry.get(id) ?? null;
  }

  async doctorConnector(id: string): Promise<KnowledgeConnectorDoctorReport | null> {
    return this.connectorRegistry.doctor(id);
  }

  registerConnector(connector: KnowledgeConnector, options: { replace?: boolean } = {}): void {
    this.connectorRegistry.register(connector, options);
  }

  getItem(id: string): KnowledgeItemView | null {
    const item = this.store.getItem(id);
    if (item?.source) this.deferUsage({ targetKind: 'source', targetId: item.source.id, usageKind: 'item-open' });
    if (item?.node) this.deferUsage({ targetKind: 'node', targetId: item.node.id, usageKind: 'item-open' });
    if (item?.issue) this.deferUsage({ targetKind: 'issue', targetId: item.issue.id, usageKind: 'item-open' });
    return item;
  }

  getItems(ids: readonly string[]): KnowledgeItemView[] {
    return ids.map((id) => this.getItem(id)).filter((item): item is KnowledgeItemView => Boolean(item));
  }

  async recordUsage(input: {
    readonly targetKind: KnowledgeUsageRecord['targetKind'];
    readonly targetId: string;
    readonly usageKind: KnowledgeUsageRecord['usageKind'];
    readonly task?: string;
    readonly sessionId?: string;
    readonly score?: number;
    readonly metadata?: Record<string, unknown>;
  }): Promise<KnowledgeUsageRecord> {
    await this.store.init();
    return this.store.upsertUsageRecord(input);
  }

  getNeighbors(
    kind: 'source' | 'node',
    id: string,
    input: { readonly relation?: string; readonly limit?: number } = {},
  ): {
    readonly edges: readonly KnowledgeEdgeRecord[];
    readonly sources: readonly KnowledgeSourceRecord[];
    readonly nodes: readonly KnowledgeNodeRecord[];
  } {
    const limit = Math.max(1, input.limit ?? 20);
    const edges = this.store.edgesFor(kind, id)
      .filter((edge) => !input.relation || edge.relation === input.relation)
      .slice(0, limit);
    this.deferUsage({
      targetKind: kind,
      targetId: id,
      usageKind: 'neighbor-open',
      metadata: input.relation ? { relation: input.relation } : {},
    });
    const sources: KnowledgeSourceRecord[] = [];
    const nodes: KnowledgeNodeRecord[] = [];
    for (const edge of edges) {
      const otherKind = edge.fromKind === kind && edge.fromId === id ? edge.toKind : edge.fromKind;
      const otherId = edge.fromKind === kind && edge.fromId === id ? edge.toId : edge.fromId;
      if (otherKind === 'source') {
        const source = this.store.getSource(otherId);
        if (source) sources.push(source);
      } else if (otherKind === 'node') {
        const node = this.store.getNode(otherId);
        if (node) nodes.push(node);
      }
    }
    return { edges, sources, nodes };
  }

  async ingestUrl(input: {
    readonly url: string;
    readonly title?: string;
    readonly tags?: readonly string[];
    readonly folderPath?: string;
    readonly sessionId?: string;
    readonly sourceType?: KnowledgeSourceType;
    readonly connectorId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
    return ingestKnowledgeUrl(this.getIngestContext(), input);
  }

  async ingestArtifact(input: {
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
  }): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
    return ingestKnowledgeArtifact(this.getIngestContext(), input);
  }

  async importBookmarksFromFile(input: {
    readonly path: string;
    readonly sessionId?: string;
  }): Promise<KnowledgeBatchIngestResult> {
    return importKnowledgeBookmarksFromFile(this.getIngestContext(), input);
  }

  async importUrlsFromFile(input: {
    readonly path: string;
    readonly sessionId?: string;
  }): Promise<KnowledgeBatchIngestResult> {
    return importKnowledgeUrlsFromFile(this.getIngestContext(), input);
  }

  async ingestBookmarkSeeds(
    seeds: readonly KnowledgeBookmarkSeed[],
    sessionId?: string,
    sourceType: KnowledgeSourceType = 'bookmark',
    connectorId = 'bookmark',
  ): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeBookmarkSeeds(this.getIngestContext(), seeds, sessionId, sourceType, connectorId);
  }

  async ingestWithConnector(
    connectorId: string,
    input: unknown,
    sessionId?: string,
  ): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeWithConnector(this.getIngestContext(), connectorId, input, sessionId);
  }

  async ingestConnectorInput(input: {
    readonly connectorId: string;
    readonly input?: unknown;
    readonly content?: string;
    readonly path?: string;
    readonly sessionId?: string;
  }): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeConnectorInput(this.getIngestContext(), input);
  }

  async listProjectionTargets(limit = 25): Promise<KnowledgeProjectionTarget[]> {
    return this.projectionService.listTargets(limit);
  }

  async renderProjection(input: {
    readonly kind: KnowledgeProjectionTargetKind;
    readonly id?: string;
    readonly limit?: number;
  }): Promise<KnowledgeProjectionBundle> {
    const bundle = await this.projectionService.render(input);
    this.emitIfReady((bus, ctx) => emitKnowledgeProjectionRendered(bus, ctx, {
      targetId: bundle.target.targetId,
      pageCount: bundle.pageCount,
    }));
    return bundle;
  }

  async materializeProjection(input: {
    readonly kind: KnowledgeProjectionTargetKind;
    readonly id?: string;
    readonly limit?: number;
    readonly filename?: string;
  }): Promise<KnowledgeMaterializedProjection> {
    const materialized = await this.projectionService.materialize(input);
    this.emitIfReady((bus, ctx) => emitKnowledgeProjectionMaterialized(bus, ctx, {
      targetId: materialized.bundle.target.targetId,
      artifactId: materialized.artifact.id,
      pageCount: materialized.bundle.pageCount,
    }));
    return materialized;
  }

  async reindex(): Promise<{ status: KnowledgeStatus; issues: readonly KnowledgeIssueRecord[] }> {
    await this.store.init();
    for (const source of this.store.listSources(10_000)) {
      await recompileKnowledgeSource(this.getIngestContext(), source);
    }
    await syncReviewedKnowledgeMemory(this.getConsolidationContext());
    const issues = await lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) });
    return { status: this.store.status(), issues };
  }

  search(query: string, limit = 10): KnowledgeSearchResult[] {
    return searchKnowledge(this.getPacketContext(), query, limit);
  }

  async buildPacket(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
  ): Promise<KnowledgePacket> {
    return buildKnowledgePacket(this.getPacketContext(), task, writeScope, limit, options);
  }

  buildPacketSync(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
  ): KnowledgePacket | null {
    return buildKnowledgePacketSync(this.getPacketContext(), task, writeScope, limit, options);
  }

  buildPromptPacketSync(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
  ): string | null {
    return buildKnowledgePromptPacketSync(this.getPacketContext(), task, writeScope, limit, options);
  }

  async buildPromptPacket(
    task: string,
    writeScope: readonly string[] = [],
    limit = DEFAULT_PACKET_LIMIT,
    options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
  ): Promise<string | null> {
    return buildKnowledgePromptPacket(this.getPacketContext(), task, writeScope, limit, options);
  }

  listJobs(): readonly KnowledgeJobRecord[] {
    return this.scheduleService.listJobs();
  }

  getJob(id: string): KnowledgeJobRecord | null {
    return this.scheduleService.getJob(id);
  }

  async saveSchedule(input: {
    readonly id?: string;
    readonly jobId: string;
    readonly label?: string;
    readonly enabled?: boolean;
    readonly schedule: AutomationScheduleDefinition;
    readonly metadata?: Record<string, unknown>;
  }): Promise<KnowledgeScheduleRecord> {
    return this.scheduleService.saveSchedule(input);
  }

  async deleteSchedule(id: string): Promise<boolean> {
    return this.scheduleService.deleteSchedule(id);
  }

  async setScheduleEnabled(id: string, enabled: boolean): Promise<KnowledgeScheduleRecord | null> {
    return this.scheduleService.setScheduleEnabled(id, enabled);
  }

  async decideConsolidationCandidate(
    id: string,
    decision: 'accept' | 'reject' | 'supersede',
    input: {
      readonly decidedBy?: string;
      readonly memoryClass?: string;
      readonly scope?: string;
      readonly detail?: string;
    } = {},
  ): Promise<KnowledgeConsolidationCandidateRecord> {
    return decideKnowledgeConsolidationCandidate(this.getConsolidationContext(), id, decision, input);
  }

  listJobRuns(limit = 100, jobId?: string): readonly KnowledgeJobRunRecord[] {
    return this.scheduleService.listJobRuns(limit, jobId);
  }

  async runJob(
    id: string,
    input: {
      readonly mode?: KnowledgeJobMode;
      readonly sourceIds?: readonly string[];
      readonly limit?: number;
    } = {},
  ): Promise<KnowledgeJobRunRecord> {
    return this.scheduleService.runJob(id, input);
  }

  private async executeJobRun(
    job: KnowledgeJobRecord,
    runId: string,
    input: { readonly sourceIds?: readonly string[]; readonly limit?: number; readonly mode?: KnowledgeJobMode },
  ): Promise<KnowledgeJobRunRecord> {
    const startedAt = Date.now();
    let run = await this.store.upsertJobRun({
      id: runId,
      jobId: job.id,
      status: 'running',
      mode: input.mode ?? job.defaultMode,
      startedAt,
    });
    this.emitIfReady((bus, ctx) => emitKnowledgeJobStarted(bus, ctx, {
      jobId: job.id,
      runId: run.id,
      mode: run.mode,
    }));
    try {
      const result = await this.runJobByKind(job.kind, input);
      const completedAt = Date.now();
      run = await this.store.upsertJobRun({
        id: run.id,
        jobId: run.jobId,
        status: 'completed',
        mode: run.mode,
        requestedAt: run.requestedAt,
        startedAt,
        completedAt,
        result,
      });
      this.emitIfReady((bus, ctx) => emitKnowledgeJobCompleted(bus, ctx, {
        jobId: job.id,
        runId: run.id,
        durationMs: completedAt - startedAt,
      }));
      return run;
    } catch (error) {
      const completedAt = Date.now();
      run = await this.store.upsertJobRun({
        id: run.id,
        jobId: run.jobId,
        status: 'failed',
        mode: run.mode,
        requestedAt: run.requestedAt,
        startedAt,
        completedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      this.emitIfReady((bus, ctx) => emitKnowledgeJobFailed(bus, ctx, {
        jobId: job.id,
        runId: run.id,
        error: run.error ?? 'Knowledge job failed.',
        durationMs: completedAt - startedAt,
      }));
      return run;
    }
  }

  private async runJobByKind(
    kind: KnowledgeJobRecord['kind'],
    input: { readonly sourceIds?: readonly string[]; readonly limit?: number },
  ): Promise<Record<string, unknown>> {
    switch (kind) {
      case 'lint': {
        const issues = await lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) });
        return { issueCount: issues.length };
      }
      case 'reindex': {
        const result = await this.reindex();
        return { sourceCount: result.status.sourceCount, issueCount: result.issues.length };
      }
      case 'refresh-stale': {
        const refreshed = await refreshKnowledgeSources(
          this.getIngestContext(),
          pickKnowledgeRefreshCandidates({ store: this.store }, 'stale', input.sourceIds, input.limit),
        );
        return { refreshed };
      }
      case 'refresh-bookmarks': {
        const refreshed = await refreshKnowledgeSources(
          this.getIngestContext(),
          pickKnowledgeRefreshCandidates({ store: this.store }, 'bookmark', input.sourceIds, input.limit),
        );
        return { refreshed };
      }
      case 'rebuild-projections': {
        const overview = await this.materializeProjection({ kind: 'overview', limit: Math.max(8, input.limit ?? 12) });
        const bundle = await this.materializeProjection({ kind: 'bundle', limit: Math.max(12, input.limit ?? 18) });
        return {
          projections: [
            { targetId: overview.bundle.target.targetId, artifactId: overview.artifact.id },
            { targetId: bundle.bundle.target.targetId, artifactId: bundle.artifact.id },
          ],
        };
      }
      case 'light-consolidation': {
        const report = await runKnowledgeConsolidation(this.getConsolidationContext(), 'light-consolidation', {
          limit: input.limit,
          autoPromote: false,
        });
        return { reportId: report.id, metrics: report.metrics };
      }
      case 'deep-consolidation': {
        const report = await runKnowledgeConsolidation(this.getConsolidationContext(), 'deep-consolidation', {
          limit: input.limit,
          autoPromote: true,
        });
        return { reportId: report.id, metrics: report.metrics };
      }
      default:
        return {};
    }
  }

  private pickRefreshCandidates(
    mode: 'stale' | 'bookmark',
    explicitIds: readonly string[] | undefined,
    limit = 25,
  ): KnowledgeSourceRecord[] {
    const max = Math.max(1, limit);
    let sources = this.store.listSources(10_000);
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
        || this.isSourcePastRefreshWindow(source)
      ));
    }
    return sources.filter((source) => isHttpUri(source.sourceUri)).slice(0, max);
  }

  private async refreshSources(sources: readonly KnowledgeSourceRecord[]): Promise<number> {
    let refreshed = 0;
    for (const source of sources) {
      const result = await this.ingestUrl({
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

  private buildPacketFromCurrentState(
    task: string,
    writeScope: readonly string[],
    limit: number,
  options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number },
  ): KnowledgePacket {
    const detail = options.detail ?? 'standard';
    const budgetLimit = Math.max(80, options.budgetLimit ?? DEFAULT_PACKET_BUDGET[detail]);
    const taskTokens = tokenize(task);
    const scopeTokens = writeScope.flatMap((entry) => tokenize(entry));
    const usageStats = this.buildUsageStats();
    const candidates: Array<{ score: number; item: KnowledgePacketItem }> = [];

    for (const source of this.store.listSources(10_000)) {
      const extraction = this.store.getExtractionBySourceId(source.id);
      const haystack = [
        source.title ?? '',
        source.summary ?? '',
        source.description ?? '',
        source.sourceUri ?? '',
        source.canonicalUri ?? '',
        source.folderPath ?? '',
        source.tags.join(' '),
        extraction?.summary ?? '',
        extraction?.excerpt ?? '',
        extraction?.sections.join(' ') ?? '',
      ].join(' ').toLowerCase();
      const scored = scoreHaystack(haystack, taskTokens, scopeTokens);
      if (scored.score <= 0) continue;
      const evidence = detail === 'compact'
        ? []
        : (extraction?.sections.slice(0, detail === 'detailed' ? 4 : 2) ?? []);
      const summary = trimForDetail(extraction?.summary ?? source.summary ?? source.description, detail);
      const relationLabels = this.collectRelatedLabels('source', source.id);
      const usageBoost = this.scoreUsageBoost(usageStats.get(`source:${source.id}`));
      const relationBoost = Math.min(18, relationLabels.length * 3);
      const freshnessBoost = this.isSourcePastRefreshWindow(source) ? -8 : 6;
      const item: KnowledgePacketItem = {
        kind: 'source',
        id: source.id,
        title: source.title ?? source.canonicalUri ?? source.sourceUri ?? source.id,
        summary,
        uri: source.canonicalUri ?? source.sourceUri,
        reason: scored.reason,
        score: scored.score + (source.status === 'indexed' ? 8 : 0) + (extraction ? 6 : 0) + usageBoost + relationBoost + freshnessBoost,
        estimatedTokens: estimateTokens(summary, extraction?.excerpt, evidence.join(' ')),
        related: relationLabels,
        evidence,
        metadata: {
          sourceType: source.sourceType,
          status: source.status,
          extractionFormat: extraction?.format,
          usageCount: usageStats.get(`source:${source.id}`)?.count ?? 0,
        },
      };
      candidates.push({ score: item.score, item });
    }

    for (const node of this.store.listNodes(10_000)) {
      const haystack = [
        node.title,
        node.summary ?? '',
        node.aliases.join(' '),
        JSON.stringify(node.metadata),
      ].join(' ').toLowerCase();
      const scored = scoreHaystack(haystack, taskTokens, scopeTokens);
      if (scored.score <= 0) continue;
      const related = this.collectRelatedLabels('node', node.id);
      const usageBoost = this.scoreUsageBoost(usageStats.get(`node:${node.id}`));
      const relationBoost = Math.min(20, this.store.edgesFor('node', node.id).length * 2);
      const kindBoost = this.nodeKindBoost(node.kind);
      const evidence = detail === 'compact' ? related.slice(0, 1) : related.slice(0, detail === 'detailed' ? 4 : 2);
      const summary = trimForDetail(node.summary, detail);
      const item: KnowledgePacketItem = {
        kind: 'node',
        id: node.id,
        title: node.title,
        summary,
        reason: scored.reason,
        score: scored.score + usageBoost + relationBoost + kindBoost,
        estimatedTokens: estimateTokens(summary, evidence.join(' ')),
        related,
        evidence,
        metadata: {
          kind: node.kind,
          status: node.status,
          usageCount: usageStats.get(`node:${node.id}`)?.count ?? 0,
        },
      };
      candidates.push({ score: item.score, item });
    }

    const items: KnowledgePacketItem[] = [];
    let estimatedTokens = 0;
    for (const candidate of candidates
      .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
      .slice(0, Math.max(1, limit * 4))) {
      if (items.length >= Math.max(1, limit)) break;
      if (estimatedTokens + candidate.item.estimatedTokens > budgetLimit && items.length > 0) continue;
      items.push(candidate.item);
      estimatedTokens += candidate.item.estimatedTokens;
    }
    const packet: KnowledgePacket = {
      task,
      writeScope: [...writeScope],
      generatedAt: Date.now(),
      detail,
      strategy: 'graph-ranked extraction-aware packet',
      budgetLimit,
      estimatedTokens,
      items,
    };
    for (const item of items) {
      this.deferUsage({
        targetKind: item.kind,
        targetId: item.id,
        usageKind: 'packet-item',
        task,
        score: item.score,
        metadata: {
          detail,
          writeScope: [...writeScope],
        },
      });
    }
    this.emitIfReady((bus, ctx) => emitKnowledgePacketBuilt(bus, ctx, {
      task,
      itemCount: items.length,
      estimatedTokens,
      detail,
    }));
    return packet;
  }

  private collectRelatedLabels(kind: 'source' | 'node', id: string): string[] {
    const related = this.store.edgesFor(kind, id);
    const labels: string[] = [];
    for (const edge of related) {
      const otherKind = edge.fromKind === kind && edge.fromId === id ? edge.toKind : edge.fromKind;
      const otherId = edge.fromKind === kind && edge.fromId === id ? edge.toId : edge.fromId;
      if (otherKind === 'node') {
        const node = this.store.getNode(otherId);
        if (node) labels.push(node.title);
      } else if (otherKind === 'source') {
        const source = this.store.getSource(otherId);
        if (source) labels.push(source.title ?? source.canonicalUri ?? source.id);
      }
    }
    return [...new Set(labels)].slice(0, 8);
  }

  private async finalizeIngestedSource(input: {
    readonly sourceId: string;
    readonly artifactId: string;
    readonly inputTitle?: string;
    readonly sourceType: KnowledgeSourceType;
    readonly connectorId: string;
    readonly tags: readonly string[];
    readonly folderPath?: string;
    readonly sessionId?: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<{ source: KnowledgeSourceRecord; artifactId: string; extraction: KnowledgeExtractionRecord }> {
    const content = await this.artifactStore.readContent(input.artifactId);
    const record = content.record;
    const canonicalUri = canonicalizeUri(record.sourceUri ?? '');
    try {
      const extracted = await extractKnowledgeArtifact(record, content.buffer);
      const extraction = await this.store.upsertExtraction({
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
      this.emitIfReady((bus, ctx) => emitKnowledgeExtractionCompleted(bus, ctx, {
        sourceId: input.sourceId,
        extractionId: extraction.id,
        format: extraction.format,
        estimatedTokens: extraction.estimatedTokens,
      }), input.sessionId);

      const source = await this.store.upsertSource({
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

      await this.compileSource(source, extraction);
      await this.syncReviewedMemory();
      return { source, artifactId: input.artifactId, extraction };
    } catch (error) {
      this.emitIfReady((bus, ctx) => emitKnowledgeExtractionFailed(bus, ctx, {
        sourceId: input.sourceId,
        error: error instanceof Error ? error.message : String(error),
      }), input.sessionId);
      throw error;
    }
  }

  private async recompileSource(source: KnowledgeSourceRecord): Promise<void> {
    const extraction = source.id ? this.store.getExtractionBySourceId(source.id) : null;
    if (!extraction && source.artifactId) {
      const content = await this.artifactStore.readContent(source.artifactId);
      const extracted = await extractKnowledgeArtifact(content.record, content.buffer);
      await this.store.upsertExtraction({
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
    await this.compileSource(this.store.getSource(source.id) ?? source, this.store.getExtractionBySourceId(source.id));
  }

  private async compileSource(source: KnowledgeSourceRecord, extraction?: KnowledgeExtractionRecord | null): Promise<void> {
    const initialNodeCount = this.store.status().nodeCount;
    const initialEdgeCount = this.store.status().edgeCount;

    if (source.artifactId) {
      await this.store.upsertEdge({
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
        const domainNode = await this.store.upsertNode({
          kind: 'domain',
          slug: slugify(hostname),
          title: hostname,
          summary: `Knowledge sources cataloged under ${hostname}.`,
          aliases: [hostname],
          metadata: { hostname },
        });
        await this.store.upsertEdge({
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
        const folderNode = await this.store.upsertNode({
          kind: 'bookmark_folder',
          slug: slugify(accumulated),
          title: segment,
          summary: `Bookmark folder ${accumulated}.`,
          aliases: [accumulated],
          metadata: { folderPath: accumulated },
        });
        if (previousNode) {
          await this.store.upsertEdge({
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
        await this.store.upsertEdge({
          fromKind: 'source',
          fromId: source.id,
          toKind: 'node',
          toId: previousNode.id,
          relation: 'cataloged_in_folder',
        });
      }
    }

    for (const tag of source.tags) {
      const topicNode = await this.store.upsertNode({
        kind: 'topic',
        slug: slugify(tag),
        title: tag,
        summary: `Topic tag ${tag}.`,
        aliases: [tag],
        metadata: { tag },
      });
      await this.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: topicNode.id,
        relation: 'tagged_with',
      });
    }

    await this.compileStructuredEntityHints(source, extraction);

    if (extraction) {
      const tagSlugs = new Set(source.tags.map((tag) => slugify(tag)));
      for (const section of extraction.sections.slice(0, 12)) {
        if (tagSlugs.has(slugify(section))) continue;
        const topicNode = await this.store.upsertNode({
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
        await this.store.upsertEdge({
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
        const linked = this.store.getSourceByCanonicalUri(canonicalOutbound);
        if (!linked) continue;
        await this.store.upsertEdge({
          fromKind: 'source',
          fromId: source.id,
          toKind: 'source',
          toId: linked.id,
          relation: 'links_to_source',
        });
      }
    }

    if (source.sessionId) {
      await this.store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'session',
        toId: source.sessionId,
        relation: 'ingested_during',
      });
    }

    const finalStatus = this.store.status();
    this.emitIfReady((bus, ctx) => emitKnowledgeCompileCompleted(bus, ctx, {
      sourceId: source.id,
      nodeCount: Math.max(0, finalStatus.nodeCount - initialNodeCount),
      edgeCount: Math.max(0, finalStatus.edgeCount - initialEdgeCount),
    }), source.sessionId);
  }

  private async syncReviewedMemory(): Promise<void> {
    const registry = getMemoryRegistry();
    const memoryRecords = registry.getAll().filter((record) => record.reviewState !== 'contradicted');
    for (const record of memoryRecords) {
      await this.upsertMemoryNode(record);
    }
  }

  private async upsertMemoryNode(record: MemoryRecord): Promise<void> {
    const node = await this.store.upsertNode({
      id: `memory-${record.id}`,
      kind: 'memory',
      slug: slugify(record.id),
      title: record.summary,
      summary: record.detail ?? record.summary,
      aliases: record.tags,
      status: record.reviewState === 'stale' ? 'stale' : 'active',
      confidence: record.confidence,
      metadata: {
        memoryId: record.id,
        scope: record.scope,
        cls: record.cls,
        reviewState: record.reviewState,
      },
    });
    for (const tag of record.tags) {
      const topicNode = await this.store.upsertNode({
        kind: 'topic',
        slug: slugify(tag),
        title: tag,
        summary: `Topic tag ${tag}.`,
        aliases: [tag],
        metadata: { tag },
      });
      await this.store.upsertEdge({
        fromKind: 'node',
        fromId: node.id,
        toKind: 'node',
        toId: topicNode.id,
        relation: 'memory_tagged_with',
      });
    }
    for (const provenance of record.provenance) {
      if (provenance.kind === 'session') {
        await this.store.upsertEdge({
          fromKind: 'node',
          fromId: node.id,
          toKind: 'session',
          toId: provenance.ref,
          relation: 'derived_from_session',
        });
      }
    }
  }

  private deferUsage(input: {
    readonly targetKind: KnowledgeUsageRecord['targetKind'];
    readonly targetId: string;
    readonly usageKind: KnowledgeUsageRecord['usageKind'];
    readonly task?: string;
    readonly sessionId?: string;
    readonly score?: number;
    readonly metadata?: Record<string, unknown>;
  }): void {
    queueMicrotask(() => {
      void this.recordUsage(input).catch(() => {});
    });
  }

  private buildUsageStats(limit = 10_000): Map<string, {
    count: number;
    scoreTotal: number;
    lastUsedAt: number;
    usageKinds: Set<string>;
    sessionIds: Set<string>;
  }> {
    const stats = new Map<string, {
      count: number;
      scoreTotal: number;
      lastUsedAt: number;
      usageKinds: Set<string>;
      sessionIds: Set<string>;
    }>();
    const cutoff = usageWindowCutoff();
    for (const record of this.store.listUsageRecords(limit)) {
      if (record.createdAt < cutoff) continue;
      const key = `${record.targetKind}:${record.targetId}`;
      const current = stats.get(key) ?? {
        count: 0,
        scoreTotal: 0,
        lastUsedAt: 0,
        usageKinds: new Set<string>(),
        sessionIds: new Set<string>(),
      };
      current.count += 1;
      current.scoreTotal += Number(record.score ?? 0);
      current.lastUsedAt = Math.max(current.lastUsedAt, record.createdAt);
      current.usageKinds.add(record.usageKind);
      if (record.sessionId) current.sessionIds.add(record.sessionId);
      stats.set(key, current);
    }
    return stats;
  }

  private scoreUsageBoost(stats: {
    count: number;
    scoreTotal: number;
    lastUsedAt: number;
    usageKinds: Set<string>;
    sessionIds: Set<string>;
  } | undefined): number {
    if (!stats) return 0;
    const frequency = Math.min(28, stats.count * 4);
    const diversity = Math.min(14, stats.usageKinds.size * 3 + stats.sessionIds.size * 2);
    const averageScore = stats.count > 0 ? stats.scoreTotal / stats.count : 0;
    const scoreBoost = Math.min(12, Math.max(0, averageScore / 12));
    const ageMs = Math.max(0, Date.now() - stats.lastUsedAt);
    const recency = ageMs <= DAY_MS ? 10 : ageMs <= 7 * DAY_MS ? 6 : ageMs <= 14 * DAY_MS ? 3 : 0;
    return frequency + diversity + scoreBoost + recency;
  }

  private nodeKindBoost(kind: KnowledgeNodeRecord['kind']): number {
    switch (kind) {
      case 'project':
      case 'capability':
      case 'repo':
      case 'service':
      case 'provider':
      case 'environment':
        return 12;
      case 'memory':
        return 10;
      case 'user':
        return 8;
      case 'domain':
      case 'bookmark_folder':
        return 4;
      default:
        return 0;
    }
  }

  private getSourceRefreshWindowMs(source: KnowledgeSourceRecord): number {
    const connectorKey = source.connectorId === 'url-list' ? 'url-list' : source.connectorId;
    return SOURCE_REFRESH_WINDOWS_MS[connectorKey]
      ?? SOURCE_REFRESH_WINDOWS_MS[source.sourceType]
      ?? SOURCE_REFRESH_WINDOWS_MS.other;
  }

  private isSourcePastRefreshWindow(source: KnowledgeSourceRecord): boolean {
    if (!source.lastCrawledAt) return source.status === 'stale';
    return source.lastCrawledAt < (Date.now() - this.getSourceRefreshWindowMs(source));
  }

  private async compileStructuredEntityHints(
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
        const node = await this.store.upsertNode({
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
        await this.store.upsertEdge({
          fromKind: 'source',
          fromId: source.id,
          toKind: 'node',
          toId: node.id,
          relation: spec.relation,
        });
      }
    }
  }

  private inferMemoryClassForCandidate(
    subjectKind: KnowledgeConsolidationCandidateRecord['subjectKind'],
    subjectId: string,
  ): MemoryClass {
    if (subjectKind === 'node') {
      const node = this.store.getNode(subjectId);
      switch (node?.kind) {
        case 'project':
        case 'capability':
        case 'repo':
        case 'service':
        case 'environment':
          return 'architecture';
        case 'provider':
          return 'fact';
        case 'user':
          return 'ownership';
        case 'memory':
          return 'fact';
        default:
          return 'fact';
      }
    }
    const source = this.store.getSource(subjectId);
    switch (source?.sourceType) {
      case 'repo':
        return 'architecture';
      case 'bookmark':
      case 'url':
      case 'bookmark-list':
        return 'fact';
      case 'document':
        return 'runbook';
      default:
        return 'fact';
    }
  }

  private async refreshConsolidationCandidates(limit = 24): Promise<KnowledgeConsolidationCandidateRecord[]> {
    await this.store.init();
    await this.syncReviewedMemory();
    const usageStats = this.buildUsageStats();
    const proposals: KnowledgeConsolidationCandidateRecord[] = [];
    const seenSubjects = new Set<string>();

    for (const [key, stats] of usageStats.entries()) {
      const [subjectKind, subjectId] = key.split(':', 2) as [KnowledgeConsolidationCandidateRecord['subjectKind'], string];
      if (subjectKind === 'issue') continue;
      const item = this.store.getItem(subjectId);
      if (!item?.source && !item?.node) continue;
      const subjectTitle = item.source?.title ?? item.source?.canonicalUri ?? item.node?.title ?? subjectId;
      const subjectSummary = summarizeCompact(item.source?.summary ?? item.node?.summary ?? item.source?.description);
      const relationCount = subjectKind === 'source'
        ? this.store.edgesFor('source', subjectId).length
        : this.store.edgesFor('node', subjectId).length;
      const score = Math.round(
        this.scoreUsageBoost(stats)
        + Math.min(16, relationCount * 2)
        + (item.node?.kind === 'memory' ? 10 : 0),
      );
      if (score < LIGHT_CONSOLIDATION_THRESHOLD) continue;
      const candidateType: KnowledgeConsolidationCandidateRecord['candidateType'] =
        item.node?.kind === 'memory' && item.node.status === 'stale'
          ? 'memory-review'
          : subjectKind === 'source' && this.isSourcePastRefreshWindow(item.source!)
            ? 'source-refresh'
            : 'memory-promotion';
      const evidence = mergeTags(
        [
          `used ${stats.count} time(s) in the last 30 days`,
          `observed via ${stats.usageKinds.size} usage pattern(s)`,
          `linked to ${relationCount} graph relation(s)`,
        ],
        subjectKind === 'source' ? item.source?.tags : item.node?.aliases,
      ).slice(0, 8);
      const candidate = await this.store.upsertConsolidationCandidate({
        candidateType,
        subjectKind,
        subjectId,
        title: subjectTitle,
        summary: subjectSummary,
        score,
        evidence,
        suggestedMemoryClass: this.inferMemoryClassForCandidate(subjectKind, subjectId),
        suggestedScope: 'project',
        metadata: {
          usageCount: stats.count,
          lastUsedAt: stats.lastUsedAt,
          usageKinds: [...stats.usageKinds],
          relationCount,
        },
      });
      proposals.push(candidate);
      seenSubjects.add(`${candidate.candidateType}:${candidate.subjectKind}:${candidate.subjectId}`);
    }

    for (const existing of this.store.listConsolidationCandidates(1_000, { status: 'open' })) {
      const key = `${existing.candidateType}:${existing.subjectKind}:${existing.subjectId}`;
      if (seenSubjects.has(key)) continue;
      await this.store.upsertConsolidationCandidate({
        id: existing.id,
        candidateType: existing.candidateType,
        status: 'superseded',
        subjectKind: existing.subjectKind,
        subjectId: existing.subjectId,
        title: existing.title,
        summary: existing.summary,
        score: existing.score,
        evidence: existing.evidence,
        suggestedMemoryClass: existing.suggestedMemoryClass,
        suggestedScope: existing.suggestedScope,
        metadata: existing.metadata,
      });
    }

    return proposals
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  private async runConsolidation(
    kind: Extract<KnowledgeConsolidationReportRecord['kind'], 'light-consolidation' | 'deep-consolidation'>,
    input: { readonly limit?: number; readonly autoPromote: boolean },
  ): Promise<KnowledgeConsolidationReportRecord> {
    const limit = Math.max(1, input.limit ?? 24);
    const candidates = await this.refreshConsolidationCandidates(limit);
    let accepted = 0;
    let rejected = 0;
    let superseded = 0;
    if (input.autoPromote) {
      for (const candidate of candidates) {
        if (candidate.candidateType !== 'memory-promotion') continue;
        if (candidate.score < DEEP_CONSOLIDATION_AUTOPROMOTE_THRESHOLD) continue;
        const decided = await this.decideConsolidationCandidate(candidate.id, 'accept', {
          decidedBy: 'knowledge.deep-consolidation',
          memoryClass: candidate.suggestedMemoryClass,
          scope: candidate.suggestedScope,
        });
        if (decided.status === 'accepted') accepted += 1;
      }
    }
    const current = this.store.listConsolidationCandidates(1_000);
    for (const candidate of current) {
      if (candidate.status === 'rejected') rejected += 1;
      if (candidate.status === 'superseded') superseded += 1;
    }
    const openCount = current.filter((entry) => entry.status === 'open').length;
    const report = await this.store.upsertConsolidationReport({
      kind,
      title: kind === 'light-consolidation' ? 'Light Consolidation Report' : 'Deep Consolidation Report',
      summary: kind === 'light-consolidation'
        ? `Reviewed ${candidates.length} high-signal knowledge subjects and refreshed the consolidation queue.`
        : `Reviewed ${candidates.length} high-signal knowledge subjects and auto-promoted the highest-confidence candidates into durable memory.`,
      highlights: candidates.slice(0, 6).map((candidate) => `${candidate.title} (${candidate.candidateType}, score ${candidate.score})`),
      metrics: {
        candidateCount: candidates.length,
        openCount,
        acceptedCount: accepted,
        rejectedCount: rejected,
        supersededCount: superseded,
      },
      metadata: {
        autoPromote: input.autoPromote,
      },
    });
    return report;
  }

  private async initializeSchedules(): Promise<void> {
    if (this.schedulesInitialized) return;
    this.schedulesInitialized = true;
    await this.store.init();
    if (this.store.listSchedules(10_000).length === 0) {
      await this.store.upsertSchedule({
        jobId: 'knowledge-light-consolidation',
        label: 'Daily Light Consolidation',
        enabled: true,
        schedule: normalizeEverySchedule('24h'),
        nextRunAt: getNextAutomationOccurrence(normalizeEverySchedule('24h'), Date.now(), 'knowledge-light-consolidation'),
        metadata: { bootstrap: true },
      });
      await this.store.upsertSchedule({
        jobId: 'knowledge-deep-consolidation',
        label: 'Weekly Deep Consolidation',
        enabled: true,
        schedule: normalizeCronSchedule('15 4 * * 0'),
        nextRunAt: getNextAutomationOccurrence(normalizeCronSchedule('15 4 * * 0'), Date.now(), 'knowledge-deep-consolidation'),
        metadata: { bootstrap: true },
      });
    }
    await this.reconcileSchedules();
  }

  private dispose(): void {
    for (const timer of this.scheduleTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduleTimers.clear();
  }

  private clearScheduleTimer(id: string): void {
    const timer = this.scheduleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.scheduleTimers.delete(id);
    }
  }

  private async reconcileSchedules(): Promise<void> {
    await this.store.init();
    const schedules = this.store.listSchedules(10_000);
    const activeIds = new Set(schedules.map((schedule) => schedule.id));
    for (const existing of [...this.scheduleTimers.keys()]) {
      if (!activeIds.has(existing)) this.clearScheduleTimer(existing);
    }
    for (const schedule of schedules) {
      this.clearScheduleTimer(schedule.id);
      if (!schedule.enabled) continue;
      const dueAt = schedule.nextRunAt ?? getNextAutomationOccurrence(schedule.schedule, Date.now(), schedule.id);
      const normalized = await this.store.upsertSchedule({
        id: schedule.id,
        jobId: schedule.jobId,
        label: schedule.label,
        enabled: schedule.enabled,
        schedule: schedule.schedule,
        lastRunAt: schedule.lastRunAt,
        nextRunAt: dueAt,
        metadata: schedule.metadata,
      });
      if (!normalized.nextRunAt) continue;
      const delay = Math.max(250, Math.min(2_147_483_647, normalized.nextRunAt - Date.now()));
      this.scheduleTimers.set(normalized.id, setTimeout(() => {
        void this.runScheduledJob(normalized.id);
      }, delay));
    }
  }

  private async runScheduledJob(scheduleId: string): Promise<void> {
    this.clearScheduleTimer(scheduleId);
    const schedule = this.store.getSchedule(scheduleId);
    if (!schedule?.enabled) return;
    const now = Date.now();
    await this.runJob(schedule.jobId, { mode: 'background' });
    await this.store.upsertSchedule({
      id: schedule.id,
      jobId: schedule.jobId,
      label: schedule.label,
      enabled: schedule.enabled,
      schedule: schedule.schedule,
      lastRunAt: now,
      nextRunAt: getNextAutomationOccurrence(schedule.schedule, now, schedule.id),
      metadata: schedule.metadata,
    });
    await this.reconcileSchedules();
  }

  async lint(): Promise<readonly KnowledgeIssueRecord[]> {
    return lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) });
  }

  private issueForSource(
    source: KnowledgeSourceRecord,
    severity: KnowledgeIssueRecord['severity'],
    code: string,
    message: string,
  ): KnowledgeIssueRecord {
    return {
      id: `issue-${code}-${source.id}`,
      severity,
      code,
      message,
      status: 'open',
      sourceId: source.id,
      metadata: { namespace: LINT_NAMESPACE },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  private emitIfReady(
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ): void {
    if (!this.runtimeBus) return;
    fn(this.runtimeBus, {
      traceId: randomUUID(),
      sessionId: sessionId ?? 'knowledge-runtime',
      source: 'knowledge.service',
    });
  }
}

export function buildCuratedKnowledgePromptSync(task: string, writeScope: readonly string[] = []): string | null {
  return KnowledgeService.getActive().buildPromptPacketSync(task, writeScope);
}
