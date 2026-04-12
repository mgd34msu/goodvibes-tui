import type { SQLiteStore } from '../state/sqlite-store.ts';
import {
  mapCandidateRow,
  mapEdgeRow,
  mapExtractionRow,
  mapIssueRow,
  mapJobRunRow,
  mapNodeRow,
  mapReportRow,
  mapScheduleRow,
  mapSourceRow,
  mapUsageRow,
} from './store-schema.ts';
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
  KnowledgeUsageRecord,
} from './types.ts';

export interface KnowledgeStoreSnapshot {
  readonly sources: KnowledgeSourceRecord[];
  readonly nodes: KnowledgeNodeRecord[];
  readonly edges: KnowledgeEdgeRecord[];
  readonly issues: KnowledgeIssueRecord[];
  readonly extractions: KnowledgeExtractionRecord[];
  readonly jobRuns: KnowledgeJobRunRecord[];
  readonly usageRecords: KnowledgeUsageRecord[];
  readonly consolidationCandidates: KnowledgeConsolidationCandidateRecord[];
  readonly consolidationReports: KnowledgeConsolidationReportRecord[];
  readonly schedules: KnowledgeScheduleRecord[];
}

function loadRows<T>(sqlite: SQLiteStore, sql: string, mapRow: (columns: string[], values: unknown[]) => T): T[] {
  const rows = sqlite.exec(sql);
  if (!rows.length) return [];
  return rows[0]!.values.map((row) => mapRow(rows[0]!.columns, row));
}

export function loadKnowledgeStoreSnapshot(sqlite: SQLiteStore): KnowledgeStoreSnapshot {
  return {
    sources: loadRows(sqlite, 'SELECT * FROM knowledge_sources', mapSourceRow),
    nodes: loadRows(sqlite, 'SELECT * FROM knowledge_nodes', mapNodeRow),
    edges: loadRows(sqlite, 'SELECT * FROM knowledge_edges', mapEdgeRow),
    issues: loadRows(sqlite, 'SELECT * FROM knowledge_issues', mapIssueRow),
    extractions: loadRows(sqlite, 'SELECT * FROM knowledge_extractions', mapExtractionRow),
    jobRuns: loadRows(sqlite, 'SELECT * FROM knowledge_job_runs', mapJobRunRow),
    usageRecords: loadRows(sqlite, 'SELECT * FROM knowledge_usage_records', mapUsageRow),
    consolidationCandidates: loadRows(sqlite, 'SELECT * FROM knowledge_consolidation_candidates', mapCandidateRow),
    consolidationReports: loadRows(sqlite, 'SELECT * FROM knowledge_consolidation_reports', mapReportRow),
    schedules: loadRows(sqlite, 'SELECT * FROM knowledge_schedules', mapScheduleRow),
  };
}
