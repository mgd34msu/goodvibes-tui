import type { AutomationScheduleDefinition } from '../automation/schedules.ts';

export type KnowledgeSourceType =
  | 'url'
  | 'bookmark'
  | 'bookmark-list'
  | 'document'
  | 'repo'
  | 'dataset'
  | 'image'
  | 'manual'
  | 'other';

export type KnowledgeSourceStatus = 'pending' | 'indexed' | 'failed' | 'stale';

export type KnowledgeNodeKind =
  | 'domain'
  | 'bookmark_folder'
  | 'topic'
  | 'memory'
  | 'project'
  | 'capability'
  | 'repo'
  | 'service'
  | 'provider'
  | 'environment'
  | 'user'
  | 'source_group'
  | 'other';

export type KnowledgeNodeStatus = 'active' | 'draft' | 'stale';

export type KnowledgeReferenceKind = 'source' | 'node' | 'artifact' | 'memory' | 'session';

export type KnowledgeIssueSeverity = 'info' | 'warning' | 'error';
export type KnowledgeExtractionFormat =
  | 'text'
  | 'markdown'
  | 'html'
  | 'json'
  | 'csv'
  | 'tsv'
  | 'xml'
  | 'yaml'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'pdf'
  | 'unknown';
export type KnowledgePacketDetail = 'compact' | 'standard' | 'detailed';
export type KnowledgeJobMode = 'inline' | 'background';
export type KnowledgeJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type KnowledgeJobKind =
  | 'lint'
  | 'reindex'
  | 'refresh-stale'
  | 'refresh-bookmarks'
  | 'rebuild-projections'
  | 'light-consolidation'
  | 'deep-consolidation';
export type KnowledgeUsageKind =
  | 'search-hit'
  | 'packet-item'
  | 'item-open'
  | 'neighbor-open'
  | 'projection-read'
  | 'multimodal-writeback';
export type KnowledgeUsageTargetKind = 'source' | 'node' | 'issue';
export type KnowledgeConsolidationCandidateType =
  | 'memory-promotion'
  | 'memory-review'
  | 'source-refresh'
  | 'knowledge-gap';
export type KnowledgeConsolidationStatus = 'open' | 'accepted' | 'rejected' | 'superseded';

