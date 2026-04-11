import {
  GraphQLError,
  GraphQLScalarType,
  Kind,
  buildSchema,
  graphql,
  parse,
  printSchema,
} from 'graphql';
import type { DocumentNode, ValueNode } from 'graphql';
import type { KnowledgeService } from './service.ts';
import type { KnowledgeProjectionTargetKind, KnowledgePacketDetail } from './types.ts';

const KNOWLEDGE_GRAPHQL_SDL = `
  scalar JSON

  enum KnowledgeProjectionKind {
    OVERVIEW
    BUNDLE
    SOURCE
    NODE
    ISSUE
    DASHBOARD
    ROLLUP
  }

  enum KnowledgePacketDetail {
    COMPACT
    STANDARD
    DETAILED
  }

  enum KnowledgeJobMode {
    INLINE
    BACKGROUND
  }

  type KnowledgeStatus {
    ready: Boolean!
    storagePath: String!
    sourceCount: Int!
    nodeCount: Int!
    edgeCount: Int!
    issueCount: Int!
    extractionCount: Int!
    jobRunCount: Int!
    usageCount: Int!
    candidateCount: Int!
    reportCount: Int!
    scheduleCount: Int!
    note: String!
  }

  type KnowledgeConnectorSetupField {
    key: String!
    label: String!
    kind: String!
    optional: Boolean
    source: String
    description: String
  }

  type KnowledgeConnectorSetup {
    version: String!
    summary: String!
    transportHints: [String!]!
    steps: [String!]!
    fields: [KnowledgeConnectorSetupField!]!
    metadata: JSON
  }

  type KnowledgeConnectorDoctorCheck {
    id: String!
    label: String!
    status: String!
    detail: String!
    metadata: JSON
  }

  type KnowledgeConnectorDoctorReport {
    connectorId: String!
    ready: Boolean!
    summary: String!
    checks: [KnowledgeConnectorDoctorCheck!]!
    hints: [String!]!
    metadata: JSON
  }

  type KnowledgeConnector {
    id: String!
    displayName: String
    version: String
    description: String!
    sourceType: String!
    inputSchema: JSON
    examples: [JSON!]!
    capabilities: [String!]!
    setup: KnowledgeConnectorSetup
    metadata: JSON
  }

  type KnowledgeSource {
    id: String!
    connectorId: String!
    sourceType: String!
    title: String
    sourceUri: String
    canonicalUri: String
    summary: String
    description: String
    tags: [String!]!
    folderPath: String
    status: String!
    artifactId: String
    contentHash: String
    lastCrawledAt: Float
    crawlError: String
    sessionId: String
    metadata: JSON
    createdAt: Float!
    updatedAt: Float!
  }

  type KnowledgeNode {
    id: String!
    kind: String!
    slug: String!
    title: String!
    summary: String
    aliases: [String!]!
    status: String!
    confidence: Int!
    sourceId: String
    metadata: JSON
    createdAt: Float!
    updatedAt: Float!
  }

  type KnowledgeEdge {
    id: String!
    fromKind: String!
    fromId: String!
    toKind: String!
    toId: String!
    relation: String!
    weight: Float!
    metadata: JSON
    createdAt: Float!
    updatedAt: Float!
  }

  type KnowledgeIssue {
    id: String!
    severity: String!
    code: String!
    message: String!
    status: String!
    sourceId: String
    nodeId: String
    metadata: JSON
    createdAt: Float!
    updatedAt: Float!
  }

  type KnowledgeExtraction {
    id: String!
    sourceId: String!
    artifactId: String
    extractorId: String!
    format: String!
    title: String
    summary: String
    excerpt: String
    sections: [String!]!
    links: [String!]!
    estimatedTokens: Int!
    structure: JSON
    metadata: JSON
    createdAt: Float!
    updatedAt: Float!
  }

  type KnowledgeItemView {
    source: KnowledgeSource
    node: KnowledgeNode
    issue: KnowledgeIssue
    relatedEdges: [KnowledgeEdge!]!
    linkedSources: [KnowledgeSource!]!
    linkedNodes: [KnowledgeNode!]!
  }

  type KnowledgeSearchResult {
    kind: String!
    id: String!
    score: Float!
    reason: String!
    source: KnowledgeSource
    node: KnowledgeNode
  }

  type KnowledgePacketItem {
    kind: String!
    id: String!
    title: String!
    summary: String
    uri: String
    reason: String!
    score: Float!
    estimatedTokens: Int!
    related: [String!]!
    evidence: [String!]!
    metadata: JSON
  }

  type KnowledgePacket {
    task: String!
    writeScope: [String!]!
    generatedAt: Float!
    detail: KnowledgePacketDetail!
    strategy: String!
    budgetLimit: Int!
    estimatedTokens: Int!
    items: [KnowledgePacketItem!]!
  }

  type KnowledgeProjectionTarget {
    targetId: String!
    kind: KnowledgeProjectionKind!
    title: String!
    description: String!
    itemId: String
    defaultPath: String!
    defaultFilename: String!
    metadata: JSON
  }

  type KnowledgeProjectionPage {
    path: String!
    title: String!
    format: String!
    content: String!
    itemIds: [String!]!
    metadata: JSON
  }

  type KnowledgeProjectionBundle {
    id: String!
    target: KnowledgeProjectionTarget!
    generatedAt: Float!
    pageCount: Int!
    pages: [KnowledgeProjectionPage!]!
    metadata: JSON
  }

  type ArtifactDescriptor {
    id: String!
    kind: String!
    mimeType: String!
    filename: String
    sizeBytes: Int!
    sha256: String!
    createdAt: Float!
    expiresAt: Float
    sourceUri: String
    metadata: JSON
  }

  type KnowledgeBatchIngestResult {
    imported: Int!
    failed: Int!
    sources: [KnowledgeSource!]!
    errors: [String!]!
  }

  type KnowledgeReindexResult {
    status: KnowledgeStatus!
    issues: [KnowledgeIssue!]!
  }

  type KnowledgeMaterializedProjection {
    bundle: KnowledgeProjectionBundle!
    artifact: ArtifactDescriptor!
  }

  type KnowledgeSourceConnection {
    total: Int!
    items: [KnowledgeSource!]!
  }

  type KnowledgeNodeConnection {
    total: Int!
    items: [KnowledgeNode!]!
  }

  type KnowledgeIssueConnection {
    total: Int!
    items: [KnowledgeIssue!]!
  }

  type KnowledgeNeighborSet {
    edges: [KnowledgeEdge!]!
    sources: [KnowledgeSource!]!
    nodes: [KnowledgeNode!]!
  }

  type KnowledgeJob {
    id: String!
    kind: String!
    title: String!
    description: String!
    defaultMode: KnowledgeJobMode!
    metadata: JSON
  }

  type KnowledgeJobRun {
    id: String!
    jobId: String!
    status: String!
    mode: KnowledgeJobMode!
    requestedAt: Float!
    startedAt: Float
    completedAt: Float
    error: String
    result: JSON
    metadata: JSON
  }

  type KnowledgeUsage {
    id: String!
    targetKind: String!
    targetId: String!
    usageKind: String!
    task: String
    sessionId: String
    score: Float
    metadata: JSON
    createdAt: Float!
  }

  type KnowledgeConsolidationCandidate {
    id: String!
    candidateType: String!
    status: String!
    subjectKind: String!
    subjectId: String!
    title: String!
    summary: String
    score: Float!
    evidence: [String!]!
    suggestedMemoryClass: String
    suggestedScope: String
    decidedAt: Float
    decidedBy: String
    metadata: JSON
    createdAt: Float!
    updatedAt: Float!
  }

  type KnowledgeConsolidationReport {
    id: String!
    kind: String!
    title: String!
    summary: String!
    highlights: [String!]!
    metrics: JSON
    metadata: JSON
    createdAt: Float!
    updatedAt: Float!
  }

  type KnowledgeSchedule {
    id: String!
    jobId: String!
    label: String!
    enabled: Boolean!
    schedule: JSON
    lastRunAt: Float
    nextRunAt: Float
    metadata: JSON
    createdAt: Float!
    updatedAt: Float!
  }

  type Query {
    status: KnowledgeStatus!
    sources(limit: Int = 100): [KnowledgeSource!]!
    nodes(limit: Int = 100): [KnowledgeNode!]!
    issues(limit: Int = 100): [KnowledgeIssue!]!
    source(id: String!): KnowledgeSource
    node(id: String!): KnowledgeNode
    issue(id: String!): KnowledgeIssue
    item(id: String!): KnowledgeItemView
    items(ids: [String!]!): [KnowledgeItemView!]!
    sourcesConnection(limit: Int = 100, offset: Int = 0, status: String, connectorId: String, sourceType: String, tag: String, query: String): KnowledgeSourceConnection!
    nodesConnection(limit: Int = 100, offset: Int = 0, kind: String, status: String, query: String): KnowledgeNodeConnection!
    issuesConnection(limit: Int = 100, offset: Int = 0, severity: String, status: String, code: String, query: String): KnowledgeIssueConnection!
    extractions(limit: Int = 100, sourceId: String): [KnowledgeExtraction!]!
    sourceExtraction(sourceId: String!): KnowledgeExtraction
    neighbors(kind: String!, id: String!, relation: String, limit: Int = 20): KnowledgeNeighborSet!
    search(query: String!, limit: Int = 10): [KnowledgeSearchResult!]!
    packet(task: String!, writeScope: [String!], limit: Int = 6, detail: KnowledgePacketDetail = STANDARD, budgetLimit: Int): KnowledgePacket!
    connectors: [KnowledgeConnector!]!
    connector(id: String!): KnowledgeConnector
    connectorDoctor(id: String!): KnowledgeConnectorDoctorReport
    projectionTargets(limit: Int = 25): [KnowledgeProjectionTarget!]!
    projection(kind: KnowledgeProjectionKind!, id: String, limit: Int = 12): KnowledgeProjectionBundle!
    jobs: [KnowledgeJob!]!
    job(id: String!): KnowledgeJob
    jobRuns(limit: Int = 25, jobId: String): [KnowledgeJobRun!]!
    usage(limit: Int = 100, targetKind: String, targetId: String, usageKind: String): [KnowledgeUsage!]!
    consolidationCandidates(limit: Int = 100, status: String, subjectKind: String, subjectId: String): [KnowledgeConsolidationCandidate!]!
    consolidationCandidate(id: String!): KnowledgeConsolidationCandidate
    consolidationReports(limit: Int = 100): [KnowledgeConsolidationReport!]!
    consolidationReport(id: String!): KnowledgeConsolidationReport
    schedules(limit: Int = 100): [KnowledgeSchedule!]!
    schedule(id: String!): KnowledgeSchedule
  }

  type Mutation {
    ingestUrl(
      url: String!
      title: String
      tags: [String!]
      folderPath: String
      sessionId: String
      sourceType: String
      connectorId: String
      metadata: JSON
    ): KnowledgeSource!

    ingestArtifact(
      artifactId: String
      path: String
      uri: String
      title: String
      tags: [String!]
      folderPath: String
      sessionId: String
      sourceType: String
      connectorId: String
      metadata: JSON
    ): KnowledgeSource!

    importBookmarks(path: String!, sessionId: String): KnowledgeBatchIngestResult!
    importUrls(path: String!, sessionId: String): KnowledgeBatchIngestResult!
    ingestConnector(
      connectorId: String!
      input: JSON
      content: String
      path: String
      sessionId: String
    ): KnowledgeBatchIngestResult!

    lint: [KnowledgeIssue!]!
    reindex: KnowledgeReindexResult!
    runJob(id: String!, mode: KnowledgeJobMode, sourceIds: [String!], limit: Int): KnowledgeJobRun!
    decideCandidate(id: String!, decision: String!, decidedBy: String, memoryClass: String, scope: String, detail: String): KnowledgeConsolidationCandidate!
    saveSchedule(id: String, jobId: String!, label: String, enabled: Boolean, schedule: JSON!): KnowledgeSchedule!
    deleteSchedule(id: String!): Boolean!
    setScheduleEnabled(id: String!, enabled: Boolean!): KnowledgeSchedule
    materializeProjection(
      kind: KnowledgeProjectionKind!
      id: String
      limit: Int = 12
      filename: String
    ): KnowledgeMaterializedProjection!
  }
`;

