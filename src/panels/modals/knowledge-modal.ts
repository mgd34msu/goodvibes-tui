import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ---------------------------------------------------------------------------
// Knowledge (graph) → config-modal surface (group-B port). Two tabs:
// 'Browse' (sources/nodes/issues + schedules) and 'Review' (the open-issue
// queue) — the panel's browse/review toggle, now host tabs. Issue review
// mutations (accept/reject/resolve/reopen) route to the `/knowledge
// review-issue` command. 'm' cross-opens the memory surface. Selection-blind
// port: the panel's selected-row id/detail is folded into each row label.
// refresh() is the only place this module touches the SDK.
// ---------------------------------------------------------------------------

interface KnowledgeNodeLike { readonly id: string; readonly kind: string; readonly title: string; readonly summary?: string | undefined; }
interface KnowledgeSourceLike { readonly id: string; readonly sourceType: string; readonly status: string; readonly title?: string | undefined; readonly canonicalUri?: string | undefined; readonly sourceUri?: string | undefined; readonly summary?: string | undefined; }
interface KnowledgeIssueLike { readonly id: string; readonly severity: 'info' | 'warning' | 'error'; readonly code: string; readonly message: string; readonly status: 'open' | 'resolved'; readonly sourceId?: string | undefined; readonly nodeId?: string | undefined; }
interface KnowledgeScheduleLike { readonly id: string; readonly label: string; readonly enabled: boolean; }

export interface KnowledgeModalDeps {
  readonly knowledgeApi: {
    readonly graph: {
      readonly nodes: { list(limit?: number): readonly KnowledgeNodeLike[] };
      readonly issues: { list(limit?: number): readonly KnowledgeIssueLike[] };
    };
    readonly sources: { list(limit?: number): readonly KnowledgeSourceLike[] };
    readonly jobs: { schedules: { list(limit?: number): readonly KnowledgeScheduleLike[] } };
  };
}

type BrowseKind = 'node' | 'source' | 'issue';
interface BrowseRow { readonly kind: BrowseKind; readonly id: string; readonly title: string; readonly tag: string; readonly detail: string; readonly extra: string; }

const LIST_LIMIT = 60;

function cleanInline(value: string | undefined): string { return (value ?? '').replace(/\s+/g, ' ').trim(); }

function nodeRow(node: KnowledgeNodeLike): BrowseRow {
  return { kind: 'node', id: node.id, title: cleanInline(node.title) || 'untitled', tag: `node/${node.kind}`, detail: cleanInline(node.summary), extra: '' };
}
function sourceRow(source: KnowledgeSourceLike): BrowseRow {
  return { kind: 'source', id: source.id, title: cleanInline(source.title) || cleanInline(source.canonicalUri) || cleanInline(source.sourceUri) || source.id, tag: `source/${source.status}`, detail: cleanInline(source.summary), extra: `type ${source.sourceType}` };
}
function issueRow(issue: KnowledgeIssueLike): BrowseRow {
  const refs = [issue.sourceId ? `source ${issue.sourceId}` : null, issue.nodeId ? `node ${issue.nodeId}` : null].filter((ref): ref is string => ref !== null);
  return { kind: 'issue', id: issue.id, title: issue.code, tag: `issue/${issue.severity}`, detail: cleanInline(issue.message), extra: refs.join('  ') };
}

class KnowledgeModalSurface implements ConfigModalSurface {
  readonly name = 'knowledge-modal';
  readonly title = 'Knowledge';
  private browseRows: BrowseRow[] = [];
  private reviewRows: BrowseRow[] = [];
  private sourceCount = 0;
  private nodeCount = 0;
  private issueCount = 0;
  private schedules: readonly KnowledgeScheduleLike[] = [];
  private loadError: string | null = null;

  constructor(private readonly deps: KnowledgeModalDeps) {}

  private readonly issueGate = (row: ConfigModalRow | null, tabId: string): boolean => tabId === 'review' && (row?.id.startsWith('issue:') ?? false);

