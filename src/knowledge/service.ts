import { randomUUID } from 'node:crypto';
import {
  type AutomationScheduleDefinition,
} from '@pellux/goodvibes-sdk/platform/automation/schedules';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import type { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/index';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { createDefaultKnowledgeConnectorRegistry, KnowledgeConnectorRegistry } from '@pellux/goodvibes-sdk/platform/knowledge/connectors';
import { KnowledgeProjectionService } from '@pellux/goodvibes-sdk/platform/knowledge/projections';
import { KnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge/store';
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
  KnowledgeProjectionBundle,
  KnowledgeProjectionTarget,
  KnowledgeProjectionTargetKind,
  KnowledgeScheduleRecord,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
  KnowledgeStatus,
  KnowledgeUsageRecord,
} from '@pellux/goodvibes-sdk/platform/knowledge/types';
import {
  buildKnowledgePacket,
  buildKnowledgePacketSync,
  buildKnowledgePromptPacket,
  buildKnowledgePromptPacketSync,
  searchKnowledge,
} from '@pellux/goodvibes-sdk/platform/knowledge/packet';
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
  recompileKnowledgeSource,
} from '@pellux/goodvibes-sdk/platform/knowledge/ingest';
import {
  decideKnowledgeConsolidationCandidate,
  runKnowledgeConsolidation,
} from '@pellux/goodvibes-sdk/platform/knowledge/consolidation';
import { KnowledgeScheduleService } from '@pellux/goodvibes-sdk/platform/knowledge/scheduling';
import { lintKnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge/lint';
import { syncKnowledgeMemoryNodes } from '@pellux/goodvibes-sdk/platform/knowledge/memory-sync';
import {
  emitKnowledgeExtractionCompleted,
  emitKnowledgeExtractionFailed,
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
  emitKnowledgePacketBuilt,
  emitKnowledgeProjectionMaterialized,
  emitKnowledgeProjectionRendered,
} from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';
import { extractKnowledgeArtifact } from '@pellux/goodvibes-sdk/platform/knowledge/extractors';
import {
  canonicalizeUri as internalCanonicalizeUri,
  DEFAULT_PACKET_BUDGET as internalDefaultPacketBudget,
  DEFAULT_PACKET_LIMIT as internalDefaultPacketLimit,
  isHttpUri as internalIsHttpUri,
  isSourcePastRefreshWindow as internalIsSourcePastRefreshWindow,
  tokenize as internalTokenize,
} from '@pellux/goodvibes-sdk/platform/knowledge/internal';

const DEFAULT_PACKET_LIMIT = internalDefaultPacketLimit;
const DEFAULT_PACKET_BUDGET = internalDefaultPacketBudget;
const tokenize = internalTokenize;
const canonicalizeUri = internalCanonicalizeUri;
const isHttpUri = internalIsHttpUri;

export interface KnowledgeServiceConfig {
  readonly configManager?: {
    getControlPlaneConfigDir?: () => string;
  };
  readonly memoryRegistry: Pick<MemoryRegistry, 'add' | 'getAll' | 'getStore'>;
  readonly runtimeBus?: RuntimeEventBus | null;
}

export interface KnowledgeServiceStatus extends KnowledgeStatus {
  readonly note: string;
}

export class KnowledgeService {
  private readonly projectionService: KnowledgeProjectionService;
  private readonly scheduleService: KnowledgeScheduleService;
  private runtimeBus: RuntimeEventBus | null;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly artifactStore: ArtifactStore,
    private readonly connectorRegistry = createDefaultKnowledgeConnectorRegistry(),
    private readonly options: KnowledgeServiceConfig,
  ) {
    this.runtimeBus = options.runtimeBus ?? null;
    void this.store.init();
    this.projectionService = new KnowledgeProjectionService(this.store, this.artifactStore, {
      connectors: () => this.listConnectors(),
    });
    this.scheduleService = new KnowledgeScheduleService({
      store: this.store,
      emitIfReady: this.emitIfReady.bind(this),
      runJobByKind: this.runJobByKind.bind(this),
    });
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
      memoryRegistry: this.options.memoryRegistry,
      syncReviewedMemory: this.syncReviewedMemory.bind(this),
    };
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
    readonly allowPrivateHosts?: boolean;
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
    readonly allowPrivateHosts?: boolean;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
    return ingestKnowledgeArtifact(this.getIngestContext(), input);
  }

  async importBookmarksFromFile(input: {
    readonly path: string;
    readonly sessionId?: string;
    readonly allowPrivateHosts?: boolean;
  }): Promise<KnowledgeBatchIngestResult> {
    return importKnowledgeBookmarksFromFile(this.getIngestContext(), input);
  }

  async importUrlsFromFile(input: {
    readonly path: string;
    readonly sessionId?: string;
    readonly allowPrivateHosts?: boolean;
  }): Promise<KnowledgeBatchIngestResult> {
    return importKnowledgeUrlsFromFile(this.getIngestContext(), input);
  }

  async ingestBookmarkSeeds(
    seeds: readonly KnowledgeBookmarkSeed[],
    sessionId?: string,
    sourceType: KnowledgeSourceType = 'bookmark',
    connectorId = 'bookmark',
    allowPrivateHosts?: boolean,
  ): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeBookmarkSeeds(this.getIngestContext(), seeds, sessionId, sourceType, connectorId, allowPrivateHosts);
  }

  async ingestWithConnector(
    connectorId: string,
    input: unknown,
    sessionId?: string,
    allowPrivateHosts?: boolean,
  ): Promise<KnowledgeBatchIngestResult> {
    return ingestKnowledgeWithConnector(this.getIngestContext(), connectorId, input, sessionId, allowPrivateHosts);
  }

  async ingestConnectorInput(input: {
    readonly connectorId: string;
    readonly input?: unknown;
    readonly content?: string;
    readonly path?: string;
    readonly sessionId?: string;
    readonly allowPrivateHosts?: boolean;
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
    await this.syncReviewedMemory();
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

  private async syncReviewedMemory(): Promise<void> {
    await syncKnowledgeMemoryNodes(this.store, this.options.memoryRegistry);
  }

  private dispose(): void {
    this.scheduleService.dispose();
  }

  async lint(): Promise<readonly KnowledgeIssueRecord[]> {
    return lintKnowledgeStore({ store: this.store, emitIfReady: this.emitIfReady.bind(this) });
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

export function buildCuratedKnowledgePromptSync(
  service: Pick<KnowledgeService, 'buildPromptPacketSync'>,
  task: string,
  writeScope: readonly string[] = [],
): string | null {
  return service.buildPromptPacketSync(task, writeScope);
}
