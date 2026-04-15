import type { KnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge/store';
import type {
  KnowledgePacket,
  KnowledgePacketDetail,
  KnowledgePacketItem,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
  KnowledgeNodeRecord,
  KnowledgeUsageRecord,
} from '@pellux/goodvibes-sdk/platform/knowledge/types';
import { emitKnowledgePacketBuilt } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import {
  DEFAULT_PACKET_BUDGET,
  DEFAULT_PACKET_LIMIT,
  estimateTokens,
  isSourcePastRefreshWindow,
  renderPacket,
  scoreHaystack,
  summarizeCompact,
  tokenize,
  trimForDetail,
} from '@pellux/goodvibes-sdk/platform/knowledge/internal';

export interface KnowledgePacketContext {
  readonly store: KnowledgeStore;
  readonly deferUsage: (input: {
    readonly targetKind: KnowledgeUsageRecord['targetKind'];
    readonly targetId: string;
    readonly usageKind: KnowledgeUsageRecord['usageKind'];
    readonly task?: string;
    readonly sessionId?: string;
    readonly score?: number;
    readonly metadata?: Record<string, unknown>;
  }) => void;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
}

export function searchKnowledge(
  context: KnowledgePacketContext,
  query: string,
  limit = 10,
): KnowledgeSearchResult[] {
  const taskTokens = tokenize(query);
  if (taskTokens.length === 0) return [];
  const sourceResults = context.store.listSources(10_000).map((source) => {
    const extraction = context.store.getExtractionBySourceId(source.id);
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
    const { score, reason } = scoreHaystack(haystack, taskTokens, []);
    return {
      kind: 'source' as const,
      id: source.id,
      score: score + (source.status === 'indexed' ? 10 : 0) + (extraction ? 8 : 0),
      reason,
      source,
    };
  });
  const nodeResults = context.store.listNodes(10_000).map((node) => {
    const haystack = [
      node.title,
      node.summary ?? '',
      node.aliases.join(' '),
      JSON.stringify(node.metadata),
    ].join(' ').toLowerCase();
    const { score, reason } = scoreHaystack(haystack, taskTokens, []);
    return {
      kind: 'node' as const,
      id: node.id,
      score,
      reason,
      node,
    };
  });
  const results = [...sourceResults, ...nodeResults]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit));
  for (const result of results.slice(0, Math.min(results.length, 6))) {
    context.deferUsage({
      targetKind: result.kind,
      targetId: result.id,
      usageKind: 'search-hit',
      task: query,
      score: result.score,
      metadata: { reason: result.reason },
    });
  }
  return results;
}

export async function buildKnowledgePacket(
  context: KnowledgePacketContext,
  task: string,
  writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT,
  options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
): Promise<KnowledgePacket> {
  return buildKnowledgePacketFromCurrentState(context, task, writeScope, limit, options);
}

export function buildKnowledgePacketSync(
  context: KnowledgePacketContext,
  task: string,
  writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT,
  options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
): KnowledgePacket | null {
  return buildKnowledgePacketFromCurrentState(context, task, writeScope, limit, options);
}

export function buildKnowledgePromptPacketSync(
  context: KnowledgePacketContext,
  task: string,
  writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT,
  options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
): string | null {
  const packet = buildKnowledgePacketSync(context, task, writeScope, limit, options);
  return packet ? renderPacket(packet.items, packet) : null;
}

export async function buildKnowledgePromptPacket(
  context: KnowledgePacketContext,
  task: string,
  writeScope: readonly string[] = [],
  limit = DEFAULT_PACKET_LIMIT,
  options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number } = {},
): Promise<string | null> {
  const packet = await buildKnowledgePacket(context, task, writeScope, limit, options);
  return renderPacket(packet.items, packet);
}

