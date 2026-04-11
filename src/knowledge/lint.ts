import type { KnowledgeStore } from './store.ts';
import type { KnowledgeIssueRecord, KnowledgeSourceRecord } from './types.ts';
import { emitKnowledgeLintCompleted } from '../runtime/emitters/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { isSourcePastRefreshWindow, LINT_NAMESPACE } from './internal.ts';

export interface KnowledgeLintContext {
  readonly store: KnowledgeStore;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
}

export async function lintKnowledgeStore(context: KnowledgeLintContext): Promise<readonly KnowledgeIssueRecord[]> {
  await context.store.init();
  const issues: KnowledgeIssueRecord[] = [];
  const sources = context.store.listSources(10_000);
  const edges = context.store.listEdges();
  const byCanonical = new Map<string, KnowledgeSourceRecord[]>();

  for (const source of sources) {
    const extraction = context.store.getExtractionBySourceId(source.id);
    if (source.canonicalUri) {
      const bucket = byCanonical.get(source.canonicalUri) ?? [];
      bucket.push(source);
      byCanonical.set(source.canonicalUri, bucket);
    }
    if (source.status === 'failed' || source.crawlError) {
      issues.push(issueForSource(source, 'error', 'crawl-failed', source.crawlError ? `Source crawl failed: ${source.crawlError}` : 'Source crawl failed.'));
    }
    if (source.status === 'indexed' && (!source.title || !source.summary)) {
      issues.push(issueForSource(source, 'warning', 'metadata-incomplete', 'Indexed source is missing a title or summary.'));
    }
    if (!extraction && source.status === 'indexed') {
      issues.push(issueForSource(source, 'warning', 'missing-extraction', 'Indexed source is missing a structured extraction record.'));
    }
    if (isSourcePastRefreshWindow(source)) {
      const refreshWindowDays = Math.max(1, Math.round(getSourceRefreshWindowMs(source) / (24 * 60 * 60 * 1000)));
      issues.push(issueForSource(
        source,
        'info',
        'stale-source',
        `Source is older than its ${refreshWindowDays}-day refresh window and should be recrawled.`,
      ));
    }
    const linked = edges.some((edge) => edge.fromKind === 'source' && edge.fromId === source.id);
    if (!linked) {
      issues.push(issueForSource(source, 'warning', 'source-unlinked', 'Source has no compiled knowledge links yet.'));
    }
    if (extraction && extraction.sections.length === 0 && !extraction.summary) {
      issues.push(issueForSource(source, 'warning', 'weak-extraction', 'Structured extraction produced almost no usable sections or summary.'));
    }
  }

  for (const bucket of byCanonical.values()) {
    if (bucket.length <= 1) continue;
    for (const source of bucket) {
      issues.push(issueForSource(source, 'warning', 'duplicate-canonical-uri', `Duplicate canonical URL detected: ${source.canonicalUri}`));
    }
  }

  const staleMemoryNodes = context.store.listNodes(10_000).filter((node) => node.kind === 'memory' && node.status === 'stale');
  for (const node of staleMemoryNodes) {
    issues.push({
      id: `issue-stale-memory-${node.id}`,
      severity: 'info',
      code: 'stale-memory',
      message: 'Mirrored memory record is stale and should be reviewed before being trusted heavily.',
      status: 'open',
      nodeId: node.id,
      metadata: { namespace: LINT_NAMESPACE },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const replaced = await context.store.replaceIssues(issues.map((issue) => ({
    ...issue,
    metadata: { ...issue.metadata, namespace: LINT_NAMESPACE },
  })), LINT_NAMESPACE);
  context.emitIfReady((bus, ctx) => emitKnowledgeLintCompleted(bus, ctx, {
    issueCount: replaced.length,
  }));
  return replaced;
}

function issueForSource(
  source: KnowledgeSourceRecord,
  severity: KnowledgeIssueRecord['severity'],
  code: string,
  message: string,
): KnowledgeIssueRecord {
  return {
    id: `issue-${code}-${source.id}`,
    severity,
    code,
    message,
    status: 'open',
    sourceId: source.id,
    metadata: { namespace: LINT_NAMESPACE },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
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