  readonly actions = [
    { key: 'a', id: 'accept', label: 'accept', enabledFor: this.issueGate },
    { key: 'x', id: 'reject', label: 'reject', enabledFor: this.issueGate },
    { key: 's', id: 'resolve', label: 'resolve', enabledFor: this.issueGate },
    { key: 'o', id: 'reopen', label: 'reopen', enabledFor: this.issueGate },
    { key: 'm', id: 'openMemory', label: 'memory' },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  onOpen(): void { this.refresh(); }

  private refresh(): void {
    try {
      const nodes = this.deps.knowledgeApi.graph.nodes.list(LIST_LIMIT);
      const sources = this.deps.knowledgeApi.sources.list(LIST_LIMIT);
      const issues = this.deps.knowledgeApi.graph.issues.list(LIST_LIMIT);
      this.sourceCount = sources.length;
      this.nodeCount = nodes.length;
      this.issueCount = issues.length;
      this.browseRows = [...sources.map(sourceRow), ...nodes.map(nodeRow), ...issues.map(issueRow)];
      this.reviewRows = issues.filter((issue) => issue.status === 'open').map(issueRow);
      this.schedules = this.deps.knowledgeApi.jobs.schedules.list(20);
      this.loadError = null;
    } catch (e) {
      this.browseRows = []; this.reviewRows = []; this.schedules = [];
      this.loadError = `Knowledge graph load failed: ${summarizeError(e)}`;
    }
  }

  private rowFor(row: BrowseRow): ConfigModalRow {
    return { id: `${row.kind}:${row.id}`, label: `${row.tag.padEnd(16)} ${row.title.padEnd(28)} ${row.detail}${row.extra ? `  · ${row.extra}` : ''}` };
  }

  private browseTab(): ConfigModalTab {
    const readySources = this.sourceCount > 0 && this.nodeCount > 0;
    const header = [
      `sources ${this.sourceCount}  nodes ${this.nodeCount}  issues ${this.issueCount}  schedules ${this.schedules.length}`,
      readySources ? 'retrieval ready (sources + nodes indexed)' : 'retrieval not ready (needs sources and nodes)',
    ];
    const rows: ConfigModalRow[] = this.browseRows.map((row) => this.rowFor(row));
    if (this.schedules.length > 0) {
      rows.push(infoRow('sched:title', 'Schedules'));
      this.schedules.slice(0, 4).forEach((s, i) => rows.push(infoRow(`sched:${i}`, `${s.enabled ? 'on ' : 'off'}  ${s.label}`, s.enabled ? undefined : { dim: true })));
    }
    return { id: 'browse', label: 'Browse', header, rows, emptyText: 'No ingested knowledge yet.', hints: ['m memory'] };
  }

  private reviewTab(): ConfigModalTab {
    return { id: 'review', label: 'Review', rows: this.reviewRows.map((row) => this.rowFor(row)), emptyText: 'No issues waiting for review.', hints: ['a accept', 'x reject', 's resolve', 'o reopen'] };
  }

  buildView(): ConfigModalView {
    if (this.loadError) return { title: 'Knowledge', degraded: this.loadError, tabs: [{ id: 'browse', label: 'Browse', rows: [] }] };
    return { title: 'Knowledge', tabs: [this.browseTab(), this.reviewTab()] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.refresh(); ctx.setStatus('Reloaded knowledge graph.'); return; }
    if (id === 'openMemory') { ctx.openModal?.('memory-modal'); return; }
    const action = id === 'accept' ? 'accept' : id === 'reject' ? 'reject' : id === 'resolve' ? 'resolve' : id === 'reopen' ? 'reopen' : null;
    if (!action) return;
    const issueId = ctx.row?.id.startsWith('issue:') ? ctx.row.id.slice('issue:'.length) : null;
    if (!issueId) return;
    void ctx.executeCommand?.('knowledge', ['review-issue', issueId, action, '--reviewer', 'tui']);
    ctx.setStatus(`Dispatched /knowledge review-issue ${issueId} ${action}.`);
  }
}

export function createKnowledgeModalSurface(deps: KnowledgeModalDeps): ConfigModalSurface {
  return new KnowledgeModalSurface(deps);
}

/**
 * Deterministic golden fixture: fixed node/source/issue/schedule records —
 * no live SDK calls, no random ids, no wall-clock reads.
 */
export function knowledgeModalGoldenSurface(): ConfigModalSurface {
  const nodes: readonly KnowledgeNodeLike[] = [{ id: 'node-1', kind: 'topic', title: 'Release cadence', summary: 'Batched internal releases, no per-change tags.' }];
  const sources: readonly KnowledgeSourceLike[] = [{ id: 'source-1', sourceType: 'repo', status: 'indexed', title: 'goodvibes-tui', canonicalUri: 'repo://goodvibes-tui', summary: 'Primary TUI repository.' }];
  const issues: readonly KnowledgeIssueLike[] = [{ id: 'issue-1', severity: 'warning', code: 'stale-source', message: 'Source has not been recrawled in 30 days.', status: 'open', sourceId: 'source-1' }];
  const schedules: readonly KnowledgeScheduleLike[] = [{ id: 'sched-1', label: 'Nightly reindex', enabled: true }];
  return createKnowledgeModalSurface({
    knowledgeApi: {
      graph: { nodes: { list: () => nodes }, issues: { list: () => issues } },
      sources: { list: () => sources },
      jobs: { schedules: { list: () => schedules } },
    },
  });
}
