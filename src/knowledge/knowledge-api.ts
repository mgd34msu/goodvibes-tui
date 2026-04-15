import type { KnowledgeService } from '@pellux/goodvibes-sdk/platform/knowledge/service';
import type { ArtifactFetchMode } from '@pellux/goodvibes-sdk/platform/artifacts/types';
import {
  buildKnowledgeInjectionPrompt,
  selectKnowledgeForTask,
  type KnowledgeInjection,
} from '@pellux/goodvibes-sdk/platform/state/knowledge-injection';
import type {
  MemoryAddOptions,
  MemoryBundle,
  MemoryDoctorReport,
  MemoryImportResult,
  MemoryLink,
  MemoryRecord,
  MemoryReviewPatch,
  MemoryScope,
  MemorySearchFilter,
  MemorySemanticSearchResult,
} from '@pellux/goodvibes-sdk/platform/state/memory-store';
import type { MemoryVectorStats } from '@pellux/goodvibes-sdk/platform/state/memory-vector-store';
import type { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/memory-registry';
export type { ArtifactFetchMode } from '@pellux/goodvibes-sdk/platform/artifacts/types';
export type {
  KnowledgeInjection,
} from '@pellux/goodvibes-sdk/platform/state/knowledge-injection';
export type {
  KnowledgeInjectionIngestMode,
  KnowledgeInjectionProvenance,
  KnowledgeInjectionRetention,
  KnowledgeInjectionTrustTier,
  KnowledgeInjectionUseAs,
} from '@pellux/goodvibes-sdk/platform/knowledge/internal';

type UsageListInput = Parameters<KnowledgeService['listUsageRecords']>[1];
type SourceQueryInput = Parameters<KnowledgeService['querySources']>[0];
type NodeQueryInput = Parameters<KnowledgeService['queryNodes']>[0];
type IssueQueryInput = Parameters<KnowledgeService['queryIssues']>[0];
type NeighborInput = Parameters<KnowledgeService['getNeighbors']>[2];
type RecordUsageInput = Parameters<KnowledgeService['recordUsage']>[0];
type IngestUrlInput = Parameters<KnowledgeService['ingestUrl']>[0];
type IngestArtifactInput = Parameters<KnowledgeService['ingestArtifact']>[0];
type ImportBookmarksInput = Parameters<KnowledgeService['importBookmarksFromFile']>[0];
type ImportUrlsInput = Parameters<KnowledgeService['importUrlsFromFile']>[0];
type BookmarkSeedsInput = Parameters<KnowledgeService['ingestBookmarkSeeds']>[0];
type ConnectorInput = Parameters<KnowledgeService['ingestConnectorInput']>[0];
type ProjectionRenderInput = Parameters<KnowledgeService['renderProjection']>[0];
type ProjectionMaterializeInput = Parameters<KnowledgeService['materializeProjection']>[0];
type PacketTask = Parameters<KnowledgeService['buildPacket']>[0];
type PacketWriteScope = Parameters<KnowledgeService['buildPacket']>[1];
type PacketLimit = Parameters<KnowledgeService['buildPacket']>[2];
type PacketOptions = Parameters<KnowledgeService['buildPacket']>[3];
type ScheduleSaveInput = Parameters<KnowledgeService['saveSchedule']>[0];
type ConsolidationDecision = Parameters<KnowledgeService['decideConsolidationCandidate']>[1];
type ConsolidationDecisionInput = Parameters<KnowledgeService['decideConsolidationCandidate']>[2];
type RunJobInput = Parameters<KnowledgeService['runJob']>[1];
type CandidateListInput = Parameters<KnowledgeService['listConsolidationCandidates']>[1];
type RemoteKnowledgeFetchMode = Extract<ArtifactFetchMode, 'public-only' | 'allow-private-hosts'>;

export interface KnowledgeApiUrlIngestInput extends Omit<IngestUrlInput, 'allowPrivateHosts' | 'metadata'> {
  readonly fetchMode?: RemoteKnowledgeFetchMode;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeApiArtifactIngestInput extends Omit<IngestArtifactInput, 'allowPrivateHosts' | 'metadata'> {
  readonly fetchMode?: RemoteKnowledgeFetchMode;
  readonly metadata?: Record<string, unknown>;
}

export interface MemoryExplainResult {
  readonly injections: readonly KnowledgeInjection[];
  readonly prompt: string | null;
}

export interface MemoryApi {
  add(input: MemoryAddOptions): Promise<MemoryRecord>;
  search(filter?: MemorySearchFilter): readonly MemoryRecord[];
  searchSemantic(filter?: MemorySearchFilter): readonly MemorySemanticSearchResult[];
  vectorStats(): MemoryVectorStats;
  rebuildVectors(): MemoryVectorStats;
  rebuildVectorsAsync(): Promise<MemoryVectorStats>;
  doctor(): Promise<MemoryDoctorReport>;
  reviewQueue(limit?: number): readonly MemoryRecord[];
  exportBundle(filter?: MemorySearchFilter): MemoryBundle;
  importBundle(bundle: MemoryBundle): Promise<MemoryImportResult>;
  get(id: string): MemoryRecord | null;
  getAll(): readonly MemoryRecord[];
  link(fromId: string, toId: string, relation: string): Promise<MemoryLink | null>;
  linksFor(id: string): readonly MemoryLink[];
  update(id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null;
  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null;
  delete(id: string): boolean;
  explain(task: string, writeScope?: readonly string[], limit?: number): MemoryExplainResult;
}

export type MemoryApiRegistry = Pick<
  MemoryRegistry,
  | 'add'
  | 'doctor'
  | 'delete'
  | 'exportBundle'
  | 'get'
  | 'getAll'
  | 'importBundle'
  | 'link'
  | 'linksFor'
  | 'rebuildVectors'
  | 'rebuildVectorsAsync'
  | 'review'
  | 'reviewQueue'
  | 'search'
  | 'searchSemantic'
  | 'update'
  | 'vectorStats'
>;

export interface CreateKnowledgeApiOptions {
  readonly memoryRegistry?: MemoryApiRegistry;
}

export interface KnowledgeApi {
  readonly status: {
    get(): ReturnType<KnowledgeService['getStatus']>;
    lint(): ReturnType<KnowledgeService['lint']>;
    reindex(): ReturnType<KnowledgeService['reindex']>;
  };
  readonly sources: {
    list(limit?: number): ReturnType<KnowledgeService['listSources']>;
    query(input?: SourceQueryInput): ReturnType<KnowledgeService['querySources']>;
  };
  readonly graph: {
    nodes: {
      list(limit?: number): ReturnType<KnowledgeService['listNodes']>;
      query(input?: NodeQueryInput): ReturnType<KnowledgeService['queryNodes']>;
    };
    issues: {
      list(limit?: number): ReturnType<KnowledgeService['listIssues']>;
      query(input?: IssueQueryInput): ReturnType<KnowledgeService['queryIssues']>;
    };
    extractions: {
      list(limit?: number, sourceId?: string): ReturnType<KnowledgeService['listExtractions']>;
      get(id: string): ReturnType<KnowledgeService['getExtraction']>;
      getBySourceId(sourceId: string): ReturnType<KnowledgeService['getSourceExtraction']>;
    };
    items: {
      get(id: string): ReturnType<KnowledgeService['getItem']>;
      getMany(ids: readonly string[]): ReturnType<KnowledgeService['getItems']>;
      neighbors(
        kind: Parameters<KnowledgeService['getNeighbors']>[0],
        id: string,
        input?: NeighborInput,
      ): ReturnType<KnowledgeService['getNeighbors']>;
      search(query: string, limit?: number): ReturnType<KnowledgeService['search']>;
    };
  };
  readonly usage: {
    list(limit?: number, input?: UsageListInput): ReturnType<KnowledgeService['listUsageRecords']>;
    record(input: RecordUsageInput): ReturnType<KnowledgeService['recordUsage']>;
  };
  readonly connectors: {
    list(): ReturnType<KnowledgeService['listConnectors']>;
    get(id: string): ReturnType<KnowledgeService['getConnector']>;
    doctor(id: string): ReturnType<KnowledgeService['doctorConnector']>;
    register(connector: Parameters<KnowledgeService['registerConnector']>[0], options?: Parameters<KnowledgeService['registerConnector']>[1]): void;
  };
  readonly ingest: {
    url(input: KnowledgeApiUrlIngestInput): ReturnType<KnowledgeService['ingestUrl']>;
    artifact(input: KnowledgeApiArtifactIngestInput): ReturnType<KnowledgeService['ingestArtifact']>;
    bookmarksFile(input: ImportBookmarksInput): ReturnType<KnowledgeService['importBookmarksFromFile']>;
    urlsFile(input: ImportUrlsInput): ReturnType<KnowledgeService['importUrlsFromFile']>;
    bookmarkSeeds(input: BookmarkSeedsInput): ReturnType<KnowledgeService['ingestBookmarkSeeds']>;
    withConnector(
      connectorId: Parameters<KnowledgeService['ingestWithConnector']>[0],
      input: Parameters<KnowledgeService['ingestWithConnector']>[1],
      sessionId?: Parameters<KnowledgeService['ingestWithConnector']>[2],
    ): ReturnType<KnowledgeService['ingestWithConnector']>;
    connectorInput(input: ConnectorInput): ReturnType<KnowledgeService['ingestConnectorInput']>;
  };
  readonly packets: {
    build(
      task: PacketTask,
      writeScope?: PacketWriteScope,
      limit?: PacketLimit,
      options?: PacketOptions,
    ): ReturnType<KnowledgeService['buildPacket']>;
    buildSync(
      task: PacketTask,
      writeScope?: PacketWriteScope,
      limit?: PacketLimit,
      options?: PacketOptions,
    ): ReturnType<KnowledgeService['buildPacketSync']>;
    buildPrompt(
      task: PacketTask,
      writeScope?: PacketWriteScope,
      limit?: PacketLimit,
      options?: PacketOptions,
    ): ReturnType<KnowledgeService['buildPromptPacket']>;
    buildPromptSync(
      task: PacketTask,
      writeScope?: PacketWriteScope,
      limit?: PacketLimit,
      options?: PacketOptions,
    ): ReturnType<KnowledgeService['buildPromptPacketSync']>;
  };
  readonly projections: {
    listTargets(limit?: number): ReturnType<KnowledgeService['listProjectionTargets']>;
    render(input: ProjectionRenderInput): ReturnType<KnowledgeService['renderProjection']>;
    materialize(input: ProjectionMaterializeInput): ReturnType<KnowledgeService['materializeProjection']>;
  };
  readonly jobs: {
    list(): ReturnType<KnowledgeService['listJobs']>;
    get(id: string): ReturnType<KnowledgeService['getJob']>;
    runs(limit?: number, jobId?: string): ReturnType<KnowledgeService['listJobRuns']>;
    run(id: string, input?: RunJobInput): ReturnType<KnowledgeService['runJob']>;
    schedules: {
      list(limit?: number): ReturnType<KnowledgeService['listSchedules']>;
      get(id: string): ReturnType<KnowledgeService['getSchedule']>;
      save(input: ScheduleSaveInput): ReturnType<KnowledgeService['saveSchedule']>;
      delete(id: string): ReturnType<KnowledgeService['deleteSchedule']>;
      setEnabled(id: string, enabled: boolean): ReturnType<KnowledgeService['setScheduleEnabled']>;
    };
  };
  readonly consolidation: {
    candidates(limit?: number, input?: CandidateListInput): ReturnType<KnowledgeService['listConsolidationCandidates']>;
    getCandidate(id: string): ReturnType<KnowledgeService['getConsolidationCandidate']>;
    reports(limit?: number): ReturnType<KnowledgeService['listConsolidationReports']>;
    getReport(id: string): ReturnType<KnowledgeService['getConsolidationReport']>;
    decide(
      candidateId: string,
      decision: ConsolidationDecision,
      input?: ConsolidationDecisionInput,
    ): ReturnType<KnowledgeService['decideConsolidationCandidate']>;
  };
  readonly memory?: MemoryApi;
}

function normalizeKnowledgeFetchMode(fetchMode: RemoteKnowledgeFetchMode | undefined): {
  fetchMode?: RemoteKnowledgeFetchMode;
  allowPrivateHosts?: boolean;
} {
  if (!fetchMode) return {};
  return {
    fetchMode,
    allowPrivateHosts: fetchMode === 'allow-private-hosts',
  };
}

function appendKnowledgeIntentMetadata(
  metadata: Record<string, unknown> | undefined,
  fetchMode: RemoteKnowledgeFetchMode | undefined,
  ingestMode: 'url' | 'artifact',
): Record<string, unknown> | undefined {
  if (!metadata && !fetchMode) return {
    knowledgeIntent: {
      ingestMode,
    },
  };
  return {
    ...(metadata ?? {}),
    knowledgeIntent: {
      ingestMode,
      ...(fetchMode ? { remoteFetchMode: fetchMode } : {}),
    },
  };
}

export function createMemoryApi(memoryRegistry: MemoryApiRegistry): MemoryApi {
  return Object.freeze({
    add: (input: MemoryAddOptions) => memoryRegistry.add(input),
    search: (filter: MemorySearchFilter = {}) => memoryRegistry.search(filter),
    searchSemantic: (filter: MemorySearchFilter = {}) => memoryRegistry.searchSemantic(filter),
    vectorStats: () => memoryRegistry.vectorStats(),
    rebuildVectors: () => memoryRegistry.rebuildVectors(),
    rebuildVectorsAsync: () => memoryRegistry.rebuildVectorsAsync(),
    doctor: () => memoryRegistry.doctor(),
    reviewQueue: (limit = 10) => memoryRegistry.reviewQueue(limit),
    exportBundle: (filter: MemorySearchFilter = {}) => memoryRegistry.exportBundle(filter),
    importBundle: (bundle: MemoryBundle) => memoryRegistry.importBundle(bundle),
    get: (id: string) => memoryRegistry.get(id),
    getAll: () => memoryRegistry.getAll(),
    link: (fromId: string, toId: string, relation: string) => memoryRegistry.link(fromId, toId, relation),
    linksFor: (id: string) => memoryRegistry.linksFor(id),
    update: (id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }) => (
      memoryRegistry.update(id, patch)
    ),
    review: (id: string, patch: MemoryReviewPatch) => memoryRegistry.review(id, patch),
    delete: (id: string) => memoryRegistry.delete(id),
    explain: (task: string, writeScope: readonly string[] = [], limit = 3): MemoryExplainResult => {
      const injections = selectKnowledgeForTask(memoryRegistry, task, writeScope, limit);
      return {
        injections,
        prompt: buildKnowledgeInjectionPrompt(injections),
      };
    },
  });
}

export function createKnowledgeApi(
  knowledgeService: KnowledgeService,
  options: CreateKnowledgeApiOptions = {},
): KnowledgeApi {
  return Object.freeze({
    status: Object.freeze({
      get: () => knowledgeService.getStatus(),
      lint: () => knowledgeService.lint(),
      reindex: () => knowledgeService.reindex(),
    }),
    sources: Object.freeze({
      list: (limit = 100) => knowledgeService.listSources(limit),
      query: (input = {}) => knowledgeService.querySources(input),
    }),
    graph: Object.freeze({
      nodes: Object.freeze({
        list: (limit = 100) => knowledgeService.listNodes(limit),
        query: (input = {}) => knowledgeService.queryNodes(input),
      }),
      issues: Object.freeze({
        list: (limit = 100) => knowledgeService.listIssues(limit),
        query: (input = {}) => knowledgeService.queryIssues(input),
      }),
      extractions: Object.freeze({
        list: (limit: number = 100, sourceId?: string) => knowledgeService.listExtractions(limit, sourceId),
        get: (id: string) => knowledgeService.getExtraction(id),
        getBySourceId: (sourceId: string) => knowledgeService.getSourceExtraction(sourceId),
      }),
      items: Object.freeze({
        get: (id: string) => knowledgeService.getItem(id),
        getMany: (ids: readonly string[]) => knowledgeService.getItems(ids),
        neighbors: (
          kind: Parameters<KnowledgeService['getNeighbors']>[0],
          id: string,
          input: NeighborInput = {},
        ) => knowledgeService.getNeighbors(kind, id, input),
        search: (query: string, limit = 10) => knowledgeService.search(query, limit),
      }),
    }),
    usage: Object.freeze({
      list: (limit = 100, input = {}) => knowledgeService.listUsageRecords(limit, input),
      record: (input: RecordUsageInput) => knowledgeService.recordUsage(input),
    }),
    connectors: Object.freeze({
      list: () => knowledgeService.listConnectors(),
      get: (id: string) => knowledgeService.getConnector(id),
      doctor: (id: string) => knowledgeService.doctorConnector(id),
      register: (
        connector: Parameters<KnowledgeService['registerConnector']>[0],
        options: Parameters<KnowledgeService['registerConnector']>[1] = {},
      ) => knowledgeService.registerConnector(connector, options),
    }),
    ingest: Object.freeze({
      url: (input: KnowledgeApiUrlIngestInput) => knowledgeService.ingestUrl({
        ...input,
        ...normalizeKnowledgeFetchMode(input.fetchMode),
        metadata: appendKnowledgeIntentMetadata(input.metadata, input.fetchMode, 'url'),
      }),
      artifact: (input: KnowledgeApiArtifactIngestInput) => knowledgeService.ingestArtifact({
        ...input,
        ...normalizeKnowledgeFetchMode(input.fetchMode),
        metadata: appendKnowledgeIntentMetadata(input.metadata, input.fetchMode, 'artifact'),
      }),
      bookmarksFile: (input: ImportBookmarksInput) => knowledgeService.importBookmarksFromFile(input),
      urlsFile: (input: ImportUrlsInput) => knowledgeService.importUrlsFromFile(input),
      bookmarkSeeds: (
        seeds: Parameters<KnowledgeService['ingestBookmarkSeeds']>[0],
        sessionId?: Parameters<KnowledgeService['ingestBookmarkSeeds']>[1],
        sourceType?: Parameters<KnowledgeService['ingestBookmarkSeeds']>[2],
        connectorId?: Parameters<KnowledgeService['ingestBookmarkSeeds']>[3],
      ) => knowledgeService.ingestBookmarkSeeds(seeds, sessionId, sourceType, connectorId),
      withConnector: (
        connectorId: Parameters<KnowledgeService['ingestWithConnector']>[0],
        input: Parameters<KnowledgeService['ingestWithConnector']>[1],
        sessionId?: Parameters<KnowledgeService['ingestWithConnector']>[2],
      ) => knowledgeService.ingestWithConnector(connectorId, input, sessionId),
      connectorInput: (input: ConnectorInput) => knowledgeService.ingestConnectorInput(input),
    }),
    packets: Object.freeze({
      build: (
        task: PacketTask,
        writeScope: PacketWriteScope = [],
        limit: PacketLimit = 10,
        options: PacketOptions = {},
      ) => knowledgeService.buildPacket(task, writeScope, limit, options),
      buildSync: (
        task: PacketTask,
        writeScope: PacketWriteScope = [],
        limit: PacketLimit = 10,
        options: PacketOptions = {},
      ) => knowledgeService.buildPacketSync(task, writeScope, limit, options),
      buildPrompt: (
        task: PacketTask,
        writeScope: PacketWriteScope = [],
        limit: PacketLimit = 10,
        options: PacketOptions = {},
      ) => knowledgeService.buildPromptPacket(task, writeScope, limit, options),
      buildPromptSync: (
        task: PacketTask,
        writeScope: PacketWriteScope = [],
        limit: PacketLimit = 10,
        options: PacketOptions = {},
      ) => knowledgeService.buildPromptPacketSync(task, writeScope, limit, options),
    }),
    projections: Object.freeze({
      listTargets: (limit = 25) => knowledgeService.listProjectionTargets(limit),
      render: (input: ProjectionRenderInput) => knowledgeService.renderProjection(input),
      materialize: (input: ProjectionMaterializeInput) => knowledgeService.materializeProjection(input),
    }),
    jobs: Object.freeze({
      list: () => knowledgeService.listJobs(),
      get: (id: string) => knowledgeService.getJob(id),
      runs: (limit: number = 100, jobId?: string) => knowledgeService.listJobRuns(limit, jobId),
      run: (id: string, input: RunJobInput = {}) => knowledgeService.runJob(id, input),
      schedules: Object.freeze({
        list: (limit = 100) => knowledgeService.listSchedules(limit),
        get: (id: string) => knowledgeService.getSchedule(id),
        save: (input: ScheduleSaveInput) => knowledgeService.saveSchedule(input),
        delete: (id: string) => knowledgeService.deleteSchedule(id),
        setEnabled: (id: string, enabled: boolean) => knowledgeService.setScheduleEnabled(id, enabled),
      }),
    }),
    consolidation: Object.freeze({
      candidates: (limit = 100, input = {}) => knowledgeService.listConsolidationCandidates(limit, input),
      getCandidate: (id: string) => knowledgeService.getConsolidationCandidate(id),
      reports: (limit = 100) => knowledgeService.listConsolidationReports(limit),
      getReport: (id: string) => knowledgeService.getConsolidationReport(id),
      decide: (
        candidateId: string,
        decision: ConsolidationDecision,
        input: ConsolidationDecisionInput = {},
      ) => knowledgeService.decideConsolidationCandidate(candidateId, decision, input),
    }),
    ...(options.memoryRegistry ? { memory: createMemoryApi(options.memoryRegistry) } : {}),
  });
}