function parseJsonAst(node: ValueNode): unknown {
  switch (node.kind) {
    case Kind.NULL:
      return null;
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.INT:
      return Number.parseInt(node.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(node.value);
    case Kind.BOOLEAN:
      return node.value;
    case Kind.LIST:
      return node.values.map(parseJsonAst);
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((field) => [field.name.value, parseJsonAst(field.value)]));
    default:
      return null;
  }
}

function installJsonScalar(schema: ReturnType<typeof buildSchema>): void {
  const type = schema.getType('JSON');
  if (!(type instanceof GraphQLScalarType)) return;
  Object.assign(type, {
    description: 'Arbitrary JSON scalar used for connector manifests and knowledge metadata.',
    serialize(value: unknown) {
      return value;
    },
    parseValue(value: unknown) {
      return value;
    },
    parseLiteral(node: ValueNode) {
      return parseJsonAst(node);
    },
  });
}

function toProjectionKind(value: string): KnowledgeProjectionTargetKind {
  switch (value) {
    case 'OVERVIEW':
      return 'overview';
    case 'BUNDLE':
      return 'bundle';
    case 'SOURCE':
      return 'source';
    case 'NODE':
      return 'node';
    case 'ISSUE':
      return 'issue';
    case 'DASHBOARD':
      return 'dashboard';
    case 'ROLLUP':
      return 'rollup';
    default:
      throw new GraphQLError(`Unsupported knowledge projection kind: ${value}`);
  }
}

