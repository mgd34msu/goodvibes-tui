import type {
  KnowledgeEdgeRecord,
  KnowledgeItemView,
  KnowledgeIssueRecord,
  KnowledgeJobRunRecord,
  KnowledgeNodeRecord,
  KnowledgeScheduleRecord,
  KnowledgeSourceRecord,
  KnowledgeStatus,
  KnowledgeUsageRecord,
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
  KnowledgeExtractionRecord,
} from './types.ts';

export interface KnowledgeStoreReadView {
  readonly ready: boolean;
  readonly dbPath: string;
  readonly sources: Map<string, KnowledgeSourceRecord>;
  readonly nodes: Map<string, KnowledgeNodeRecord>;
  readonly edges: Map<string, KnowledgeEdgeRecord>;
  readonly issues: Map<string, KnowledgeIssueRecord>;
  readonly extractions: Map<string, KnowledgeExtractionRecord>;
  readonly jobRuns: Map<string, KnowledgeJobRunRecord>;
  readonly usageRecords: Map<string, KnowledgeUsageRecord>;
  readonly consolidationCandidates: Map<string, KnowledgeConsolidationCandidateRecord>;
  readonly consolidationReports: Map<string, KnowledgeConsolidationReportRecord>;
  readonly schedules: Map<string, KnowledgeScheduleRecord>;
}

function sliceLimit(limit: number): number {
  return Math.max(1, limit);
}

function byUpdatedAtDesc<T extends { updatedAt: number; id: string }>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

function byCreatedAtDesc<T extends { createdAt: number; id: string }>(a: T, b: T): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

function byQueuedAtDesc<T extends { queuedAt: number; id: string }>(a: T, b: T): number {
  return b.queuedAt - a.queuedAt || a.id.localeCompare(b.id);
}

function byRequestedAtDesc<T extends { requestedAt: number; id: string }>(a: T, b: T): number {
  return (b.requestedAt - a.requestedAt) || a.id.localeCompare(b.id);
}

export function getKnowledgeStoreStatus(view: KnowledgeStoreReadView): KnowledgeStatus {
  return {
    ready: view.ready,
    storagePath: view.dbPath,
    sourceCount: view.sources.size,
    nodeCount: view.nodes.size,
    edgeCount: view.edges.size,
    issueCount: view.issues.size,
    extractionCount: view.extractions.size,
    jobRunCount: view.jobRuns.size,
    usageCount: view.usageRecords.size,
    candidateCount: view.consolidationCandidates.size,
    reportCount: view.consolidationReports.size,
    scheduleCount: view.schedules.size,
  };
}

export function listKnowledgeSources(view: KnowledgeStoreReadView, limit = 100): KnowledgeSourceRecord[] {
  return [...view.sources.values()]
    .sort(byUpdatedAtDesc)
    .slice(0, sliceLimit(limit));
}

export function listKnowledgeNodes(view: KnowledgeStoreReadView, limit = 100): KnowledgeNodeRecord[] {
  return [...view.nodes.values()]
    .sort(byUpdatedAtDesc)
    .slice(0, sliceLimit(limit));
}

export function listKnowledgeEdges(view: KnowledgeStoreReadView): KnowledgeEdgeRecord[] {
  return [...view.edges.values()];
}

export function listKnowledgeIssues(view: KnowledgeStoreReadView, limit = 100): KnowledgeIssueRecord[] {
  return [...view.issues.values()]
    .sort(byUpdatedAtDesc)
    .slice(0, sliceLimit(limit));
}

export function listKnowledgeExtractions(view: KnowledgeStoreReadView, limit = 100): KnowledgeExtractionRecord[] {
  return [...view.extractions.values()]
    .sort(byUpdatedAtDesc)
    .slice(0, sliceLimit(limit));
}

export function listKnowledgeJobRuns(view: KnowledgeStoreReadView, limit = 100, jobId?: string): KnowledgeJobRunRecord[] {
  return [...view.jobRuns.values()]
    .filter((run) => !jobId || run.jobId === jobId)
    .sort(byRequestedAtDesc)
    .slice(0, sliceLimit(limit));
}

export function listKnowledgeUsageRecords(
  view: KnowledgeStoreReadView,
  limit = 100,
  input: {
    readonly targetKind?: KnowledgeUsageRecord['targetKind'];
    readonly targetId?: string;
    readonly usageKind?: KnowledgeUsageRecord['usageKind'];
  } = {},
): KnowledgeUsageRecord[] {
  return [...view.usageRecords.values()]
    .filter((record) => (
      (!input.targetKind || record.targetKind === input.targetKind)
      && (!input.targetId || record.targetId === input.targetId)
      && (!input.usageKind || record.usageKind === input.usageKind)
    ))
    .sort(byCreatedAtDesc)
    .slice(0, sliceLimit(limit));
}

export function listKnowledgeConsolidationCandidates(
  view: KnowledgeStoreReadView,
  limit = 100,
  input: {
    readonly status?: KnowledgeConsolidationCandidateRecord['status'];
    readonly subjectKind?: KnowledgeConsolidationCandidateRecord['subjectKind'];
    readonly subjectId?: string;
  } = {},
): KnowledgeConsolidationCandidateRecord[] {
  return [...view.consolidationCandidates.values()]
    .filter((record) => (
      (!input.status || record.status === input.status)
      && (!input.subjectKind || record.subjectKind === input.subjectKind)
      && (!input.subjectId || record.subjectId === input.subjectId)
    ))
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, sliceLimit(limit));
}

