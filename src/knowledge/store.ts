import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SQLiteStore } from '../state/sqlite-store.ts';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationCandidateUpsertInput,
  KnowledgeConsolidationReportRecord,
  KnowledgeConsolidationReportUpsertInput,
  KnowledgeEdgeRecord,
  KnowledgeEdgeUpsertInput,
  KnowledgeExtractionRecord,
  KnowledgeExtractionUpsertInput,
  KnowledgeIssueRecord,
  KnowledgeIssueUpsertInput,
  KnowledgeItemView,
  KnowledgeJobRunRecord,
  KnowledgeJobRunUpsertInput,
  KnowledgeNodeRecord,
  KnowledgeNodeUpsertInput,
  KnowledgeScheduleRecord,
  KnowledgeScheduleUpsertInput,
  KnowledgeSourceRecord,
  KnowledgeSourceUpsertInput,
  KnowledgeStatus,
  KnowledgeUsageRecord,
  KnowledgeUsageUpsertInput,
} from './types.ts';

function resolveDefaultKnowledgeDbPath(): string {
  const runtime = globalThis as typeof globalThis & { __gvTestConfigDir?: string };
  const baseDir = runtime.__gvTestConfigDir ?? join(homedir(), '.goodvibes', 'tui');
  return join(baseDir, 'knowledge.sqlite');
}

function nowMs(): number {
  return Date.now();
}

