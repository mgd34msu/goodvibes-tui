import { MODAL_TONES } from './modal-theme.ts';
import type { ModalConfig, ModalSection, ModalListItem } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ---------------------------------------------------------------------------
// Knowledge (graph) -> modal. WO-B (Wave-6): migrates KnowledgeGraphPanel
// (src/panels/knowledge-graph-panel.ts) to a BoundModalSurface. Read-model:
// a combined nodes/sources/issues browse list plus an open-issue review
// queue, mirroring the panel's 'browse'/'review' Tab toggle.
//
// Search narrows the combined browse rows via a local substring match
// instead of replaying the panel's live `knowledge.graph.items.search()`
// call. That call is a synchronous SDK read, but invoking it from
// buildConfig() on every keystroke would make config generation depend on
// live SDK state read mid-render rather than the refresh()-loaded cache —
// the contract's "Pure" requirement on buildConfig (modal-surface.ts).
// refresh() is still the only place this module touches the SDK.
//
// Issue review mutations (accept/reject/resolve/reopen) are NOT called on
// the API here — they route to the existing `/knowledge review-issue`
// command (charter: no destructive mutation direct-called from a modal
// builder, no confirm folded into a modal).
// ---------------------------------------------------------------------------

/** Minimal read shape of a `KnowledgeNodeRecord` (`@pellux/goodvibes-sdk/platform/knowledge` -> platform/knowledge/types.ts) this modal renders. */
interface KnowledgeNodeLike {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary?: string | undefined;
}

/** Minimal read shape of a `KnowledgeSourceRecord` this modal renders. */
interface KnowledgeSourceLike {
  readonly id: string;
  readonly sourceType: string;
  readonly status: string;
  readonly title?: string | undefined;
  readonly canonicalUri?: string | undefined;
  readonly sourceUri?: string | undefined;
  readonly summary?: string | undefined;
}

/** Minimal read shape of a `KnowledgeIssueRecord` this modal renders. */
interface KnowledgeIssueLike {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly status: 'open' | 'resolved';
  readonly sourceId?: string | undefined;
  readonly nodeId?: string | undefined;
}

/** Minimal read shape of a `KnowledgeScheduleRecord` this modal renders. */
interface KnowledgeScheduleLike {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
}

/**
 * Live deps this modal reads. Structurally-narrowed slice of `KnowledgeApi`
 * (`@pellux/goodvibes-sdk/platform/knowledge`) — only the four read calls
 * `KnowledgeGraphPanel` makes in its browse/review refresh
 * (graph.nodes.list, sources.list, graph.issues.list, jobs.schedules.list).
 * `graph.issues.review` is intentionally excluded: review mutations route
 * to the `/knowledge review-issue` command instead of being called from
 * this module.
 */
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

interface BrowseRow {
  readonly kind: BrowseKind;
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly detail: string;
  readonly extra: string;
}

type Mode = 'browse' | 'review';

const LIST_LIMIT = 60;

