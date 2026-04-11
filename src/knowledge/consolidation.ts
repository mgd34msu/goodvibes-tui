import { getMemoryRegistry } from '../state/index.ts';
import type { MemoryClass, MemoryScope } from '../state/index.ts';
import type { KnowledgeStore } from './store.ts';
import type {
  KnowledgeConsolidationCandidateRecord,
  KnowledgeConsolidationReportRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
  KnowledgeUsageRecord,
} from './types.ts';
import {
  DEEP_CONSOLIDATION_AUTOPROMOTE_THRESHOLD,
  LIGHT_CONSOLIDATION_THRESHOLD,
  coerceStringArray,
  mergeTags,
  slugify,
  summarizeCompact,
  topKeywords,
  usageWindowCutoff,
} from './internal.ts';

export interface KnowledgeConsolidationContext {
  readonly store: KnowledgeStore;
  readonly syncReviewedMemory: () => Promise<void>;
}

export async function decideKnowledgeConsolidationCandidate(
  context: KnowledgeConsolidationContext,
  id: string,
  decision: 'accept' | 'reject' | 'supersede',
  input: {
    readonly decidedBy?: string;
    readonly memoryClass?: string;
    readonly scope?: string;
    readonly detail?: string;
  } = {},
): Promise<KnowledgeConsolidationCandidateRecord> {
  await context.store.init();
  const candidate = context.store.getConsolidationCandidate(id);
  if (!candidate) throw new Error(`Unknown knowledge consolidation candidate: ${id}`);
  const decidedAt = Date.now();
  let acceptedMemoryId: string | undefined;
  if (decision === 'accept' && candidate.candidateType === 'memory-promotion') {
    const record = context.store.getItem(candidate.subjectId);
    const memoryRegistry = getMemoryRegistry();
    await memoryRegistry.getStore().init();
    const summary = summarizeCompact(candidate.title, 160) ?? candidate.title;
    const detail = input.detail
      ?? candidate.summary
      ?? record?.source?.summary
      ?? record?.node?.summary
      ?? summary;
    const tags = mergeTags(
      candidate.evidence,
      record?.source?.tags,
      record?.node?.aliases,
      coerceStringArray(candidate.metadata.tags),
    );
    const memory = await memoryRegistry.add({
      cls: (input.memoryClass ?? candidate.suggestedMemoryClass ?? 'fact') as MemoryClass,
      scope: (input.scope ?? candidate.suggestedScope ?? 'project') as MemoryScope,
      summary,
      detail,
      tags,
      provenance: [
        ...(record?.source?.sessionId ? [{ kind: 'session' as const, ref: record.source.sessionId }] : []),
        { kind: 'event', ref: candidate.id, label: 'knowledge consolidation candidate' },
      ],
      review: {
        state: 'reviewed',
        confidence: Math.max(60, Math.min(100, Math.round(candidate.score))),
        reviewedAt: decidedAt,
        reviewedBy: input.decidedBy,
      },
    });
    acceptedMemoryId = memory.id;
    await context.syncReviewedMemory();
  }
  return context.store.upsertConsolidationCandidate({
    id: candidate.id,
    candidateType: candidate.candidateType,
    subjectKind: candidate.subjectKind,
    subjectId: candidate.subjectId,
    title: candidate.title,
    summary: candidate.summary,
    score: candidate.score,
    evidence: candidate.evidence,
    suggestedMemoryClass: input.memoryClass ?? candidate.suggestedMemoryClass,
    suggestedScope: input.scope ?? candidate.suggestedScope,
    status: decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'superseded',
    decidedAt,
    decidedBy: input.decidedBy,
    metadata: {
      ...candidate.metadata,
      ...(acceptedMemoryId ? { acceptedMemoryId } : {}),
    },
  });
}