function stableText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniq(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function createSchema(db: { run(sql: string): void }): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_sources (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT,
      source_uri TEXT,
      canonical_uri TEXT,
      summary TEXT,
      description TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      folder_path TEXT,
      status TEXT NOT NULL,
      artifact_id TEXT,
      content_hash TEXT,
      last_crawled_at INTEGER,
      crawl_error TEXT,
      session_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_sources_canonical_uri ON knowledge_sources(canonical_uri)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_sources_updated_at ON knowledge_sources(updated_at)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      source_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_nodes_kind_slug ON knowledge_nodes(kind, slug)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_updated_at ON knowledge_nodes(updated_at)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_edges (
      id TEXT PRIMARY KEY,
      from_kind TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_kind TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_edges_unique ON knowledge_edges(from_kind, from_id, to_kind, to_id, relation)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_issues (
      id TEXT PRIMARY KEY,
      severity TEXT NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      source_id TEXT,
      node_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_issues_code ON knowledge_issues(code)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_extractions (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      artifact_id TEXT,
      extractor_id TEXT NOT NULL,
      format TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      excerpt TEXT,
      sections TEXT NOT NULL DEFAULT '[]',
      links TEXT NOT NULL DEFAULT '[]',
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      structure TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_extractions_source_id ON knowledge_extractions(source_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_extractions_format ON knowledge_extractions(format)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      result TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_job_runs_job_id ON knowledge_job_runs(job_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_job_runs_requested_at ON knowledge_job_runs(requested_at)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_usage_records (
      id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      usage_kind TEXT NOT NULL,
      task TEXT,
      session_id TEXT,
      score REAL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_usage_target ON knowledge_usage_records(target_kind, target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_usage_created_at ON knowledge_usage_records(created_at)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_consolidation_candidates (
      id TEXT PRIMARY KEY,
      candidate_type TEXT NOT NULL,
      status TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      score REAL NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      suggested_memory_class TEXT,
      suggested_scope TEXT,
      decided_at INTEGER,
      decided_by TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_subject ON knowledge_consolidation_candidates(subject_kind, subject_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_status ON knowledge_consolidation_candidates(status)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_consolidation_reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      highlights TEXT NOT NULL DEFAULT '[]',
      metrics TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_reports_kind ON knowledge_consolidation_reports(kind)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_schedules (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      schedule TEXT NOT NULL,
      last_run_at INTEGER,
      next_run_at INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_schedules_job_id ON knowledge_schedules(job_id)`);
}

function mapSourceRow(columns: string[], values: unknown[]): KnowledgeSourceRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    connectorId: String(row.connector_id),
    sourceType: String(row.source_type) as KnowledgeSourceRecord['sourceType'],
    ...(stableText(row.title as string | undefined) ? { title: String(row.title) } : {}),
    ...(stableText(row.source_uri as string | undefined) ? { sourceUri: String(row.source_uri) } : {}),
    ...(stableText(row.canonical_uri as string | undefined) ? { canonicalUri: String(row.canonical_uri) } : {}),
    ...(stableText(row.summary as string | undefined) ? { summary: String(row.summary) } : {}),
    ...(stableText(row.description as string | undefined) ? { description: String(row.description) } : {}),
    tags: parseJsonValue<string[]>(row.tags, []),
    ...(stableText(row.folder_path as string | undefined) ? { folderPath: String(row.folder_path) } : {}),
    status: String(row.status) as KnowledgeSourceRecord['status'],
    ...(stableText(row.artifact_id as string | undefined) ? { artifactId: String(row.artifact_id) } : {}),
    ...(stableText(row.content_hash as string | undefined) ? { contentHash: String(row.content_hash) } : {}),
    ...(typeof row.last_crawled_at === 'number' ? { lastCrawledAt: row.last_crawled_at } : {}),
    ...(stableText(row.crawl_error as string | undefined) ? { crawlError: String(row.crawl_error) } : {}),
    ...(stableText(row.session_id as string | undefined) ? { sessionId: String(row.session_id) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapNodeRow(columns: string[], values: unknown[]): KnowledgeNodeRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    kind: String(row.kind) as KnowledgeNodeRecord['kind'],
    slug: String(row.slug),
    title: String(row.title),
    ...(stableText(row.summary as string | undefined) ? { summary: String(row.summary) } : {}),
    aliases: parseJsonValue<string[]>(row.aliases, []),
    status: String(row.status) as KnowledgeNodeRecord['status'],
    confidence: Number(row.confidence),
    ...(stableText(row.source_id as string | undefined) ? { sourceId: String(row.source_id) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapEdgeRow(columns: string[], values: unknown[]): KnowledgeEdgeRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    fromKind: String(row.from_kind) as KnowledgeEdgeRecord['fromKind'],
    fromId: String(row.from_id),
    toKind: String(row.to_kind) as KnowledgeEdgeRecord['toKind'],
    toId: String(row.to_id),
    relation: String(row.relation),
    weight: Number(row.weight),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapIssueRow(columns: string[], values: unknown[]): KnowledgeIssueRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    severity: String(row.severity) as KnowledgeIssueRecord['severity'],
    code: String(row.code),
    message: String(row.message),
    status: String(row.status) as KnowledgeIssueRecord['status'],
    ...(stableText(row.source_id as string | undefined) ? { sourceId: String(row.source_id) } : {}),
    ...(stableText(row.node_id as string | undefined) ? { nodeId: String(row.node_id) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapExtractionRow(columns: string[], values: unknown[]): KnowledgeExtractionRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    ...(stableText(row.artifact_id as string | undefined) ? { artifactId: String(row.artifact_id) } : {}),
    extractorId: String(row.extractor_id),
    format: String(row.format) as KnowledgeExtractionRecord['format'],
    ...(stableText(row.title as string | undefined) ? { title: String(row.title) } : {}),
    ...(stableText(row.summary as string | undefined) ? { summary: String(row.summary) } : {}),
    ...(stableText(row.excerpt as string | undefined) ? { excerpt: String(row.excerpt) } : {}),
    sections: parseJsonValue<string[]>(row.sections, []),
    links: parseJsonValue<string[]>(row.links, []),
    estimatedTokens: Number(row.estimated_tokens),
    structure: parseJsonValue<Record<string, unknown>>(row.structure, {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapJobRunRow(columns: string[], values: unknown[]): KnowledgeJobRunRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    status: String(row.status) as KnowledgeJobRunRecord['status'],
    mode: String(row.mode) as KnowledgeJobRunRecord['mode'],
    requestedAt: Number(row.requested_at),
    ...(typeof row.started_at === 'number' ? { startedAt: row.started_at } : {}),
    ...(typeof row.completed_at === 'number' ? { completedAt: row.completed_at } : {}),
    ...(stableText(row.error as string | undefined) ? { error: String(row.error) } : {}),
    result: parseJsonValue<Record<string, unknown>>(row.result, {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
  };
}

function mapUsageRow(columns: string[], values: unknown[]): KnowledgeUsageRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    targetKind: String(row.target_kind) as KnowledgeUsageRecord['targetKind'],
    targetId: String(row.target_id),
    usageKind: String(row.usage_kind) as KnowledgeUsageRecord['usageKind'],
    ...(stableText(row.task as string | undefined) ? { task: String(row.task) } : {}),
    ...(stableText(row.session_id as string | undefined) ? { sessionId: String(row.session_id) } : {}),
    ...(typeof row.score === 'number' ? { score: Number(row.score) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
  };
}

function mapCandidateRow(columns: string[], values: unknown[]): KnowledgeConsolidationCandidateRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    candidateType: String(row.candidate_type) as KnowledgeConsolidationCandidateRecord['candidateType'],
    status: String(row.status) as KnowledgeConsolidationCandidateRecord['status'],
    subjectKind: String(row.subject_kind) as KnowledgeConsolidationCandidateRecord['subjectKind'],
    subjectId: String(row.subject_id),
    title: String(row.title),
    ...(stableText(row.summary as string | undefined) ? { summary: String(row.summary) } : {}),
    score: Number(row.score),
    evidence: parseJsonValue<string[]>(row.evidence, []),
    ...(stableText(row.suggested_memory_class as string | undefined) ? { suggestedMemoryClass: String(row.suggested_memory_class) } : {}),
    ...(stableText(row.suggested_scope as string | undefined) ? { suggestedScope: String(row.suggested_scope) } : {}),
    ...(typeof row.decided_at === 'number' ? { decidedAt: Number(row.decided_at) } : {}),
    ...(stableText(row.decided_by as string | undefined) ? { decidedBy: String(row.decided_by) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapReportRow(columns: string[], values: unknown[]): KnowledgeConsolidationReportRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    kind: String(row.kind) as KnowledgeConsolidationReportRecord['kind'],
    title: String(row.title),
    summary: String(row.summary),
    highlights: parseJsonValue<string[]>(row.highlights, []),
    metrics: parseJsonValue<Record<string, number>>(row.metrics, {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapScheduleRow(columns: string[], values: unknown[]): KnowledgeScheduleRecord {
  const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    label: String(row.label),
    enabled: Number(row.enabled) === 1,
    schedule: parseJsonValue<KnowledgeScheduleRecord['schedule']>(row.schedule, { kind: 'every', intervalMs: 86_400_000 }),
    ...(typeof row.last_run_at === 'number' ? { lastRunAt: Number(row.last_run_at) } : {}),
    ...(typeof row.next_run_at === 'number' ? { nextRunAt: Number(row.next_run_at) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export interface KnowledgeStoreConfig {
  readonly dbPath?: string;
  readonly configManager?: {
    getControlPlaneConfigDir?: () => string;
  };
}

function resolveKnowledgeDbPath(config: KnowledgeStoreConfig = {}): string {
  const controlPlaneDir = typeof config.configManager?.getControlPlaneConfigDir === 'function'
    ? config.configManager.getControlPlaneConfigDir()
    : undefined;
  return config.dbPath
    ?? (controlPlaneDir ? join(controlPlaneDir, 'knowledge.sqlite') : resolveDefaultKnowledgeDbPath());
}

export class KnowledgeStore {
  private static active: KnowledgeStore | null = null;

  private readonly sqlite: SQLiteStore;
  private readonly dbPath: string;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private readonly sources = new Map<string, KnowledgeSourceRecord>();
  private readonly nodes = new Map<string, KnowledgeNodeRecord>();
  private readonly edges = new Map<string, KnowledgeEdgeRecord>();
  private readonly issues = new Map<string, KnowledgeIssueRecord>();
  private readonly extractions = new Map<string, KnowledgeExtractionRecord>();
  private readonly jobRuns = new Map<string, KnowledgeJobRunRecord>();
  private readonly usageRecords = new Map<string, KnowledgeUsageRecord>();
  private readonly consolidationCandidates = new Map<string, KnowledgeConsolidationCandidateRecord>();
  private readonly consolidationReports = new Map<string, KnowledgeConsolidationReportRecord>();
  private readonly schedules = new Map<string, KnowledgeScheduleRecord>();

  constructor(config: KnowledgeStoreConfig = {}) {
    this.dbPath = resolveKnowledgeDbPath(config);
    this.sqlite = new SQLiteStore(this.dbPath);
    void this.init();
    KnowledgeStore.active = this;
  }

  static getActive(config: KnowledgeStoreConfig = {}): KnowledgeStore {
    const requestedPath = resolveKnowledgeDbPath(config);
    if (!KnowledgeStore.active || KnowledgeStore.active.dbPath !== requestedPath) {
      KnowledgeStore.active = new KnowledgeStore({ ...config, dbPath: requestedPath });
    }
    return KnowledgeStore.active;
  }

  static resetActiveForTesting(): void {
    KnowledgeStore.active = null;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get storagePath(): string {
    return this.dbPath;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  status(): KnowledgeStatus {
    return {
      ready: this.ready,
      storagePath: this.dbPath,
      sourceCount: this.sources.size,
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      issueCount: this.issues.size,
      extractionCount: this.extractions.size,
      jobRunCount: this.jobRuns.size,
      usageCount: this.usageRecords.size,
      candidateCount: this.consolidationCandidates.size,
      reportCount: this.consolidationReports.size,
      scheduleCount: this.schedules.size,
    };
  }

  listSources(limit = 100): KnowledgeSourceRecord[] {
    return [...this.sources.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  listNodes(limit = 100): KnowledgeNodeRecord[] {
    return [...this.nodes.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  listEdges(): KnowledgeEdgeRecord[] {
    return [...this.edges.values()];
  }

  listIssues(limit = 100): KnowledgeIssueRecord[] {
    return [...this.issues.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  listExtractions(limit = 100): KnowledgeExtractionRecord[] {
    return [...this.extractions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  listJobRuns(limit = 100, jobId?: string): KnowledgeJobRunRecord[] {
    return [...this.jobRuns.values()]
      .filter((run) => !jobId || run.jobId === jobId)
      .sort((a, b) => (b.requestedAt - a.requestedAt) || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  listUsageRecords(limit = 100, input: {
    readonly targetKind?: KnowledgeUsageRecord['targetKind'];
    readonly targetId?: string;
    readonly usageKind?: KnowledgeUsageRecord['usageKind'];
  } = {}): KnowledgeUsageRecord[] {
    return [...this.usageRecords.values()]
      .filter((record) => (
        (!input.targetKind || record.targetKind === input.targetKind)
        && (!input.targetId || record.targetId === input.targetId)
        && (!input.usageKind || record.usageKind === input.usageKind)
      ))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  listConsolidationCandidates(limit = 100, input: {
    readonly status?: KnowledgeConsolidationCandidateRecord['status'];
    readonly subjectKind?: KnowledgeConsolidationCandidateRecord['subjectKind'];
    readonly subjectId?: string;
  } = {}): KnowledgeConsolidationCandidateRecord[] {
    return [...this.consolidationCandidates.values()]
      .filter((record) => (
        (!input.status || record.status === input.status)
        && (!input.subjectKind || record.subjectKind === input.subjectKind)
        && (!input.subjectId || record.subjectId === input.subjectId)
      ))
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  listConsolidationReports(limit = 100): KnowledgeConsolidationReportRecord[] {
    return [...this.consolidationReports.values()]
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  listSchedules(limit = 100): KnowledgeScheduleRecord[] {
    return [...this.schedules.values()]
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }

  getSource(id: string): KnowledgeSourceRecord | null {
    return this.sources.get(id) ?? null;
  }

  getNode(id: string): KnowledgeNodeRecord | null {
    return this.nodes.get(id) ?? null;
  }

  getIssue(id: string): KnowledgeIssueRecord | null {
    return this.issues.get(id) ?? null;
  }

  getExtraction(id: string): KnowledgeExtractionRecord | null {
    return this.extractions.get(id) ?? null;
  }

  getExtractionBySourceId(sourceId: string): KnowledgeExtractionRecord | null {
    for (const extraction of this.extractions.values()) {
      if (extraction.sourceId === sourceId) return extraction;
    }
    return null;
  }

  getJobRun(id: string): KnowledgeJobRunRecord | null {
    return this.jobRuns.get(id) ?? null;
  }

  getUsageRecord(id: string): KnowledgeUsageRecord | null {
    return this.usageRecords.get(id) ?? null;
  }

  getConsolidationCandidate(id: string): KnowledgeConsolidationCandidateRecord | null {
    return this.consolidationCandidates.get(id) ?? null;
  }

  getConsolidationCandidateBySubject(
    subjectKind: KnowledgeConsolidationCandidateRecord['subjectKind'],
    subjectId: string,
    candidateType: KnowledgeConsolidationCandidateRecord['candidateType'],
  ): KnowledgeConsolidationCandidateRecord | null {
    for (const candidate of this.consolidationCandidates.values()) {
      if (candidate.subjectKind === subjectKind && candidate.subjectId === subjectId && candidate.candidateType === candidateType) {
        return candidate;
      }
    }
    return null;
  }

  getConsolidationReport(id: string): KnowledgeConsolidationReportRecord | null {
    return this.consolidationReports.get(id) ?? null;
  }

  getSchedule(id: string): KnowledgeScheduleRecord | null {
    return this.schedules.get(id) ?? null;
  }

  getSourceByCanonicalUri(canonicalUri: string): KnowledgeSourceRecord | null {
    for (const source of this.sources.values()) {
      if (source.canonicalUri === canonicalUri) return source;
    }
    return null;
  }

  getNodeByKindAndSlug(kind: KnowledgeNodeRecord['kind'], slug: string): KnowledgeNodeRecord | null {
    for (const node of this.nodes.values()) {
      if (node.kind === kind && node.slug === slug) return node;
    }
    return null;
  }

  edgesFor(kind: KnowledgeEdgeRecord['fromKind'] | KnowledgeEdgeRecord['toKind'], id: string): KnowledgeEdgeRecord[] {
    return [...this.edges.values()].filter((edge) => (
      (edge.fromKind === kind && edge.fromId === id)
      || (edge.toKind === kind && edge.toId === id)
    ));
  }

  getItem(id: string): KnowledgeItemView | null {
    const source = this.getSource(id);
    const node = this.getNode(id);
    const issue = this.getIssue(id);
    if (!source && !node && !issue) return null;
    const relatedEdges = this.edgesFor(source ? 'source' : 'node', id);
    const linkedSources: KnowledgeSourceRecord[] = [];
    const linkedNodes: KnowledgeNodeRecord[] = [];
    for (const edge of relatedEdges) {
      const otherKind = source
        ? edge.fromId === source.id && edge.fromKind === 'source'
          ? edge.toKind
          : edge.fromKind
        : edge.fromId === node?.id && edge.fromKind === 'node'
          ? edge.toKind
          : edge.fromKind;
      const otherId = source
        ? edge.fromId === source.id && edge.fromKind === 'source'
          ? edge.toId
          : edge.fromId
        : edge.fromId === node?.id && edge.fromKind === 'node'
          ? edge.toId
          : edge.fromId;
      if (otherKind === 'source') {
        const linked = this.getSource(otherId);
        if (linked) linkedSources.push(linked);
      } else if (otherKind === 'node') {
        const linked = this.getNode(otherId);
        if (linked) linkedNodes.push(linked);
      }
    }
    return { source: source ?? undefined, node: node ?? undefined, issue: issue ?? undefined, relatedEdges, linkedSources, linkedNodes };
  }

  async upsertSource(input: KnowledgeSourceUpsertInput): Promise<KnowledgeSourceRecord> {
    await this.init();
    const existing = input.id
      ? this.sources.get(input.id)
      : input.canonicalUri
        ? this.getSourceByCanonicalUri(input.canonicalUri)
        : null;
    const now = nowMs();
    const record: KnowledgeSourceRecord = {
      id: existing?.id ?? input.id ?? `source-${randomUUID().slice(0, 8)}`,
      connectorId: input.connectorId,
      sourceType: input.sourceType,
      ...(stableText(input.title) ? { title: input.title!.trim() } : {}),
      ...(stableText(input.sourceUri) ? { sourceUri: input.sourceUri!.trim() } : {}),
      ...(stableText(input.canonicalUri) ? { canonicalUri: input.canonicalUri!.trim() } : {}),
      ...(stableText(input.summary) ? { summary: input.summary!.trim() } : {}),
      ...(stableText(input.description) ? { description: input.description!.trim() } : {}),
      tags: uniq(input.tags ?? existing?.tags),
      ...(stableText(input.folderPath) ? { folderPath: input.folderPath!.trim() } : existing?.folderPath ? { folderPath: existing.folderPath } : {}),
      status: input.status,
      ...(stableText(input.artifactId) ? { artifactId: input.artifactId!.trim() } : existing?.artifactId ? { artifactId: existing.artifactId } : {}),
      ...(stableText(input.contentHash) ? { contentHash: input.contentHash!.trim() } : existing?.contentHash ? { contentHash: existing.contentHash } : {}),
      ...(typeof input.lastCrawledAt === 'number' ? { lastCrawledAt: input.lastCrawledAt } : existing?.lastCrawledAt ? { lastCrawledAt: existing.lastCrawledAt } : {}),
      ...(stableText(input.crawlError) ? { crawlError: input.crawlError!.trim() } : existing?.crawlError && input.status !== 'indexed' ? { crawlError: existing.crawlError } : {}),
      ...(stableText(input.sessionId) ? { sessionId: input.sessionId!.trim() } : existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_sources (
        id, connector_id, source_type, title, source_uri, canonical_uri, summary, description,
        tags, folder_path, status, artifact_id, content_hash, last_crawled_at, crawl_error,
        session_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.connectorId,
      record.sourceType,
      record.title ?? null,
      record.sourceUri ?? null,
      record.canonicalUri ?? null,
      record.summary ?? null,
      record.description ?? null,
      JSON.stringify([...record.tags]),
      record.folderPath ?? null,
      record.status,
      record.artifactId ?? null,
      record.contentHash ?? null,
      record.lastCrawledAt ?? null,
      record.crawlError ?? null,
      record.sessionId ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.sources.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertNode(input: KnowledgeNodeUpsertInput): Promise<KnowledgeNodeRecord> {
    await this.init();
    const existing = input.id
      ? this.nodes.get(input.id)
      : this.getNodeByKindAndSlug(input.kind, input.slug);
    const now = nowMs();
    const record: KnowledgeNodeRecord = {
      id: existing?.id ?? input.id ?? `node-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      slug: input.slug,
      title: input.title.trim(),
      ...(stableText(input.summary) ? { summary: input.summary!.trim() } : existing?.summary ? { summary: existing.summary } : {}),
      aliases: uniq(input.aliases ?? existing?.aliases),
      status: input.status ?? existing?.status ?? 'active',
      confidence: Math.max(0, Math.min(100, input.confidence ?? existing?.confidence ?? 70)),
      ...(stableText(input.sourceId) ? { sourceId: input.sourceId!.trim() } : existing?.sourceId ? { sourceId: existing.sourceId } : {}),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_nodes (
        id, kind, slug, title, summary, aliases, status, confidence, source_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.kind,
      record.slug,
      record.title,
      record.summary ?? null,
      JSON.stringify([...record.aliases]),
      record.status,
      record.confidence,
      record.sourceId ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.nodes.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertEdge(input: KnowledgeEdgeUpsertInput): Promise<KnowledgeEdgeRecord> {
    await this.init();
    const existing = [...this.edges.values()].find((edge) => (
      edge.fromKind === input.fromKind
      && edge.fromId === input.fromId
      && edge.toKind === input.toKind
      && edge.toId === input.toId
      && edge.relation === input.relation
    ));
    const now = nowMs();
    const record: KnowledgeEdgeRecord = {
      id: existing?.id ?? `edge-${randomUUID().slice(0, 8)}`,
      fromKind: input.fromKind,
      fromId: input.fromId,
      toKind: input.toKind,
      toId: input.toId,
      relation: input.relation,
      weight: Number.isFinite(input.weight) ? Number(input.weight) : existing?.weight ?? 1,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_edges (
        id, from_kind, from_id, to_kind, to_id, relation, weight, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.fromKind,
      record.fromId,
      record.toKind,
      record.toId,
      record.relation,
      record.weight,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.edges.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async replaceIssues(inputs: readonly KnowledgeIssueUpsertInput[], namespace?: string): Promise<KnowledgeIssueRecord[]> {
    await this.init();
    if (namespace) {
      for (const issue of [...this.issues.values()]) {
        if (issue.metadata.namespace === namespace) {
          this.sqlite.run('DELETE FROM knowledge_issues WHERE id = ?', [issue.id]);
          this.issues.delete(issue.id);
        }
      }
    }
    const created: KnowledgeIssueRecord[] = [];
    for (const input of inputs) {
      const record = await this.upsertIssue(input);
      created.push(record);
    }
    await this.sqlite.save();
    return created;
  }

  async upsertIssue(input: KnowledgeIssueUpsertInput): Promise<KnowledgeIssueRecord> {
    await this.init();
    const existing = input.id ? this.issues.get(input.id) : null;
    const now = nowMs();
    const record: KnowledgeIssueRecord = {
      id: existing?.id ?? input.id ?? `issue-${randomUUID().slice(0, 8)}`,
      severity: input.severity,
      code: input.code,
      message: input.message.trim(),
      status: input.status ?? existing?.status ?? 'open',
      ...(stableText(input.sourceId) ? { sourceId: input.sourceId!.trim() } : {}),
      ...(stableText(input.nodeId) ? { nodeId: input.nodeId!.trim() } : {}),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_issues (
        id, severity, code, message, status, source_id, node_id, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.severity,
      record.code,
      record.message,
      record.status,
      record.sourceId ?? null,
      record.nodeId ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.issues.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertExtraction(input: KnowledgeExtractionUpsertInput): Promise<KnowledgeExtractionRecord> {
    await this.init();
    const existing = input.id
      ? this.extractions.get(input.id)
      : this.getExtractionBySourceId(input.sourceId);
    const now = nowMs();
    const record: KnowledgeExtractionRecord = {
      id: existing?.id ?? input.id ?? `extract-${randomUUID().slice(0, 8)}`,
      sourceId: input.sourceId,
      ...(stableText(input.artifactId) ? { artifactId: input.artifactId!.trim() } : existing?.artifactId ? { artifactId: existing.artifactId } : {}),
      extractorId: input.extractorId,
      format: input.format,
      ...(stableText(input.title) ? { title: input.title!.trim() } : existing?.title ? { title: existing.title } : {}),
      ...(stableText(input.summary) ? { summary: input.summary!.trim() } : existing?.summary ? { summary: existing.summary } : {}),
      ...(stableText(input.excerpt) ? { excerpt: input.excerpt!.trim() } : existing?.excerpt ? { excerpt: existing.excerpt } : {}),
      sections: uniq(input.sections ?? existing?.sections),
      links: uniq(input.links ?? existing?.links),
      estimatedTokens: Math.max(0, Number(input.estimatedTokens ?? existing?.estimatedTokens ?? 0)),
      structure: {
        ...(existing?.structure ?? {}),
        ...(input.structure ?? {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_extractions (
        id, source_id, artifact_id, extractor_id, format, title, summary, excerpt,
        sections, links, estimated_tokens, structure, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.sourceId,
      record.artifactId ?? null,
      record.extractorId,
      record.format,
      record.title ?? null,
      record.summary ?? null,
      record.excerpt ?? null,
      JSON.stringify([...record.sections]),
      JSON.stringify([...record.links]),
      record.estimatedTokens,
      JSON.stringify(record.structure),
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.extractions.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertJobRun(input: KnowledgeJobRunUpsertInput): Promise<KnowledgeJobRunRecord> {
    await this.init();
    const existing = input.id ? this.jobRuns.get(input.id) : null;
    const now = nowMs();
    const record: KnowledgeJobRunRecord = {
      id: existing?.id ?? input.id ?? `kjr-${randomUUID().slice(0, 8)}`,
      jobId: input.jobId,
      status: input.status,
      mode: input.mode,
      requestedAt: input.requestedAt ?? existing?.requestedAt ?? now,
      ...(typeof input.startedAt === 'number' ? { startedAt: input.startedAt } : existing?.startedAt ? { startedAt: existing.startedAt } : {}),
      ...(typeof input.completedAt === 'number' ? { completedAt: input.completedAt } : existing?.completedAt ? { completedAt: existing.completedAt } : {}),
      ...(stableText(input.error) ? { error: input.error!.trim() } : existing?.error ? { error: existing.error } : {}),
      result: {
        ...(existing?.result ?? {}),
        ...(input.result ?? {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_job_runs (
        id, job_id, status, mode, requested_at, started_at, completed_at, error, result, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.jobId,
      record.status,
      record.mode,
      record.requestedAt,
      record.startedAt ?? null,
      record.completedAt ?? null,
      record.error ?? null,
      JSON.stringify(record.result),
      JSON.stringify(record.metadata),
      existing ? now : now,
      now,
    ]);
    this.jobRuns.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertUsageRecord(input: KnowledgeUsageUpsertInput): Promise<KnowledgeUsageRecord> {
    await this.init();
    const record: KnowledgeUsageRecord = {
      id: input.id ?? `kuse-${randomUUID().slice(0, 8)}`,
      targetKind: input.targetKind,
      targetId: input.targetId,
      usageKind: input.usageKind,
      ...(stableText(input.task) ? { task: input.task!.trim() } : {}),
      ...(stableText(input.sessionId) ? { sessionId: input.sessionId!.trim() } : {}),
      ...(typeof input.score === 'number' && Number.isFinite(input.score) ? { score: Number(input.score) } : {}),
      metadata: { ...(input.metadata ?? {}) },
      createdAt: nowMs(),
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_usage_records (
        id, target_kind, target_id, usage_kind, task, session_id, score, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.targetKind,
      record.targetId,
      record.usageKind,
      record.task ?? null,
      record.sessionId ?? null,
      record.score ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
    ]);
    this.usageRecords.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertConsolidationCandidate(
    input: KnowledgeConsolidationCandidateUpsertInput,
  ): Promise<KnowledgeConsolidationCandidateRecord> {
    await this.init();
    const existing = input.id
      ? this.consolidationCandidates.get(input.id)
      : this.getConsolidationCandidateBySubject(input.subjectKind, input.subjectId, input.candidateType);
    const now = nowMs();
    const record: KnowledgeConsolidationCandidateRecord = {
      id: existing?.id ?? input.id ?? `kcand-${randomUUID().slice(0, 8)}`,
      candidateType: input.candidateType,
      status: input.status ?? existing?.status ?? 'open',
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      title: input.title.trim(),
      ...(stableText(input.summary) ? { summary: input.summary!.trim() } : existing?.summary ? { summary: existing.summary } : {}),
      score: Number(input.score),
      evidence: uniq(input.evidence ?? existing?.evidence),
      ...(stableText(input.suggestedMemoryClass) ? { suggestedMemoryClass: input.suggestedMemoryClass!.trim() } : existing?.suggestedMemoryClass ? { suggestedMemoryClass: existing.suggestedMemoryClass } : {}),
      ...(stableText(input.suggestedScope) ? { suggestedScope: input.suggestedScope!.trim() } : existing?.suggestedScope ? { suggestedScope: existing.suggestedScope } : {}),
      ...(typeof input.decidedAt === 'number' ? { decidedAt: input.decidedAt } : existing?.decidedAt ? { decidedAt: existing.decidedAt } : {}),
      ...(stableText(input.decidedBy) ? { decidedBy: input.decidedBy!.trim() } : existing?.decidedBy ? { decidedBy: existing.decidedBy } : {}),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_consolidation_candidates (
        id, candidate_type, status, subject_kind, subject_id, title, summary, score,
        evidence, suggested_memory_class, suggested_scope, decided_at, decided_by, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.candidateType,
      record.status,
      record.subjectKind,
      record.subjectId,
      record.title,
      record.summary ?? null,
      record.score,
      JSON.stringify([...record.evidence]),
      record.suggestedMemoryClass ?? null,
      record.suggestedScope ?? null,
      record.decidedAt ?? null,
      record.decidedBy ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.consolidationCandidates.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertConsolidationReport(
    input: KnowledgeConsolidationReportUpsertInput,
  ): Promise<KnowledgeConsolidationReportRecord> {
    await this.init();
    const existing = input.id ? this.consolidationReports.get(input.id) : null;
    const now = nowMs();
    const record: KnowledgeConsolidationReportRecord = {
      id: existing?.id ?? input.id ?? `krep-${randomUUID().slice(0, 8)}`,
      kind: input.kind,
      title: input.title.trim(),
      summary: input.summary.trim(),
      highlights: uniq(input.highlights ?? existing?.highlights),
      metrics: {
        ...(existing?.metrics ?? {}),
        ...(input.metrics ?? {}),
      },
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_consolidation_reports (
        id, kind, title, summary, highlights, metrics, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.kind,
      record.title,
      record.summary,
      JSON.stringify([...record.highlights]),
      JSON.stringify(record.metrics),
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.consolidationReports.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async upsertSchedule(input: KnowledgeScheduleUpsertInput): Promise<KnowledgeScheduleRecord> {
    await this.init();
    const existing = input.id ? this.schedules.get(input.id) : null;
    const now = nowMs();
    const record: KnowledgeScheduleRecord = {
      id: existing?.id ?? input.id ?? `ksched-${randomUUID().slice(0, 8)}`,
      jobId: input.jobId,
      label: input.label.trim(),
      enabled: input.enabled ?? existing?.enabled ?? true,
      schedule: input.schedule,
      ...(typeof input.lastRunAt === 'number' ? { lastRunAt: input.lastRunAt } : existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(typeof input.nextRunAt === 'number' ? { nextRunAt: input.nextRunAt } : existing?.nextRunAt ? { nextRunAt: existing.nextRunAt } : {}),
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sqlite.run(`
      INSERT OR REPLACE INTO knowledge_schedules (
        id, job_id, label, enabled, schedule, last_run_at, next_run_at, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.jobId,
      record.label,
      record.enabled ? 1 : 0,
      JSON.stringify(record.schedule),
      record.lastRunAt ?? null,
      record.nextRunAt ?? null,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
    this.schedules.set(record.id, record);
    await this.sqlite.save();
    return record;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    await this.init();
    const existing = this.schedules.get(id);
    if (!existing) return false;
    this.sqlite.run('DELETE FROM knowledge_schedules WHERE id = ?', [id]);
    this.schedules.delete(id);
    await this.sqlite.save();
    return true;
  }

  private async initialize(): Promise<void> {
    await this.sqlite.init(createSchema);
    this.loadSources();
    this.loadNodes();
    this.loadEdges();
    this.loadIssues();
    this.loadExtractions();
    this.loadJobRuns();
    this.loadUsageRecords();
    this.loadConsolidationCandidates();
    this.loadConsolidationReports();
    this.loadSchedules();
    this.ready = true;
  }

  private loadSources(): void {
    this.sources.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_sources');
    for (const row of rows[0]?.values ?? []) {
      const record = mapSourceRow(rows[0]!.columns, row);
      this.sources.set(record.id, record);
    }
  }

  private loadNodes(): void {
    this.nodes.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_nodes');
    for (const row of rows[0]?.values ?? []) {
      const record = mapNodeRow(rows[0]!.columns, row);
      this.nodes.set(record.id, record);
    }
  }

  private loadEdges(): void {
    this.edges.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_edges');
    for (const row of rows[0]?.values ?? []) {
      const record = mapEdgeRow(rows[0]!.columns, row);
      this.edges.set(record.id, record);
    }
  }

  private loadIssues(): void {
    this.issues.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_issues');
    for (const row of rows[0]?.values ?? []) {
      const record = mapIssueRow(rows[0]!.columns, row);
      this.issues.set(record.id, record);
    }
  }

  private loadExtractions(): void {
    this.extractions.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_extractions');
    for (const row of rows[0]?.values ?? []) {
      const record = mapExtractionRow(rows[0]!.columns, row);
      this.extractions.set(record.id, record);
    }
  }

  private loadJobRuns(): void {
    this.jobRuns.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_job_runs');
    for (const row of rows[0]?.values ?? []) {
      const record = mapJobRunRow(rows[0]!.columns, row);
      this.jobRuns.set(record.id, record);
    }
  }

  private loadUsageRecords(): void {
    this.usageRecords.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_usage_records');
    for (const row of rows[0]?.values ?? []) {
      const record = mapUsageRow(rows[0]!.columns, row);
      this.usageRecords.set(record.id, record);
    }
  }

  private loadConsolidationCandidates(): void {
    this.consolidationCandidates.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_consolidation_candidates');
    for (const row of rows[0]?.values ?? []) {
      const record = mapCandidateRow(rows[0]!.columns, row);
      this.consolidationCandidates.set(record.id, record);
    }
  }

  private loadConsolidationReports(): void {
    this.consolidationReports.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_consolidation_reports');
    for (const row of rows[0]?.values ?? []) {
      const record = mapReportRow(rows[0]!.columns, row);
      this.consolidationReports.set(record.id, record);
    }
  }

  private loadSchedules(): void {
    this.schedules.clear();
    const rows = this.sqlite.exec('SELECT * FROM knowledge_schedules');
    for (const row of rows[0]?.values ?? []) {
      const record = mapScheduleRow(rows[0]!.columns, row);
      this.schedules.set(record.id, record);
    }
  }
}