function buildKnowledgePacketFromCurrentState(
  context: KnowledgePacketContext,
  task: string,
  writeScope: readonly string[],
  limit: number,
  options: { readonly detail?: KnowledgePacketDetail; readonly budgetLimit?: number },
): KnowledgePacket {
  const detail = options.detail ?? 'standard';
  const budgetLimit = Math.max(80, options.budgetLimit ?? DEFAULT_PACKET_BUDGET[detail]);
  const taskTokens = tokenize(task);
  const scopeTokens = writeScope.flatMap((entry) => tokenize(entry));
  const usageStats = buildUsageStats(context);
  const candidates: Array<{ score: number; item: KnowledgePacketItem }> = [];

  for (const source of context.store.listSources(10_000)) {
    const extraction = context.store.getExtractionBySourceId(source.id);
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
    const scored = scoreHaystack(haystack, taskTokens, scopeTokens);
    if (scored.score <= 0) continue;
    const evidence = detail === 'compact'
      ? []
      : (extraction?.sections.slice(0, detail === 'detailed' ? 4 : 2) ?? []);
    const summary = trimForDetail(extraction?.summary ?? source.summary ?? source.description, detail);
    const relationLabels = collectRelatedLabels(context, 'source', source.id);
    const usageBoost = scoreUsageBoost(usageStats.get(`source:${source.id}`));
    const relationBoost = Math.min(18, relationLabels.length * 3);
    const freshnessBoost = isSourcePastRefreshWindow(source) ? -8 : 6;
    const item: KnowledgePacketItem = {
      kind: 'source',
      id: source.id,
      title: source.title ?? source.canonicalUri ?? source.sourceUri ?? source.id,
      summary,
      uri: source.canonicalUri ?? source.sourceUri,
      reason: scored.reason,
      score: scored.score + (source.status === 'indexed' ? 8 : 0) + (extraction ? 6 : 0) + usageBoost + relationBoost + freshnessBoost,
      estimatedTokens: estimateTokens(summary, extraction?.excerpt, evidence.join(' ')),
      related: relationLabels,
      evidence,
      metadata: {
        sourceType: source.sourceType,
        status: source.status,
        extractionFormat: extraction?.format,
        usageCount: usageStats.get(`source:${source.id}`)?.count ?? 0,
      },
    };
    candidates.push({ score: item.score, item });
  }

  for (const node of context.store.listNodes(10_000)) {
    const haystack = [
      node.title,
      node.summary ?? '',
      node.aliases.join(' '),
      JSON.stringify(node.metadata),
    ].join(' ').toLowerCase();
    const scored = scoreHaystack(haystack, taskTokens, scopeTokens);
    if (scored.score <= 0) continue;
    const related = collectRelatedLabels(context, 'node', node.id);
    const usageBoost = scoreUsageBoost(usageStats.get(`node:${node.id}`));
    const relationBoost = Math.min(20, context.store.edgesFor('node', node.id).length * 2);
    const kindBoost = nodeKindBoost(node.kind);
    const evidence = detail === 'compact' ? related.slice(0, 1) : related.slice(0, detail === 'detailed' ? 4 : 2);
    const summary = trimForDetail(node.summary, detail);
    const item: KnowledgePacketItem = {
      kind: 'node',
      id: node.id,
      title: node.title,
      summary,
      reason: scored.reason,
      score: scored.score + usageBoost + relationBoost + kindBoost,
      estimatedTokens: estimateTokens(summary, evidence.join(' ')),
      related,
      evidence,
      metadata: {
        kind: node.kind,
        status: node.status,
        usageCount: usageStats.get(`node:${node.id}`)?.count ?? 0,
      },
    };
    candidates.push({ score: item.score, item });
  }

  const items: KnowledgePacketItem[] = [];
  let estimatedTokens = 0;
  for (const candidate of candidates
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
    .slice(0, Math.max(1, limit * 4))) {
    if (items.length >= Math.max(1, limit)) break;
    if (estimatedTokens + candidate.item.estimatedTokens > budgetLimit && items.length > 0) continue;
    items.push(candidate.item);
    estimatedTokens += candidate.item.estimatedTokens;
  }
  const packet: KnowledgePacket = {
    task,
    writeScope: [...writeScope],
    generatedAt: Date.now(),
    detail,
    strategy: 'graph-ranked extraction-aware packet',
    budgetLimit,
    estimatedTokens,
    items,
  };
  for (const item of items) {
    context.deferUsage({
      targetKind: item.kind,
      targetId: item.id,
      usageKind: 'packet-item',
      task,
      score: item.score,
      metadata: {
        detail,
        writeScope: [...writeScope],
      },
    });
  }
  context.emitIfReady((bus, ctx) => emitKnowledgePacketBuilt(bus, ctx, {
    task,
    itemCount: items.length,
    estimatedTokens,
    detail,
  }));
  return packet;
}

function collectRelatedLabels(context: KnowledgePacketContext, kind: 'source' | 'node', id: string): string[] {
  const related = context.store.edgesFor(kind, id);
  const labels: string[] = [];
  for (const edge of related) {
    const otherKind = edge.fromKind === kind && edge.fromId === id ? edge.toKind : edge.fromKind;
    const otherId = edge.fromKind === kind && edge.fromId === id ? edge.toId : edge.fromId;
    if (otherKind === 'node') {
      const node = context.store.getNode(otherId);
      if (node) labels.push(node.title);
    } else if (otherKind === 'source') {
      const source = context.store.getSource(otherId);
      if (source) labels.push(source.title ?? source.canonicalUri ?? source.id);
    }
  }
  return [...new Set(labels)].slice(0, 8);
}

function buildUsageStats(context: KnowledgePacketContext, limit = 10_000): Map<string, {
  count: number;
  scoreTotal: number;
  lastUsedAt: number;
  usageKinds: Set<string>;
  sessionIds: Set<string>;
}> {
  const stats = new Map<string, {
    count: number;
    scoreTotal: number;
    lastUsedAt: number;
    usageKinds: Set<string>;
    sessionIds: Set<string>;
  }>();
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
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

function nodeKindBoost(kind: KnowledgeNodeRecord['kind']): number {
  switch (kind) {
    case 'project':
    case 'capability':
    case 'repo':
    case 'service':
    case 'provider':
    case 'environment':
      return 12;
    case 'memory':
      return 10;
    case 'user':
      return 8;
    case 'domain':
    case 'bookmark_folder':
      return 4;
    default:
      return 0;
  }
}