function toProjectionEnum(value: string | undefined): string {
  switch (value) {
    case 'overview':
      return 'OVERVIEW';
    case 'bundle':
      return 'BUNDLE';
    case 'source':
      return 'SOURCE';
    case 'node':
      return 'NODE';
    case 'issue':
      return 'ISSUE';
    case 'dashboard':
      return 'DASHBOARD';
    case 'rollup':
      return 'ROLLUP';
    default:
      return 'OVERVIEW';
  }
}

function toPacketDetail(value: string | undefined): KnowledgePacketDetail {
  switch (value) {
    case 'COMPACT':
      return 'compact';
    case 'DETAILED':
      return 'detailed';
    default:
      return 'standard';
  }
}

function toPacketDetailEnum(value: string | undefined): string {
  switch (value) {
    case 'compact':
      return 'COMPACT';
    case 'detailed':
      return 'DETAILED';
    default:
      return 'STANDARD';
  }
}

function toJobMode(value: string | undefined): 'inline' | 'background' {
  return value === 'INLINE' ? 'inline' : 'background';
}

function toJobModeEnum(value: string | undefined): string {
  return value === 'inline' ? 'INLINE' : 'BACKGROUND';
}

function mapProjectionTarget<T extends { kind?: string }>(target: T): T & { kind: string } {
  return {
    ...target,
    kind: toProjectionEnum(target.kind),
  };
}

