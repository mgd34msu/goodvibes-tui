import {
  GraphQLError,
  GraphQLScalarType,
  Kind,
  buildSchema,
  type DocumentNode,
  type ValueNode,
} from 'graphql';
import type { KnowledgePacketDetail, KnowledgeProjectionTargetKind } from './types.ts';

export const KNOWLEDGE_GRAPHQL_SDL = `
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
    sourceUri: String
    createdAt: Float!
    metadata: JSON
  }

  type KnowledgeJob {
    id: String!
    label: String!
    description: String!
    defaultMode: KnowledgeJobMode!
    triggerKinds: [String!]!
    lastRunAt: Float
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

  type KnowledgeBatchIngestResult {
    imported: Int!
    failed: Int!
    sources: [KnowledgeSource!]!
    errors: [String!]!
  }

  type KnowledgeUsageRecord {
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
    schedule: JSON!
    lastRunAt: Float
    nextRunAt: Float
    metadata: JSON
    createdAt: Float!
    updatedAt: Float!
  }

  input KnowledgeJobRunInput {
    mode: KnowledgeJobMode
  }

  input KnowledgePacketInput {
    task: String!
    writeScope: [String!]
    limit: Int
    detail: KnowledgePacketDetail
    budgetLimit: Int
  }

  type Query {
    status: KnowledgeStatus!
    connectors: [KnowledgeConnector!]!
    connectorDoctor(id: String!): KnowledgeConnectorDoctorReport
    sources(limit: Int, offset: Int): [KnowledgeSource!]!
    nodes(limit: Int, offset: Int): [KnowledgeNode!]!
    issues(limit: Int, offset: Int): [KnowledgeIssue!]!
    itemView(kind: String!, id: String!): KnowledgeItemView
    extractions(limit: Int, sourceId: String): [KnowledgeExtraction!]!
    neighbors(kind: String!, id: String!, relation: String, limit: Int): [KnowledgeEdge!]!
    search(query: String!, limit: Int): [KnowledgeSearchResult!]!
    packet(task: String!, writeScope: [String!], limit: Int, detail: KnowledgePacketDetail, budgetLimit: Int): KnowledgePacket!
    projectionTargets(limit: Int): [KnowledgeProjectionTarget!]!
    projection(kind: KnowledgeProjectionKind!, id: String, limit: Int): KnowledgeProjectionBundle!
    jobs: [KnowledgeJob!]!
    job(id: String!): KnowledgeJob
    jobRuns(limit: Int, jobId: String): [KnowledgeJobRun!]!
    usage(limit: Int, targetKind: String, targetId: String, usageKind: String): [KnowledgeUsageRecord!]!
    usageRecords(limit: Int, targetKind: String, targetId: String, usageKind: String): [KnowledgeUsageRecord!]!
    consolidationCandidates(limit: Int, status: String): [KnowledgeConsolidationCandidate!]!
    consolidationReports(limit: Int): [KnowledgeConsolidationReport!]!
    schedules(limit: Int): [KnowledgeSchedule!]!
    sourceExtraction(sourceId: String!): KnowledgeExtraction
  }

  type Mutation {
    ingestUrl(url: String!, sourceType: String, connectorId: String, folderPath: String, tags: [String!], sessionId: String): KnowledgeSource!
    ingestArtifact(path: String!, connectorId: String, tags: [String!], sessionId: String): KnowledgeSource!
    importBookmarksFromFile(path: String!, sessionId: String): KnowledgeBatchIngestResult!
    importUrlsFromFile(path: String!, sessionId: String): KnowledgeBatchIngestResult!
    ingestBookmarkSeeds(seeds: [String!]!, connectorId: String, sessionId: String): KnowledgeBatchIngestResult!
    ingestWithConnector(connectorId: String!, input: String!, sessionId: String): KnowledgeBatchIngestResult!
    ingestConnectorInput(input: String!, connectorId: String, sessionId: String): KnowledgeBatchIngestResult!
    renderProjection(kind: KnowledgeProjectionKind!, id: String, limit: Int): KnowledgeProjectionBundle!
    materializeProjection(kind: KnowledgeProjectionKind!, id: String, limit: Int): KnowledgeMaterializedProjection!
    reindex: KnowledgeStatus!
    runJob(id: String!, mode: KnowledgeJobMode): KnowledgeJobRun!
    saveSchedule(id: String, jobId: String!, label: String!, enabled: Boolean!, schedule: JSON!, metadata: JSON): KnowledgeSchedule!
    deleteSchedule(id: String!): Boolean!
    setScheduleEnabled(id: String!, enabled: Boolean!): KnowledgeSchedule
    decideConsolidationCandidate(id: String!, status: String!, decidedBy: String): KnowledgeConsolidationCandidate!
    lint: [KnowledgeIssue!]!
  }

  type KnowledgeMaterializedProjection {
    artifact: ArtifactDescriptor!
    bundle: KnowledgeProjectionBundle!
  }
`;