function cleanInline(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function nodeRow(node: KnowledgeNodeLike): BrowseRow {
  return {
    kind: 'node',
    id: node.id,
    title: cleanInline(node.title) || 'untitled',
    tag: `node/${node.kind}`,
    detail: cleanInline(node.summary),
    extra: '',
  };
}

function sourceRow(source: KnowledgeSourceLike): BrowseRow {
  return {
    kind: 'source',
    id: source.id,
    title: cleanInline(source.title) || cleanInline(source.canonicalUri) || cleanInline(source.sourceUri) || source.id,
    tag: `source/${source.status}`,
    detail: cleanInline(source.summary),
    extra: `type ${source.sourceType}`,
  };
}

function issueRow(issue: KnowledgeIssueLike): BrowseRow {
  const refs = [
    issue.sourceId ? `source ${issue.sourceId}` : null,
    issue.nodeId ? `node ${issue.nodeId}` : null,
  ].filter((ref): ref is string => ref !== null);
  return {
    kind: 'issue',
    id: issue.id,
    title: issue.code,
    tag: `issue/${issue.severity}`,
    detail: cleanInline(issue.message),
    extra: refs.join('  '),
  };
}

function matchesQuery(row: BrowseRow, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return row.kind.includes(needle)
    || row.title.toLowerCase().includes(needle)
    || row.tag.toLowerCase().includes(needle)
    || row.detail.toLowerCase().includes(needle);
}

/**
 * Knowledge graph -> modal. Browse mode lists sources/nodes/issues together
 * (counts + a filterable combined list); review mode narrows to the open
 * issue queue. Both modes share the same selection/detail machinery.
 */
export function bindKnowledgeModal(deps: KnowledgeModalDeps): BoundModalSurface {
  let mode: Mode = 'browse';
  let browseRows: BrowseRow[] = [];
  let reviewRows: BrowseRow[] = [];
  let sourceCount = 0;
  let nodeCount = 0;
  let issueCount = 0;
  let schedules: readonly KnowledgeScheduleLike[] = [];
  let loadError: string | null = null;

  const refresh = (): void => {
    try {
      const nodes = deps.knowledgeApi.graph.nodes.list(LIST_LIMIT);
      const sources = deps.knowledgeApi.sources.list(LIST_LIMIT);
      const issues = deps.knowledgeApi.graph.issues.list(LIST_LIMIT);
      sourceCount = sources.length;
      nodeCount = nodes.length;
      issueCount = issues.length;
      browseRows = [...sources.map(sourceRow), ...nodes.map(nodeRow), ...issues.map(issueRow)];
      reviewRows = issues.filter((issue) => issue.status === 'open').map(issueRow);
      schedules = deps.knowledgeApi.jobs.schedules.list(20);
      loadError = null;
    } catch (e) {
      browseRows = [];
      reviewRows = [];
      schedules = [];
      loadError = `Knowledge graph load failed: ${summarizeError(e)}`;
    }
  };

  const activeRows = (): BrowseRow[] => (mode === 'review' ? reviewRows : browseRows);

  const visibleRows = (view: ModalViewState): BrowseRow[] => activeRows().filter((row) => matchesQuery(row, view.query));

  const selectedRow = (view: ModalViewState): BrowseRow | undefined => {
    const visible = visibleRows(view);
    if (visible.length === 0) return undefined;
    return visible[Math.max(0, Math.min(view.selectedIndex, visible.length - 1))];
  };

  const buildConfig = (view: ModalViewState): ModalConfig => {
    const sections: ModalSection[] = [];

    if (loadError) {
      sections.push({ type: 'text', content: loadError, style: { fg: MODAL_TONES.bad } });
      return { title: 'Knowledge', width: 78, sections, footer: 'esc close' };
    }

    const readySources = sourceCount > 0 && nodeCount > 0;
    sections.push({
      type: 'text',
      content: `sources ${sourceCount}  nodes ${nodeCount}  issues ${issueCount}  schedules ${schedules.length}`,
      style: { dim: true },
    });
    sections.push({
      type: 'text',
      content: readySources ? 'retrieval ready (sources + nodes indexed)' : 'retrieval not ready (needs sources and nodes)',
      style: { fg: readySources ? MODAL_TONES.good : MODAL_TONES.warn },
    });
    sections.push({ type: 'text', content: `mode: ${mode === 'review' ? 'Review Queue' : 'Browse'}  (tab toggles)` });
    sections.push({ type: 'separator' });

    const visible = visibleRows(view);
    const selectedIdx = Math.max(0, Math.min(view.selectedIndex, visible.length - 1));
    const items: ModalListItem[] = visible.map((row, index) => ({
      label: `${row.tag.padEnd(16)} ${row.title.padEnd(28)} ${row.detail}`,
      selected: index === selectedIdx,
    }));
    if (items.length === 0) {
      sections.push({
        type: 'text',
        content: mode === 'review'
          ? 'No issues waiting for review.'
          : (view.query ? `No results matching "${view.query}".` : 'No ingested knowledge yet.'),
        style: { dim: true },
      });
    } else {
      sections.push({ type: 'list', items });
    }

    const selected = selectedRow(view);
    if (selected) {
      sections.push({ type: 'separator' });
      sections.push({ type: 'text', content: `${selected.tag}  id ${selected.id}`, style: { dim: true } });
      if (selected.detail) sections.push({ type: 'text', content: selected.detail });
      if (selected.extra) sections.push({ type: 'text', content: selected.extra, style: { dim: true } });
    }

    if (mode === 'browse' && schedules.length > 0) {
      sections.push({ type: 'title', content: 'Schedules' });
      for (const schedule of schedules.slice(0, 4)) {
        sections.push({
          type: 'text',
          content: `${schedule.enabled ? 'on ' : 'off'}  ${schedule.label}`,
          style: { dim: !schedule.enabled },
        });
      }
    }

    const hints = mode === 'review'
      ? ['up/down move', 'a accept', 'x reject', 'r resolve', 'o reopen', 'tab browse']
      : ['up/down move', '/ filter', 'tab review queue', 'm memory', 'r refresh'];

    return {
      title: 'Knowledge',
      width: 78,
      ...(mode === 'browse' ? { search: view.query } : {}),
      sections,
      hints,
    };
  };

  const reviewAction = (action: 'accept' | 'reject' | 'resolve' | 'reopen'): ModalAction => (view) => {
    const row = selectedRow(view);
    if (!row || row.kind !== 'issue') return { kind: 'none' };
    return { kind: 'runCommand', command: `/knowledge review-issue ${row.id} ${action} --reviewer tui` };
  };

  return {
    name: 'knowledge',
    title: 'Knowledge',
    refresh,
    buildConfig,
    rowIds: (view) => visibleRows(view).map((row) => `${row.kind}:${row.id}`),
    actions: {
      refresh: () => ({ kind: 'refresh' }),
      toggleMode: () => {
        mode = mode === 'browse' ? 'review' : 'browse';
        return { kind: 'refresh' };
      },
      accept: reviewAction('accept'),
      reject: reviewAction('reject'),
      resolve: reviewAction('resolve'),
      reopen: reviewAction('reopen'),
      openMemory: () => ({ kind: 'openModal', name: 'memory' }),
    },
  };
}

/**
 * Deterministic golden fixture: fixed node/source/issue/schedule records —
 * no live SDK calls, no random ids, no wall-clock reads — so the rendered
 * config is byte-stable across runs.
 */
export function knowledgeModalGoldenSurface(): BoundModalSurface {
  const nodes: readonly KnowledgeNodeLike[] = [
    { id: 'node-1', kind: 'topic', title: 'Release cadence', summary: 'Batched internal releases, no per-change tags.' },
  ];
  const sources: readonly KnowledgeSourceLike[] = [
    { id: 'source-1', sourceType: 'repo', status: 'indexed', title: 'goodvibes-tui', canonicalUri: 'repo://goodvibes-tui', summary: 'Primary TUI repository.' },
  ];
  const issues: readonly KnowledgeIssueLike[] = [
    { id: 'issue-1', severity: 'warning', code: 'stale-source', message: 'Source has not been recrawled in 30 days.', status: 'open', sourceId: 'source-1' },
  ];
  const schedules: readonly KnowledgeScheduleLike[] = [
    { id: 'sched-1', label: 'Nightly reindex', enabled: true },
  ];
  const surface = bindKnowledgeModal({
    knowledgeApi: {
      graph: {
        nodes: { list: () => nodes },
        issues: { list: () => issues },
      },
      sources: { list: () => sources },
      jobs: { schedules: { list: () => schedules } },
    },
  });
  surface.refresh();
  return surface;
}
