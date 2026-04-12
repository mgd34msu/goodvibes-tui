import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AutomationScheduleDefinition } from '../automation/schedules.ts';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeJobRunRecord,
  KnowledgeNodeRecord,
  KnowledgeScheduleRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceStatus,
  KnowledgeNodeStatus,
  KnowledgeExtractionFormat,
  KnowledgeIssueSeverity,
  KnowledgeJobStatus,
  KnowledgeUsageTargetKind,
  KnowledgeUsageKind,
  KnowledgeConsolidationCandidateType,
  KnowledgeConsolidationStatus,
  KnowledgeReferenceKind,
  KnowledgeUsageRecord,
} from './types.ts';

export function resolveDefaultKnowledgeDbPath(): string {
  const runtime = globalThis as typeof globalThis & { __gvTestConfigDir?: string };
  const baseDir = runtime.__gvTestConfigDir ?? join(homedir(), '.goodvibes', 'tui');
  return join(baseDir, 'knowledge.sqlite');
}

export function nowMs(): number {
  return Date.now();
}

export function stableText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function uniq(values: readonly string[] | undefined): string[] {
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

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function createSchema(db: { run(sql: string): void }): void {
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

function rowObject(columns: string[], values: unknown[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

export function mapSourceRow(columns: string[], values: unknown[]): KnowledgeSourceRecord {
  const row = rowObject(columns, values);
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
    status: String(row.status) as KnowledgeSourceStatus,
    ...(stableText(row.artifact_id as string | undefined) ? { artifactId: String(row.artifact_id) } : {}),
    ...(stableText(row.content_hash as string | undefined) ? { contentHash: String(row.content_hash) } : {}),
    ...(typeof row.last_crawled_at === 'number' ? { lastCrawledAt: Number(row.last_crawled_at) } : {}),
    ...(stableText(row.crawl_error as string | undefined) ? { crawlError: String(row.crawl_error) } : {}),
    ...(stableText(row.session_id as string | undefined) ? { sessionId: String(row.session_id) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapNodeRow(columns: string[], values: unknown[]): KnowledgeNodeRecord {
  const row = rowObject(columns, values);
  return {
    id: String(row.id),
    kind: String(row.kind) as KnowledgeNodeRecord['kind'],
    slug: String(row.slug),
    title: String(row.title),
    ...(stableText(row.summary as string | undefined) ? { summary: String(row.summary) } : {}),
    aliases: parseJsonValue<string[]>(row.aliases, []),
    status: String(row.status) as KnowledgeNodeStatus,
    confidence: Number(row.confidence),
    ...(stableText(row.source_id as string | undefined) ? { sourceId: String(row.source_id) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapEdgeRow(columns: string[], values: unknown[]): KnowledgeEdgeRecord {
  const row = rowObject(columns, values);
  return {
    id: String(row.id),
    fromKind: String(row.from_kind) as KnowledgeReferenceKind,
    fromId: String(row.from_id),
    toKind: String(row.to_kind) as KnowledgeReferenceKind,
    toId: String(row.to_id),
    relation: String(row.relation),
    weight: Number(row.weight),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapIssueRow(columns: string[], values: unknown[]): KnowledgeIssueRecord {
  const row = rowObject(columns, values);
  return {
    id: String(row.id),
    severity: String(row.severity) as KnowledgeIssueSeverity,
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

export function mapExtractionRow(columns: string[], values: unknown[]): KnowledgeExtractionRecord {
  const row = rowObject(columns, values);
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    ...(stableText(row.artifact_id as string | undefined) ? { artifactId: String(row.artifact_id) } : {}),
    extractorId: String(row.extractor_id),
    format: String(row.format) as KnowledgeExtractionFormat,
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

export function mapJobRunRow(columns: string[], values: unknown[]): KnowledgeJobRunRecord {
  const row = rowObject(columns, values);
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    status: String(row.status) as KnowledgeJobStatus,
    mode: String(row.mode) as KnowledgeJobRunRecord['mode'],
    requestedAt: Number(row.requested_at),
    ...(typeof row.started_at === 'number' ? { startedAt: Number(row.started_at) } : {}),
    ...(typeof row.completed_at === 'number' ? { completedAt: Number(row.completed_at) } : {}),
    ...(stableText(row.error as string | undefined) ? { error: String(row.error) } : {}),
    result: parseJsonValue<Record<string, unknown>>(row.result, {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapUsageRow(columns: string[], values: unknown[]): KnowledgeUsageRecord {
  const row = rowObject(columns, values);
  return {
    id: String(row.id),
    targetKind: String(row.target_kind) as KnowledgeUsageTargetKind,
    targetId: String(row.target_id),
    usageKind: String(row.usage_kind) as KnowledgeUsageKind,
    ...(stableText(row.task as string | undefined) ? { task: String(row.task) } : {}),
    ...(stableText(row.session_id as string | undefined) ? { sessionId: String(row.session_id) } : {}),
    ...(typeof row.score === 'number' ? { score: Number(row.score) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
  };
}

export function mapCandidateRow(columns: string[], values: unknown[]): KnowledgeConsolidationCandidateRecord {
  const row = rowObject(columns, values);
  return {
    id: String(row.id),
    candidateType: String(row.candidate_type) as KnowledgeConsolidationCandidateType,
    status: String(row.status) as KnowledgeConsolidationStatus,
    subjectKind: String(row.subject_kind) as KnowledgeUsageTargetKind,
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

export function mapReportRow(columns: string[], values: unknown[]): KnowledgeConsolidationReportRecord {
  const row = rowObject(columns, values);
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

export function mapScheduleRow(columns: string[], values: unknown[]): KnowledgeScheduleRecord {
  const row = rowObject(columns, values);
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    label: String(row.label),
    enabled: Boolean(row.enabled),
    schedule: parseJsonValue<AutomationScheduleDefinition>(row.schedule, { kind: 'at', at: 0 }),
    ...(typeof row.last_run_at === 'number' ? { lastRunAt: Number(row.last_run_at) } : {}),
    ...(typeof row.next_run_at === 'number' ? { nextRunAt: Number(row.next_run_at) } : {}),
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