function mapProjectionBundle<T extends { target: { kind?: string }; pages: readonly unknown[] }>(bundle: T): T & { target: { kind: string } } {
  return {
    ...bundle,
    target: mapProjectionTarget(bundle.target),
  };
}

function mapPacket<T extends { detail?: string }>(packet: T): T & { detail: string } {
  return {
    ...packet,
    detail: toPacketDetailEnum(packet.detail),
  };
}

function mapJob<T extends { defaultMode?: string }>(job: T): T & { defaultMode: string } {
  return {
    ...job,
    defaultMode: toJobModeEnum(job.defaultMode),
  };
}

function mapJobRun<T extends { mode?: string }>(run: T): T & { mode: string } {
  return {
    ...run,
    mode: toJobModeEnum(run.mode),
  };
}

function clampInt(value: number | null | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Number(value)) : fallback;
}

function clampOffset(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function pickOperation(document: DocumentNode, operationName?: string): 'query' | 'mutation' {
  const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length === 0) {
    throw new Error('Knowledge GraphQL request did not contain an operation definition.');
  }
  const normalize = (value: string): 'query' | 'mutation' => {
    if (value === 'query' || value === 'mutation') return value;
    throw new Error(`Knowledge GraphQL does not support ${value} operations.`);
  };
  if (operationName) {
    const named = operations.find((definition) => definition.name?.value === operationName);
    if (!named) throw new Error(`Unknown GraphQL operation: ${operationName}`);
    return normalize(named.operation);
  }
  if (operations.length === 1) return normalize(operations[0]!.operation);
  return operations.some((definition) => definition.operation === 'mutation') ? 'mutation' : 'query';
}

