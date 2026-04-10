import type { MemoryRecord, MemoryRegistry } from './memory-store.ts';
import { getMemoryRegistry } from './memory-store.ts';

export interface KnowledgeInjection {
  readonly id: string;
  readonly cls: string;
  readonly summary: string;
  readonly reason: string;
  readonly confidence: number;
  readonly reviewState: 'fresh' | 'reviewed' | 'stale' | 'contradicted';
}

type KnowledgeRegistrySource =
  Pick<MemoryRegistry, 'getAll'> &
  Partial<Pick<MemoryRegistry, 'searchSemantic'>>;

let _knowledgeRegistryOverride: KnowledgeRegistrySource | undefined;

export function _setKnowledgeRegistryForTesting(
  registry: KnowledgeRegistrySource | undefined,
): void {
  _knowledgeRegistryOverride = registry;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function determineReason(
  record: MemoryRecord,
  taskTokens: readonly string[],
  scopeTokens: readonly string[],
  semanticSimilarity?: number,
): string {
  const summaryText = `${record.summary} ${record.detail ?? ''}`.toLowerCase();
  const matchingTaskToken = taskTokens.find((token) => summaryText.includes(token) || record.tags.includes(token));
  if (matchingTaskToken) {
    return `matched task token "${matchingTaskToken}"`;
  }

  const matchingScopeToken = scopeTokens.find((token) => (
    summaryText.includes(token)
    || record.tags.includes(token)
    || record.provenance.some((link) => link.ref.toLowerCase().includes(token))
  ));
  if (matchingScopeToken) {
    return `matched write scope "${matchingScopeToken}"`;
  }

  if (semanticSimilarity !== undefined) {
    return `matched sqlite-vec semantic index (${Math.round(semanticSimilarity * 100)}%)`;
  }

  return 'ranked as high-confidence relevant knowledge';
}

function scoreKnowledge(record: MemoryRecord, taskTokens: readonly string[], scopeTokens: readonly string[]): number {
  if (record.reviewState === 'contradicted') return Number.NEGATIVE_INFINITY;

  const haystack = [
    record.summary,
    record.detail ?? '',
    record.tags.join(' '),
    record.provenance.map((link) => `${link.kind}:${link.ref} ${link.label ?? ''}`).join(' '),
  ].join(' ').toLowerCase();

  let score = record.confidence;
  switch (record.reviewState) {
    case 'reviewed':
      score += 40;
      break;
    case 'fresh':
      score += 20;
      break;
    case 'stale':
      score -= 30;
      break;
  }

  for (const token of taskTokens) {
    if (haystack.includes(token)) score += 20;
  }
  for (const token of scopeTokens) {
    if (haystack.includes(token)) score += 15;
  }
  return score;
}

export function selectKnowledgeForTask(
  task: string,
  writeScope: readonly string[] = [],
  limit = 3,
): KnowledgeInjection[] {
  const registry = _knowledgeRegistryOverride ?? getMemoryRegistry();
  const taskTokens = tokenize(task);
  const scopeTokens = writeScope.flatMap((entry) => tokenize(entry));
  const semanticResults = registry.searchSemantic?.({
    query: [task, ...writeScope].join(' '),
    minConfidence: 55,
    limit: Math.max(limit * 4, 12),
  }) ?? [];
  const semanticById = new Map(semanticResults.map((entry) => [entry.record.id, entry]));
  const recordsById = new Map<string, MemoryRecord>();
  for (const record of registry.getAll()) {
    recordsById.set(record.id, record);
  }
  for (const entry of semanticResults) {
    recordsById.set(entry.record.id, entry.record);
  }

  const records = [...recordsById.values()]
    .filter((record) => record.confidence >= 55)
    .map((record) => {
      const semantic = semanticById.get(record.id);
      return {
        record,
        score: scoreKnowledge(record, taskTokens, scopeTokens) + (semantic ? semantic.similarity * 70 : 0),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
    .map((entry) => entry.record);

  return records
    .slice(0, limit)
    .map((record) => ({
      id: record.id,
      cls: record.cls,
      summary: record.summary,
      reason: determineReason(record, taskTokens, scopeTokens, semanticById.get(record.id)?.similarity),
      confidence: record.confidence,
      reviewState: record.reviewState,
    }));
}

export function buildKnowledgeInjectionPrompt(injections: readonly KnowledgeInjection[]): string | null {
  if (injections.length === 0) return null;
  const lines = [
    '## Injected Project Knowledge',
    'The runtime selected these reviewable project-memory records for this task. Use them when relevant, and prefer them over re-deriving the same context.',
  ];
  for (const injection of injections) {
    lines.push(`- [${injection.id}] (${injection.cls}, ${injection.reviewState}, confidence ${injection.confidence}) ${injection.summary} — ${injection.reason}`);
  }
  return lines.join('\n');
}