export function parseJsonAst(node: ValueNode): unknown {
  switch (node.kind) {
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.INT:
      return Number.parseInt(node.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(node.value);
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map(parseJsonAst);
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((field) => [field.name.value, parseJsonAst(field.value)]));
    default:
      return null;
  }
}

export function installJsonScalar(schema: ReturnType<typeof buildSchema>): void {
  const type = schema.getType('JSON');
  if (!(type instanceof GraphQLScalarType)) {
    throw new GraphQLError('Knowledge GraphQL schema is missing JSON scalar.');
  }
  type.parseValue = (value) => value;
  type.serialize = (value) => value;
  type.parseLiteral = (node) => parseJsonAst(node);
}

export function toProjectionKind(value: string): KnowledgeProjectionTargetKind {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'OVERVIEW' || normalized === 'BUNDLE' || normalized === 'SOURCE' || normalized === 'NODE' || normalized === 'ISSUE' || normalized === 'DASHBOARD' || normalized === 'ROLLUP') {
    switch (normalized) {
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
        return 'overview';
    }
  }
  throw new GraphQLError(`Unknown projection kind: ${value}`);
}

export function toProjectionEnum(value: string | undefined): string {
  switch (toProjectionKind(value ?? 'OVERVIEW')) {
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
  }
}

export function toPacketDetail(value: string | undefined): KnowledgePacketDetail {
  const normalized = (value ?? 'standard').trim().toLowerCase();
  if (normalized === 'compact' || normalized === 'standard' || normalized === 'detailed') {
    return normalized;
  }
  throw new GraphQLError(`Unknown packet detail: ${value}`);
}

export function toPacketDetailEnum(value: string | undefined): string {
  return toPacketDetail(value).toUpperCase();
}

export function toJobMode(value: string | undefined): 'inline' | 'background' {
  return (value ?? 'background').trim().toLowerCase() === 'inline' ? 'inline' : 'background';
}

export function toJobModeEnum(value: string | undefined): string {
  return toJobMode(value).toUpperCase();
}

export function mapProjectionTarget<T extends { kind?: string }>(target: T): T & { kind: string } {
  return {
    ...target,
    kind: toProjectionEnum(target.kind),
  };
}

export function mapProjectionBundle<T extends { target: { kind?: string }; pages: readonly unknown[] }>(bundle: T): T & { target: { kind: string } } {
  return {
    ...bundle,
    target: mapProjectionTarget(bundle.target),
  };
}

export function mapPacket<T extends { detail?: string }>(packet: T): T & { detail: string } {
  return {
    ...packet,
    detail: toPacketDetailEnum(packet.detail),
  };
}

export function mapJob<T extends { defaultMode?: string }>(job: T): T & { defaultMode: string } {
  return {
    ...job,
    defaultMode: toJobModeEnum(job.defaultMode),
  };
}

export function mapJobRun<T extends { mode?: string }>(run: T): T & { mode: string } {
  return {
    ...run,
    mode: toJobModeEnum(run.mode),
  };
}

export function clampInt(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function clampOffset(value: number | null | undefined): number {
  return Math.max(0, clampInt(value, 0));
}

export function pickOperation(document: DocumentNode, operationName?: string): 'query' | 'mutation' {
  const operation = document.definitions.find((definition) => definition.kind === Kind.OPERATION_DEFINITION && (!operationName || definition.name?.value === operationName));
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) {
    throw new GraphQLError(`Operation not found: ${operationName ?? 'default'}`);
  }
  if (operation.operation === 'subscription') {
    throw new GraphQLError('Knowledge GraphQL subscriptions are not supported.');
  }
  return operation.operation;
}