export function listKnowledgeConsolidationReports(view: KnowledgeStoreReadView, limit = 100): KnowledgeConsolidationReportRecord[] {
  return [...view.consolidationReports.values()]
    .sort(byCreatedAtDesc)
    .slice(0, sliceLimit(limit));
}

export function listKnowledgeSchedules(view: KnowledgeStoreReadView, limit = 100): KnowledgeScheduleRecord[] {
  return [...view.schedules.values()]
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    .slice(0, sliceLimit(limit));
}

export function getKnowledgeSource(view: KnowledgeStoreReadView, id: string): KnowledgeSourceRecord | null {
  return view.sources.get(id) ?? null;
}

export function getKnowledgeNode(view: KnowledgeStoreReadView, id: string): KnowledgeNodeRecord | null {
  return view.nodes.get(id) ?? null;
}

export function getKnowledgeIssue(view: KnowledgeStoreReadView, id: string): KnowledgeIssueRecord | null {
  return view.issues.get(id) ?? null;
}

export function getKnowledgeExtraction(view: KnowledgeStoreReadView, id: string): KnowledgeExtractionRecord | null {
  return view.extractions.get(id) ?? null;
}

export function getKnowledgeExtractionBySourceId(view: KnowledgeStoreReadView, sourceId: string): KnowledgeExtractionRecord | null {
  for (const extraction of view.extractions.values()) {
    if (extraction.sourceId === sourceId) return extraction;
  }
  return null;
}

export function getKnowledgeJobRun(view: KnowledgeStoreReadView, id: string): KnowledgeJobRunRecord | null {
  return view.jobRuns.get(id) ?? null;
}

export function getKnowledgeUsageRecord(view: KnowledgeStoreReadView, id: string): KnowledgeUsageRecord | null {
  return view.usageRecords.get(id) ?? null;
}

export function getKnowledgeConsolidationCandidate(
  view: KnowledgeStoreReadView,
  id: string,
): KnowledgeConsolidationCandidateRecord | null {
  return view.consolidationCandidates.get(id) ?? null;
}

export function getKnowledgeConsolidationCandidateBySubject(
  view: KnowledgeStoreReadView,
  subjectKind: KnowledgeConsolidationCandidateRecord['subjectKind'],
  subjectId: string,
  candidateType: KnowledgeConsolidationCandidateRecord['candidateType'],
): KnowledgeConsolidationCandidateRecord | null {
  for (const candidate of view.consolidationCandidates.values()) {
    if (candidate.subjectKind === subjectKind && candidate.subjectId === subjectId && candidate.candidateType === candidateType) {
      return candidate;
    }
  }
  return null;
}

export function getKnowledgeConsolidationReport(
  view: KnowledgeStoreReadView,
  id: string,
): KnowledgeConsolidationReportRecord | null {
  return view.consolidationReports.get(id) ?? null;
}

export function getKnowledgeSchedule(view: KnowledgeStoreReadView, id: string): KnowledgeScheduleRecord | null {
  return view.schedules.get(id) ?? null;
}

export function getKnowledgeSourceByCanonicalUri(
  view: KnowledgeStoreReadView,
  canonicalUri: string,
): KnowledgeSourceRecord | null {
  for (const source of view.sources.values()) {
    if (source.canonicalUri === canonicalUri) return source;
  }
  return null;
}

export function getKnowledgeNodeByKindAndSlug(
  view: KnowledgeStoreReadView,
  kind: KnowledgeNodeRecord['kind'],
  slug: string,
): KnowledgeNodeRecord | null {
  for (const node of view.nodes.values()) {
    if (node.kind === kind && node.slug === slug) return node;
  }
  return null;
}

export function edgesForKnowledgeStore(
  view: KnowledgeStoreReadView,
  kind: KnowledgeEdgeRecord['fromKind'] | KnowledgeEdgeRecord['toKind'],
  id: string,
): KnowledgeEdgeRecord[] {
  return [...view.edges.values()].filter((edge) => (
    (edge.fromKind === kind && edge.fromId === id)
    || (edge.toKind === kind && edge.toId === id)
  ));
}

export function getKnowledgeItem(view: KnowledgeStoreReadView, id: string): KnowledgeItemView | null {
  const source = getKnowledgeSource(view, id);
  const node = getKnowledgeNode(view, id);
  const issue = getKnowledgeIssue(view, id);
  if (!source && !node && !issue) return null;
  const relatedEdges = edgesForKnowledgeStore(view, source ? 'source' : 'node', id);
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
      const linked = getKnowledgeSource(view, otherId);
      if (linked) linkedSources.push(linked);
    } else if (otherKind === 'node') {
      const linked = getKnowledgeNode(view, otherId);
      if (linked) linkedNodes.push(linked);
    }
  }
  return { source: source ?? undefined, node: node ?? undefined, issue: issue ?? undefined, relatedEdges, linkedSources, linkedNodes };
}