export interface KnowledgeSourceRecord {
  readonly id: string;
  readonly connectorId: string;
  readonly sourceType: KnowledgeSourceType;
  readonly title?: string;
  readonly sourceUri?: string;
  readonly canonicalUri?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly folderPath?: string;
  readonly status: KnowledgeSourceStatus;
  readonly artifactId?: string;
  readonly contentHash?: string;
  readonly lastCrawledAt?: number;
  readonly crawlError?: string;
  readonly sessionId?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeNodeRecord {
  readonly id: string;
  readonly kind: KnowledgeNodeKind;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string;
  readonly aliases: readonly string[];
  readonly status: KnowledgeNodeStatus;
  readonly confidence: number;
  readonly sourceId?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeEdgeRecord {
  readonly id: string;
  readonly fromKind: KnowledgeReferenceKind;
  readonly fromId: string;
  readonly toKind: KnowledgeReferenceKind;
  readonly toId: string;
  readonly relation: string;
  readonly weight: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeIssueRecord {
  readonly id: string;
  readonly severity: KnowledgeIssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly status: 'open' | 'resolved';
  readonly sourceId?: string;
  readonly nodeId?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeExtractionRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly artifactId?: string;
  readonly extractorId: string;
  readonly format: KnowledgeExtractionFormat;
  readonly title?: string;
  readonly summary?: string;
  readonly excerpt?: string;
  readonly sections: readonly string[];
  readonly links: readonly string[];
  readonly estimatedTokens: number;
  readonly structure: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeJobRecord {
  readonly id: string;
  readonly kind: KnowledgeJobKind;
  readonly title: string;
  readonly description: string;
  readonly defaultMode: KnowledgeJobMode;
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeJobRunRecord {
  readonly id: string;
  readonly jobId: string;
  readonly status: KnowledgeJobStatus;
  readonly mode: KnowledgeJobMode;
  readonly requestedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly result: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeUsageRecord {
  readonly id: string;
  readonly targetKind: KnowledgeUsageTargetKind;
  readonly targetId: string;
  readonly usageKind: KnowledgeUsageKind;
  readonly task?: string;
  readonly sessionId?: string;
  readonly score?: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
}

export interface KnowledgeConsolidationCandidateRecord {
  readonly id: string;
  readonly candidateType: KnowledgeConsolidationCandidateType;
  readonly status: KnowledgeConsolidationStatus;
  readonly subjectKind: KnowledgeUsageTargetKind;
  readonly subjectId: string;
  readonly title: string;
  readonly summary?: string;
  readonly score: number;
  readonly evidence: readonly string[];
  readonly suggestedMemoryClass?: string;
  readonly suggestedScope?: string;
  readonly decidedAt?: number;
  readonly decidedBy?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeConsolidationReportRecord {
  readonly id: string;
  readonly kind: Extract<KnowledgeJobKind, 'light-consolidation' | 'deep-consolidation'>;
  readonly title: string;
  readonly summary: string;
  readonly highlights: readonly string[];
  readonly metrics: Record<string, number>;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeScheduleRecord {
  readonly id: string;
  readonly jobId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly schedule: AutomationScheduleDefinition;
  readonly lastRunAt?: number;
  readonly nextRunAt?: number;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KnowledgeSourceUpsertInput {
  readonly id?: string;
  readonly connectorId: string;
  readonly sourceType: KnowledgeSourceType;
  readonly title?: string;
  readonly sourceUri?: string;
  readonly canonicalUri?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly folderPath?: string;
  readonly status: KnowledgeSourceStatus;
  readonly artifactId?: string;
  readonly contentHash?: string;
  readonly lastCrawledAt?: number;
  readonly crawlError?: string;
  readonly sessionId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeNodeUpsertInput {
  readonly id?: string;
  readonly kind: KnowledgeNodeKind;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string;
  readonly aliases?: readonly string[];
  readonly status?: KnowledgeNodeStatus;
  readonly confidence?: number;
  readonly sourceId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeEdgeUpsertInput {
  readonly fromKind: KnowledgeReferenceKind;
  readonly fromId: string;
  readonly toKind: KnowledgeReferenceKind;
  readonly toId: string;
  readonly relation: string;
  readonly weight?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeIssueUpsertInput {
  readonly id?: string;
  readonly severity: KnowledgeIssueSeverity;
  readonly code: string;
  readonly message: string;
  readonly status?: 'open' | 'resolved';
  readonly sourceId?: string;
  readonly nodeId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeExtractionUpsertInput {
  readonly id?: string;
  readonly sourceId: string;
  readonly artifactId?: string;
  readonly extractorId: string;
  readonly format: KnowledgeExtractionFormat;
  readonly title?: string;
  readonly summary?: string;
  readonly excerpt?: string;
  readonly sections?: readonly string[];
  readonly links?: readonly string[];
  readonly estimatedTokens?: number;
  readonly structure?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeJobRunUpsertInput {
  readonly id?: string;
  readonly jobId: string;
  readonly status: KnowledgeJobStatus;
  readonly mode: KnowledgeJobMode;
  readonly requestedAt?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly result?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeUsageUpsertInput {
  readonly id?: string;
  readonly targetKind: KnowledgeUsageTargetKind;
  readonly targetId: string;
  readonly usageKind: KnowledgeUsageKind;
  readonly task?: string;
  readonly sessionId?: string;
  readonly score?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeConsolidationCandidateUpsertInput {
  readonly id?: string;
  readonly candidateType: KnowledgeConsolidationCandidateType;
  readonly status?: KnowledgeConsolidationStatus;
  readonly subjectKind: KnowledgeUsageTargetKind;
  readonly subjectId: string;
  readonly title: string;
  readonly summary?: string;
  readonly score: number;
  readonly evidence?: readonly string[];
  readonly suggestedMemoryClass?: string;
  readonly suggestedScope?: string;
  readonly decidedAt?: number;
  readonly decidedBy?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeConsolidationReportUpsertInput {
  readonly id?: string;
  readonly kind: Extract<KnowledgeJobKind, 'light-consolidation' | 'deep-consolidation'>;
  readonly title: string;
  readonly summary: string;
  readonly highlights?: readonly string[];
  readonly metrics?: Record<string, number>;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeScheduleUpsertInput {
  readonly id?: string;
  readonly jobId: string;
  readonly label: string;
  readonly enabled?: boolean;
  readonly schedule: AutomationScheduleDefinition;
  readonly lastRunAt?: number;
  readonly nextRunAt?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeStatus {
  readonly ready: boolean;
  readonly storagePath: string;
  readonly sourceCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly issueCount: number;
  readonly extractionCount: number;
  readonly jobRunCount: number;
  readonly usageCount: number;
  readonly candidateCount: number;
  readonly reportCount: number;
  readonly scheduleCount: number;
}

export interface KnowledgeSearchResult {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly score: number;
  readonly reason: string;
  readonly source?: KnowledgeSourceRecord;
  readonly node?: KnowledgeNodeRecord;
}

export interface KnowledgePacketItem {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly uri?: string;
  readonly reason: string;
  readonly score: number;
  readonly estimatedTokens: number;
  readonly related: readonly string[];
  readonly evidence: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgePacket {
  readonly task: string;
  readonly writeScope: readonly string[];
  readonly generatedAt: number;
  readonly detail: KnowledgePacketDetail;
  readonly strategy: string;
  readonly budgetLimit: number;
  readonly estimatedTokens: number;
  readonly items: readonly KnowledgePacketItem[];
}

export interface KnowledgeItemView {
  readonly source?: KnowledgeSourceRecord;
  readonly node?: KnowledgeNodeRecord;
  readonly issue?: KnowledgeIssueRecord;
  readonly relatedEdges: readonly KnowledgeEdgeRecord[];
  readonly linkedSources: readonly KnowledgeSourceRecord[];
  readonly linkedNodes: readonly KnowledgeNodeRecord[];
}

export interface KnowledgeBookmarkSeed {
  readonly url: string;
  readonly title?: string;
  readonly folderPath?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeConnectorParseResult {
  readonly seeds: readonly KnowledgeBookmarkSeed[];
  readonly connectorId?: string;
  readonly sourceType?: KnowledgeSourceType;
}

export interface KnowledgeConnectorSetupField {
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'path' | 'uri' | 'secret' | 'token' | 'choice';
  readonly optional?: boolean;
  readonly source?: 'inline' | 'env' | 'goodvibes' | 'bitwarden' | 'vaultwarden' | 'bws' | 'manual';
  readonly description?: string;
}

export interface KnowledgeConnectorSetupContract {
  readonly version: string;
  readonly summary: string;
  readonly transportHints?: readonly string[];
  readonly steps?: readonly string[];
  readonly fields?: readonly KnowledgeConnectorSetupField[];
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeConnectorDoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
  readonly metadata?: Record<string, unknown>;
}

export interface KnowledgeConnectorDoctorReport {
  readonly connectorId: string;
  readonly ready: boolean;
  readonly summary: string;
  readonly checks: readonly KnowledgeConnectorDoctorCheck[];
  readonly hints: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeConnector<Input = unknown> {
  readonly id: string;
  readonly displayName?: string;
  readonly version?: string;
  readonly description: string;
  readonly sourceType: KnowledgeSourceType;
  readonly inputSchema?: Record<string, unknown>;
  readonly examples?: readonly unknown[];
  readonly capabilities?: readonly string[];
  readonly setup?: KnowledgeConnectorSetupContract;
  readonly metadata?: Record<string, unknown>;
  resolve(input: Input): KnowledgeConnectorParseResult | Promise<KnowledgeConnectorParseResult>;
  doctor?(): KnowledgeConnectorDoctorReport | Promise<KnowledgeConnectorDoctorReport>;
}

export interface KnowledgeIngestResult {
  readonly source: KnowledgeSourceRecord;
  readonly artifactId?: string;
  readonly issues: readonly KnowledgeIssueRecord[];
}

export interface KnowledgeBatchIngestResult {
  readonly imported: number;
  readonly failed: number;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly errors: readonly string[];
}

export type KnowledgeProjectionTargetKind = 'overview' | 'bundle' | 'source' | 'node' | 'issue' | 'dashboard' | 'rollup';

export interface KnowledgeProjectionTarget {
  readonly targetId: string;
  readonly kind: KnowledgeProjectionTargetKind;
  readonly title: string;
  readonly description: string;
  readonly itemId?: string;
  readonly defaultPath: string;
  readonly defaultFilename: string;
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeProjectionPage {
  readonly path: string;
  readonly title: string;
  readonly format: 'markdown';
  readonly content: string;
  readonly itemIds: readonly string[];
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeProjectionBundle {
  readonly id: string;
  readonly target: KnowledgeProjectionTarget;
  readonly generatedAt: number;
  readonly pageCount: number;
  readonly pages: readonly KnowledgeProjectionPage[];
  readonly metadata: Record<string, unknown>;
}

export interface KnowledgeMaterializedProjection {
  readonly bundle: KnowledgeProjectionBundle;
  readonly artifact: {
    readonly id: string;
    readonly kind: string;
    readonly mimeType: string;
    readonly filename?: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly createdAt: number;
    readonly expiresAt?: number;
    readonly sourceUri?: string;
    readonly metadata: Record<string, unknown>;
  };
}