export async function refreshKnowledgeConsolidationCandidates(
  context: KnowledgeConsolidationContext,
  limit = 24,
): Promise<KnowledgeConsolidationCandidateRecord[]> {
  await context.store.init();
  await context.syncReviewedMemory();
  const usageStats = await buildUsageStats(context);
  const proposals: KnowledgeConsolidationCandidateRecord[] = [];
  const seenSubjects = new Set<string>();

  for (const [key, stats] of usageStats.entries()) {
    const [subjectKind, subjectId] = key.split(':', 2) as [KnowledgeConsolidationCandidateRecord['subjectKind'], string];
    if (subjectKind === 'issue') continue;
    const item = context.store.getItem(subjectId);
    if (!item?.source && !item?.node) continue;
    const subjectTitle = item.source?.title ?? item.source?.canonicalUri ?? item.node?.title ?? subjectId;
    const subjectSummary = summarizeCompact(item.source?.summary ?? item.node?.summary ?? item.source?.description);
    const relationCount = subjectKind === 'source'
      ? context.store.edgesFor('source', subjectId).length
      : context.store.edgesFor('node', subjectId).length;
    const score = Math.round(
      scoreUsageBoost(stats)
      + Math.min(16, relationCount * 2)
      + (item.node?.kind === 'memory' ? 10 : 0),
    );
    if (score < LIGHT_CONSOLIDATION_THRESHOLD) continue;
    const candidateType: KnowledgeConsolidationCandidateRecord['candidateType'] =
      item.node?.kind === 'memory' && item.node.status === 'stale'
        ? 'memory-review'
        : subjectKind === 'source' && isSourcePastRefreshWindow(item.source!)
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
    const candidate = await context.store.upsertConsolidationCandidate({
      candidateType,
      subjectKind,
      subjectId,
      title: subjectTitle,
      summary: subjectSummary,
      score,
      evidence,
      suggestedMemoryClass: inferMemoryClassForCandidate(context, subjectKind, subjectId),
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

  for (const existing of context.store.listConsolidationCandidates(1_000, { status: 'open' })) {
    const key = `${existing.candidateType}:${existing.subjectKind}:${existing.subjectId}`;
    if (seenSubjects.has(key)) continue;
    await context.store.upsertConsolidationCandidate({
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

export async function runKnowledgeConsolidation(
  context: KnowledgeConsolidationContext,
  kind: Extract<KnowledgeConsolidationReportRecord['kind'], 'light-consolidation' | 'deep-consolidation'>,
  input: { readonly limit?: number; readonly autoPromote: boolean },
): Promise<KnowledgeConsolidationReportRecord> {
  const limit = Math.max(1, input.limit ?? 24);
  const candidates = await refreshKnowledgeConsolidationCandidates(context, limit);
  let accepted = 0;
  let rejected = 0;
  let superseded = 0;
  if (input.autoPromote) {
    for (const candidate of candidates) {
      if (candidate.candidateType !== 'memory-promotion') continue;
      if (candidate.score < DEEP_CONSOLIDATION_AUTOPROMOTE_THRESHOLD) continue;
      const decided = await decideKnowledgeConsolidationCandidate(context, candidate.id, 'accept', {
        decidedBy: 'knowledge.deep-consolidation',
        memoryClass: candidate.suggestedMemoryClass,
        scope: candidate.suggestedScope,
      });
      if (decided.status === 'accepted') accepted += 1;
    }
  }
  const current = context.store.listConsolidationCandidates(1_000);
  for (const candidate of current) {
    if (candidate.status === 'rejected') rejected += 1;
    if (candidate.status === 'superseded') superseded += 1;
  }
  const openCount = current.filter((entry) => entry.status === 'open').length;
  return context.store.upsertConsolidationReport({
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
}

export async function syncReviewedKnowledgeMemory(context: { readonly syncReviewedMemory: () => Promise<void> }): Promise<void> {
  await context.syncReviewedMemory();
}

async function buildUsageStats(context: KnowledgeConsolidationContext, limit = 10_000): Promise<Map<string, {
  count: number;
  scoreTotal: number;
  lastUsedAt: number;
  usageKinds: Set<string>;
  sessionIds: Set<string>;
}>> {
  const stats = new Map<string, {
    count: number;
    scoreTotal: number;
    lastUsedAt: number;
    usageKinds: Set<string>;
    sessionIds: Set<string>;
  }>();
  const cutoff = usageWindowCutoff();
  for (const record of context.store.listUsageRecords(limit)) {
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

function scoreUsageBoost(stats: {
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
  const recency = ageMs <= (24 * 60 * 60 * 1000) ? 10 : ageMs <= 7 * (24 * 60 * 60 * 1000) ? 6 : ageMs <= 14 * (24 * 60 * 60 * 1000) ? 3 : 0;
  return frequency + diversity + scoreBoost + recency;
}

function inferMemoryClassForCandidate(
  context: KnowledgeConsolidationContext,
  subjectKind: KnowledgeConsolidationCandidateRecord['subjectKind'],
  subjectId: string,
): MemoryClass {
  if (subjectKind === 'node') {
    const node = context.store.getNode(subjectId);
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
  const source = context.store.getSource(subjectId);
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

function isSourcePastRefreshWindow(source: KnowledgeSourceRecord): boolean {
  if (!source.lastCrawledAt) return source.status === 'stale';
  return source.lastCrawledAt < (Date.now() - getSourceRefreshWindowMs(source));
}

function getSourceRefreshWindowMs(source: KnowledgeSourceRecord): number {
  const connectorKey = source.connectorId === 'url-list' ? 'url-list' : source.connectorId;
  return {
    bookmark: 7 * 24 * 60 * 60 * 1000,
    'bookmark-list': 7 * 24 * 60 * 60 * 1000,
    'url-list': 7 * 24 * 60 * 60 * 1000,
    url: 14 * 24 * 60 * 60 * 1000,
    repo: 14 * 24 * 60 * 60 * 1000,
    document: 21 * 24 * 60 * 60 * 1000,
    image: 21 * 24 * 60 * 60 * 1000,
    dataset: 30 * 24 * 60 * 60 * 1000,
    manual: 45 * 24 * 60 * 60 * 1000,
    other: 30 * 24 * 60 * 60 * 1000,
  }[connectorKey] ?? 30 * 24 * 60 * 60 * 1000;
}