export interface KnowledgeGraphqlAccessProfile {
  readonly operation: 'query' | 'mutation';
  readonly requiredScopes: readonly string[];
  readonly adminRequired: boolean;
}

export function inspectKnowledgeGraphqlAccess(
  source: string,
  operationName?: string,
): KnowledgeGraphqlAccessProfile {
  const document = parse(source);
  const operation = pickOperation(document, operationName);
  return operation === 'mutation'
    ? { operation, requiredScopes: ['write:knowledge'], adminRequired: true }
    : { operation, requiredScopes: ['read:knowledge'], adminRequired: false };
}

interface KnowledgeGraphqlContext {
  readonly service: KnowledgeService;
  readonly admin: boolean;
  readonly scopes: readonly string[];
}

function assertWriteAccess(context: KnowledgeGraphqlContext): void {
  if (!context.admin) {
    throw new GraphQLError('Knowledge GraphQL mutation requires admin access.');
  }
  if (!context.scopes.includes('write:knowledge')) {
    throw new GraphQLError('Knowledge GraphQL mutation requires write:knowledge.');
  }
}

export interface KnowledgeGraphqlExecuteInput {
  readonly query: string;
  readonly operationName?: string;
  readonly variables?: Record<string, unknown>;
  readonly admin: boolean;
  readonly scopes: readonly string[];
}

export class KnowledgeGraphqlService {
  private static readonly schema = (() => {
    const schema = buildSchema(KNOWLEDGE_GRAPHQL_SDL);
    installJsonScalar(schema);
    return schema;
  })();

  private static readonly schemaSdl = printSchema(KnowledgeGraphqlService.schema);

  constructor(private readonly service: KnowledgeService) {}

  get schemaText(): string {
    return KnowledgeGraphqlService.schemaSdl;
  }

  async execute(input: KnowledgeGraphqlExecuteInput) {
    const rootValue = this.createRootValue();
    const context: KnowledgeGraphqlContext = {
      service: this.service,
      admin: input.admin,
      scopes: [...input.scopes],
    };
    const result = await graphql({
      schema: KnowledgeGraphqlService.schema,
      source: input.query,
      rootValue,
      contextValue: context,
      variableValues: input.variables,
      operationName: input.operationName,
    });
    return result;
  }

  private createRootValue() {
    return {
      status: async () => this.service.getStatus(),
      sources: ({ limit }: { limit?: number }) => this.service.listSources(clampInt(limit, 100)),
      nodes: ({ limit }: { limit?: number }) => this.service.listNodes(clampInt(limit, 100)),
      issues: ({ limit }: { limit?: number }) => this.service.listIssues(clampInt(limit, 100)),
      source: ({ id }: { id: string }) => this.service.listSources(10_000).find((source) => source.id === id) ?? null,
      node: ({ id }: { id: string }) => this.service.listNodes(10_000).find((node) => node.id === id) ?? null,
      issue: ({ id }: { id: string }) => this.service.listIssues(10_000).find((issue) => issue.id === id) ?? null,
      item: ({ id }: { id: string }) => this.service.getItem(id),
      items: ({ ids }: { ids: string[] }) => this.service.getItems(ids),
      sourcesConnection: (args: {
        limit?: number;
        offset?: number;
        status?: string;
        connectorId?: string;
        sourceType?: string;
        tag?: string;
        query?: string;
      }) => this.service.querySources({
        limit: clampInt(args.limit, 100),
        offset: clampOffset(args.offset),
        status: args.status,
        connectorId: args.connectorId,
        sourceType: args.sourceType,
        tag: args.tag,
        query: args.query,
      }),
      nodesConnection: (args: { limit?: number; offset?: number; kind?: string; status?: string; query?: string }) => this.service.queryNodes({
        limit: clampInt(args.limit, 100),
        offset: clampOffset(args.offset),
        kind: args.kind,
        status: args.status,
        query: args.query,
      }),
      issuesConnection: (args: { limit?: number; offset?: number; severity?: string; status?: string; code?: string; query?: string }) => this.service.queryIssues({
        limit: clampInt(args.limit, 100),
        offset: clampOffset(args.offset),
        severity: args.severity,
        status: args.status,
        code: args.code,
        query: args.query,
      }),
      extractions: ({ limit, sourceId }: { limit?: number; sourceId?: string }) => this.service.listExtractions(clampInt(limit, 100), sourceId),
      sourceExtraction: ({ sourceId }: { sourceId: string }) => this.service.getSourceExtraction(sourceId),
      neighbors: ({ kind, id, relation, limit }: { kind: 'source' | 'node'; id: string; relation?: string; limit?: number }) => {
        if (kind !== 'source' && kind !== 'node') {
          throw new GraphQLError(`Unsupported knowledge neighbor kind: ${kind}`);
        }
        return this.service.getNeighbors(kind, id, { relation, limit: clampInt(limit, 20) });
      },
      search: ({ query, limit }: { query: string; limit?: number }) => this.service.search(query, clampInt(limit, 10)),
      packet: async ({ task, writeScope, limit, detail, budgetLimit }: { task: string; writeScope?: string[]; limit?: number; detail?: string; budgetLimit?: number }) => mapPacket(await this.service.buildPacket(
        task,
        writeScope ?? [],
        clampInt(limit, 6),
        {
          detail: toPacketDetail(detail),
          ...(typeof budgetLimit === 'number' ? { budgetLimit } : {}),
        },
      )),
      connectors: () => this.service.listConnectors(),
      connector: ({ id }: { id: string }) => this.service.getConnector(id),
      connectorDoctor: ({ id }: { id: string }) => this.service.doctorConnector(id),
      projectionTargets: async ({ limit }: { limit?: number }) => (await this.service.listProjectionTargets(clampInt(limit, 25))).map((target) => mapProjectionTarget(target)),
      projection: async ({ kind, id, limit }: { kind: string; id?: string; limit?: number }) => mapProjectionBundle(await this.service.renderProjection({
        kind: toProjectionKind(kind),
        id,
        limit: clampInt(limit, 12),
      })),
      jobs: () => this.service.listJobs().map((job) => mapJob(job)),
      job: ({ id }: { id: string }) => {
        const job = this.service.getJob(id);
        return job ? mapJob(job) : null;
      },
      jobRuns: ({ limit, jobId }: { limit?: number; jobId?: string }) => this.service.listJobRuns(clampInt(limit, 25), jobId).map((run) => mapJobRun(run)),
      usage: ({ limit, targetKind, targetId, usageKind }: { limit?: number; targetKind?: 'source' | 'node' | 'issue'; targetId?: string; usageKind?: string }) => (
        this.service.listUsageRecords(clampInt(limit, 100), {
          ...(targetKind ? { targetKind } : {}),
          ...(targetId ? { targetId } : {}),
          ...(usageKind ? { usageKind: usageKind as 'search-hit' | 'packet-item' | 'item-open' | 'neighbor-open' | 'projection-read' | 'multimodal-writeback' } : {}),
        })
      ),
      consolidationCandidates: ({ limit, status, subjectKind, subjectId }: { limit?: number; status?: string; subjectKind?: 'source' | 'node' | 'issue'; subjectId?: string }) => (
        this.service.listConsolidationCandidates(clampInt(limit, 100), {
          ...(status ? { status: status as 'open' | 'accepted' | 'rejected' | 'superseded' } : {}),
          ...(subjectKind ? { subjectKind } : {}),
          ...(subjectId ? { subjectId } : {}),
        })
      ),
      consolidationCandidate: ({ id }: { id: string }) => this.service.getConsolidationCandidate(id),
      consolidationReports: ({ limit }: { limit?: number }) => this.service.listConsolidationReports(clampInt(limit, 100)),
      consolidationReport: ({ id }: { id: string }) => this.service.getConsolidationReport(id),
      schedules: ({ limit }: { limit?: number }) => this.service.listSchedules(clampInt(limit, 100)),
      schedule: ({ id }: { id: string }) => this.service.getSchedule(id),
      ingestUrl: async (
        args: {
          url: string;
          title?: string;
          tags?: string[];
          folderPath?: string;
          sessionId?: string;
          sourceType?: string;
          connectorId?: string;
          metadata?: Record<string, unknown>;
        },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        const result = await this.service.ingestUrl({
          url: args.url,
          title: args.title,
          tags: args.tags,
          folderPath: args.folderPath,
          sessionId: args.sessionId,
          sourceType: args.sourceType as Parameters<KnowledgeService['ingestUrl']>[0]['sourceType'],
          connectorId: args.connectorId,
          metadata: args.metadata,
        });
        return result.source;
      },
      ingestArtifact: async (
        args: {
          artifactId?: string;
          path?: string;
          uri?: string;
          title?: string;
          tags?: string[];
          folderPath?: string;
          sessionId?: string;
          sourceType?: string;
          connectorId?: string;
          metadata?: Record<string, unknown>;
        },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        const result = await this.service.ingestArtifact({
          artifactId: args.artifactId,
          path: args.path,
          uri: args.uri,
          title: args.title,
          tags: args.tags,
          folderPath: args.folderPath,
          sessionId: args.sessionId,
          sourceType: args.sourceType as Parameters<KnowledgeService['ingestArtifact']>[0]['sourceType'],
          connectorId: args.connectorId,
          metadata: args.metadata,
        });
        return result.source;
      },
      importBookmarks: async (
        args: { path: string; sessionId?: string },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return this.service.importBookmarksFromFile(args);
      },
      importUrls: async (
        args: { path: string; sessionId?: string },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return this.service.importUrlsFromFile(args);
      },
      ingestConnector: async (
        args: { connectorId: string; input?: unknown; content?: string; path?: string; sessionId?: string },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return this.service.ingestConnectorInput(args);
      },
      lint: async (_args: Record<string, never>, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.lint();
      },
      reindex: async (_args: Record<string, never>, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.reindex();
      },
      runJob: async (
        args: { id: string; mode?: string; sourceIds?: string[]; limit?: number },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return mapJobRun(await this.service.runJob(args.id, {
          ...(args.mode ? { mode: toJobMode(args.mode) } : {}),
          ...(args.sourceIds ? { sourceIds: args.sourceIds } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        }));
      },
      decideCandidate: async (
        args: { id: string; decision: 'accept' | 'reject' | 'supersede'; decidedBy?: string; memoryClass?: string; scope?: string; detail?: string },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return this.service.decideConsolidationCandidate(args.id, args.decision, {
          decidedBy: args.decidedBy,
          memoryClass: args.memoryClass,
          scope: args.scope,
          detail: args.detail,
        });
      },
      saveSchedule: async (
        args: { id?: string; jobId: string; label?: string; enabled?: boolean; schedule: Record<string, unknown> },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return this.service.saveSchedule({
          id: args.id,
          jobId: args.jobId,
          label: args.label,
          enabled: args.enabled,
          schedule: args.schedule as unknown as Parameters<KnowledgeService['saveSchedule']>[0]['schedule'],
        });
      },
      deleteSchedule: async (
        args: { id: string },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return this.service.deleteSchedule(args.id);
      },
      setScheduleEnabled: async (
        args: { id: string; enabled: boolean },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return this.service.setScheduleEnabled(args.id, args.enabled);
      },
      materializeProjection: async (
        args: { kind: string; id?: string; limit?: number; filename?: string },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        const materialized = await this.service.materializeProjection({
          kind: toProjectionKind(args.kind),
          id: args.id,
          limit: clampInt(args.limit, 12),
          filename: args.filename,
        });
        return {
          ...materialized,
          bundle: mapProjectionBundle(materialized.bundle),
        };
      },
    };
  }
}
