/**
 * KnowledgeGraphPanel — SDK knowledge graph front-door.
 *
 * WO-123: Replaces the former static GRAPH_COMMANDS/MEMORY_COMMANDS command
 * catalogue with a live console over the injected KnowledgeApi surface:
 *   - 'browse' mode: header counts + a combined node/source/issue list,
 *     with '/' search dispatched through graph.items.search, plus a
 *     schedules summary from jobs.schedules.list.
 *   - 'review' mode (Tab): the open-issue review queue, with
 *     accept/reject/resolve/reopen mutations via graph.issues.review,
 *     ConfirmState-gated — mirrors MemoryPanel's proven review pattern.
 *
 * 'M' opens the Memory panel directly via panelManager.open (no more dead
 * hint text) — the two panels stay distinct: this one is the SDK graph,
 * memory-panel.ts is the durable project-memory substrate.
 */

import type { Line } from '../types/grid.ts';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type {
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeScheduleRecord,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import {
  buildBodyText,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildSearchInputLine,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

const C = DEFAULT_PANEL_PALETTE;

// The 'edit' and 'forget' review actions accept structured data the panel has
// no field to collect, so only the four browsable actions are key-bound here
// (mirrors the reduced key surface the plan calls out: a/x/r/o).
const KNOWLEDGE_REVIEW_ACTIONS = ['accept', 'reject', 'resolve', 'reopen'] as const;
type KnowledgeReviewAction = typeof KNOWLEDGE_REVIEW_ACTIONS[number];

type BrowseKind = 'node' | 'source' | 'issue' | 'result';

interface BrowseRow {
  readonly kind: BrowseKind;
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly detail: string;
}

type Mode = 'browse' | 'review';

const LIST_LIMIT = 60;
const SEARCH_LIMIT = 30;

function cleanInline(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function nodeRow(node: KnowledgeNodeRecord): BrowseRow {
  return {
    kind: 'node',
    id: node.id,
    title: cleanInline(node.title) || 'untitled',
    tag: `node/${node.kind}`,
    detail: cleanInline(node.summary),
  };
}

function sourceRow(source: KnowledgeSourceRecord): BrowseRow {
  return {
    kind: 'source',
    id: source.id,
    title: cleanInline(source.title) || cleanInline(source.canonicalUri) || cleanInline(source.sourceUri) || source.id,
    tag: `source/${source.status}`,
    detail: cleanInline(source.summary),
  };
}

function issueRow(issue: KnowledgeIssueRecord): BrowseRow {
  return {
    kind: 'issue',
    id: issue.id,
    title: issue.code,
    tag: `issue/${issue.severity}`,
    detail: cleanInline(issue.message),
  };
}

function searchResultRow(result: KnowledgeSearchResult): BrowseRow {
  const title = result.source?.title
    ?? result.source?.canonicalUri
    ?? result.node?.title
    ?? result.id;
  return {
    kind: 'result',
    id: result.id,
    title: cleanInline(title) || result.id,
    tag: `${result.kind} score=${result.score}`,
    detail: cleanInline(result.reason),
  };
}

function kindColor(kind: BrowseKind): string {
  switch (kind) {
    case 'node':   return C.info;
    case 'source': return C.good;
    case 'issue':  return C.warn;
    case 'result': return C.value;
  }
}

function severityColor(severity: KnowledgeIssueRecord['severity']): string {
  switch (severity) {
    case 'error':   return C.bad;
    case 'warning': return C.warn;
    case 'info':
    default:        return C.info;
  }
}

export class KnowledgeGraphPanel extends ScrollableListPanel<BrowseRow> {
  private readonly knowledge: KnowledgeApi;
  private readonly openMemoryPanel?: () => void;

  private mode: Mode = 'browse';

  // Browse-mode data + search state
  private browseRows: BrowseRow[] = [];
  private searchRows: BrowseRow[] = [];
  private searchFocused = false;
  private searchQuery = '';
  private sourceCount = 0;
  private nodeCount = 0;
  private issueCount = 0;
  private schedules: readonly KnowledgeScheduleRecord[] = [];

  // Review-mode data
  private reviewRows: BrowseRow[] = [];
  private reviewIssues = new Map<string, KnowledgeIssueRecord>();

  private confirm: ConfirmState<{ issueId: string; action: KnowledgeReviewAction }> | null = null;

  constructor(knowledge: KnowledgeApi, openMemoryPanel?: () => void) {
    super('knowledge', 'Knowledge', 'K', 'agent');
    this.knowledge = knowledge;
    this.openMemoryPanel = openMemoryPanel;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    this.confirm = null;
    this.refreshBrowseRows();
    this.refreshReviewRows();
  }

  // ---------------------------------------------------------------------------
  // Data refresh
  // ---------------------------------------------------------------------------

  private refreshBrowseRows(): void {
    try {
      const nodes = this.knowledge.graph.nodes.list(LIST_LIMIT);
      const sources = this.knowledge.sources.list(LIST_LIMIT);
      const issues = this.knowledge.graph.issues.list(LIST_LIMIT);
      this.sourceCount = sources.length;
      this.nodeCount = nodes.length;
      this.issueCount = issues.length;
      this.browseRows = [
        ...sources.map(sourceRow),
        ...nodes.map(nodeRow),
        ...issues.map(issueRow),
      ];
      this.schedules = this.knowledge.jobs.schedules.list(20);
    } catch (e) {
      this.setError(`Knowledge graph load failed: ${summarizeError(e)}`);
    }
    this.clampSelection();
    this.markDirty();
  }

  private refreshReviewRows(): void {
    try {
      const issues = this.knowledge.graph.issues.list(LIST_LIMIT).filter((issue) => issue.status === 'open');
      this.reviewIssues = new Map(issues.map((issue) => [issue.id, issue]));
      this.reviewRows = issues.map(issueRow);
    } catch (e) {
      this.setError(`Knowledge review queue load failed: ${summarizeError(e)}`);
    }
    this.clampSelection();
    this.markDirty();
  }

  private runSearch(): void {
    const query = this.searchQuery.trim();
    if (!query) {
      this.searchRows = [];
      this.markDirty();
      return;
    }
    try {
      this.searchRows = this.knowledge.graph.items.search(query, SEARCH_LIMIT).map(searchResultRow);
    } catch (e) {
      this.setError(`Knowledge search failed: ${summarizeError(e)}`);
      this.searchRows = [];
    }
    this.selectedIndex = 0;
    this.markDirty();
  }

  // ---------------------------------------------------------------------------
  // ScrollableListPanel implementation
  // ---------------------------------------------------------------------------

  protected getItems(): readonly BrowseRow[] {
    if (this.mode === 'review') return this.reviewRows;
    if (this.searchQuery.trim()) return this.searchRows;
    return this.browseRows;
  }

  protected renderItem(row: BrowseRow, _index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      ['  ', C.label, bg],
      [row.tag.padEnd(16), kindColor(row.kind), bg],
      [truncateDisplay(row.title, Math.max(0, Math.floor((width - 22) * 0.45))), C.value, bg],
      ['  ', C.label, bg],
      [truncateDisplay(row.detail, Math.max(0, width - 22 - Math.floor((width - 22) * 0.45) - 2)), C.dim, bg],
    ]);
  }

  protected override getPalette() { return C; }

  protected override getEmptyStateMessage(): string {
    if (this.mode === 'review') return 'No issues waiting for review.';
    if (this.searchQuery.trim()) return ` No results matching "${this.searchQuery.trim()}"`;
    return 'No ingested knowledge yet.';
  }

  protected override getEmptyStateActions() {
    if (this.mode === 'review' || this.searchQuery.trim()) return [];
    return [
      { command: '/knowledge ingest-url <url>', summary: 'ingest a URL as the first graph source' },
    ];
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  /**
   * The `/`-to-search buffer wants every character of a burst (paste, or a
   * fast-typed query landing in one input.feed() call), same as it always
   * has — see the interface doc on `Panel.isCapturingTextBurst`.
   */
  override isCapturingTextBurst(): boolean {
    return this.searchFocused;
  }

  handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (this.confirm) {
      const result = handleConfirmInput(this.confirm, key);
      if (result === 'confirmed') {
        const { issueId, action } = this.confirm.subject;
        this.confirm = null;
        void this.applyReview(issueId, action);
        return true;
      }
      if (result === 'cancelled') {
        this.confirm = null;
        this.markDirty();
        return true;
      }
      if (result === 'absorbed') return true;
    }

    if (key === 'tab') {
      this.mode = this.mode === 'browse' ? 'review' : 'browse';
      this.selectedIndex = 0;
      if (this.mode === 'review') this.refreshReviewRows();
      else this.refreshBrowseRows();
      this.markDirty();
      return true;
    }

    if (key === 'm' || key === 'M') {
      this.openMemoryPanel?.();
      return true;
    }

    if (this.mode === 'review') {
      // getItems() returns reviewRows in review mode, so the shared
      // getSelectedItem() accessor resolves the highlighted issue row.
      const selected = this.getSelectedItem();
      if (key === 'a' && selected) {
        this.confirm = { subject: { issueId: selected.id, action: 'accept' }, label: truncateDisplay(selected.detail || selected.title, 40), verb: 'Accept' };
        this.markDirty();
        return true;
      }
      if (key === 'x' && selected) {
        this.confirm = { subject: { issueId: selected.id, action: 'reject' }, label: truncateDisplay(selected.detail || selected.title, 40), verb: 'Reject' };
        this.markDirty();
        return true;
      }
      if (key === 'r' && selected) {
        this.confirm = { subject: { issueId: selected.id, action: 'resolve' }, label: truncateDisplay(selected.detail || selected.title, 40), verb: 'Resolve' };
        this.markDirty();
        return true;
      }
      if (key === 'o' && selected) {
        this.confirm = { subject: { issueId: selected.id, action: 'reopen' }, label: truncateDisplay(selected.detail || selected.title, 40), verb: 'Reopen' };
        this.markDirty();
        return true;
      }
      return ScrollableListPanel.prototype.handleInput.call(this, key);
    }

    // Browse mode: '/' search focus
    if (this.searchFocused) {
      const items = this.getItems();
      const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIndex, itemCount: items.length });
      if (transition === 'focus-list') {
        this.searchFocused = false;
        this.markDirty();
        return true;
      }
      if (isPanelSearchCancel(key)) {
        this.searchFocused = false;
        this.searchQuery = '';
        this.searchRows = [];
        this.selectedIndex = 0;
        this.markDirty();
        return true;
      }
      if (isPanelSearchBackspace(key)) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.runSearch();
        return true;
      }
      if (isPanelSearchCommit(key)) {
        this.searchFocused = false;
        this.markDirty();
        return true;
      }
      if (isPanelSearchPrintable(key)) {
        this.searchQuery += key;
        this.runSearch();
        return true;
      }
      return true;
    }

    const items = this.getItems();
    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIndex, itemCount: items.length });
    if (transition === 'focus-search') {
      this.searchFocused = true;
      this.markDirty();
      return true;
    }

    return ScrollableListPanel.prototype.handleInput.call(this, key);
  }

  private async applyReview(issueId: string, action: KnowledgeReviewAction): Promise<void> {
    try {
      await this.knowledge.graph.issues.review({ issueId, action, reviewer: 'tui' });
    } catch (e) {
      this.setError(`Review ${action} failed: ${summarizeError(e)}`);
    }
    this.refreshReviewRows();
    this.refreshBrowseRows();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    if (this.confirm) {
      return buildPanelWorkspace(width, height, {
        title: 'Knowledge',
        intro: '',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
        footerLines: [buildPanelLine(width, [['  y confirm  n / Esc cancel', C.dim]])],
        palette: C,
      });
    }

    // KnowledgeApi has no subscribe/eventing hook (unlike MemoryRegistry), so
    // pull fresh data on every render — same fetch-per-call pattern as the
    // /knowledge command handlers. These are synchronous in-memory reads.
    if (this.mode === 'review') {
      this.refreshReviewRows();
      this.clampSelection();
      return this.renderReviewMode(width, height);
    }
    this.refreshBrowseRows();
    this.clampSelection();
    return this.renderBrowseMode(width, height);
  }

  private modeToggleLine(width: number): Line {
    const label = this.mode === 'review' ? 'Review Queue' : 'Browse';
    return buildPanelLine(width, [
      ['  Mode: ', C.label],
      [label, C.info],
      ['  (Tab to toggle)', C.dim],
    ]);
  }

  private renderBrowseMode(width: number, height: number): Line[] {
    const readySources = this.sourceCount > 0 && this.nodeCount > 0;
    const summaryLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'sources', value: String(this.sourceCount), valueColor: C.good },
        { label: 'nodes', value: String(this.nodeCount), valueColor: C.info },
        { label: 'issues', value: String(this.issueCount), valueColor: this.issueCount > 0 ? C.warn : C.good },
        { label: 'schedules', value: String(this.schedules.length), valueColor: C.value },
      ], C),
      this.modeToggleLine(width),
      buildSearchInputLine(
        width,
        this.searchFocused ? '[Search] ' : 'Search: ',
        this.searchFocused ? `${this.searchQuery}_` : (this.searchQuery || '(/ to search)'),
        C,
        this.searchFocused ? { active: false, bg: C.inputBg, valueColor: C.info } : { active: false },
      ),
    ];

    const selected = this.getSelectedItem();
    const selectedLines: Line[] = [];
    if (selected) {
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'kind', value: selected.tag, valueColor: kindColor(selected.kind) },
        { label: 'id', value: selected.id.slice(-10), valueColor: C.dim },
      ], C));
      if (selected.detail) selectedLines.push(...buildBodyText(width, selected.detail, C, C.value));
      selectedLines.push(buildPanelLine(width, [
        ['  Retrieval readiness: ', C.label],
        [readySources ? 'ready (sources + nodes indexed)' : 'not ready (needs sources and nodes)', readySources ? C.good : C.warn],
      ]));
    }

    if (this.schedules.length > 0) {
      selectedLines.push(buildPanelLine(width, [['  Schedules', C.label]]));
      for (const schedule of this.schedules.slice(0, 4)) {
        selectedLines.push(buildPanelLine(width, [
          ['  ', C.label],
          [schedule.enabled ? 'on ' : 'off', schedule.enabled ? C.good : C.dim],
          ['  ', C.label],
          [truncateDisplay(schedule.label, Math.max(0, width - 14)), C.value],
        ]));
      }
    }

    return this.renderList(width, height, {
      title: 'Knowledge',
      header: summaryLines,
      footer: [
        ...selectedLines,
        buildPanelLine(width, [['  / search  j/k or Up/Down move  Tab: Review Queue  M memory panel  Esc clear search', C.dim]]),
      ],
    });
  }

  private renderReviewMode(width: number, height: number): Line[] {
    const summaryLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'open issues', value: String(this.reviewRows.length), valueColor: this.reviewRows.length > 0 ? C.warn : C.good },
      ], C),
      this.modeToggleLine(width),
    ];

    const selectedRow = this.getSelectedItem();
    const selectedIssue = selectedRow ? this.reviewIssues.get(selectedRow.id) : undefined;
    const selectedLines: Line[] = [];
    if (selectedRow && selectedIssue) {
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'severity', value: selectedIssue.severity, valueColor: severityColor(selectedIssue.severity) },
        { label: 'code', value: selectedIssue.code, valueColor: C.value },
        { label: 'status', value: selectedIssue.status, valueColor: C.info },
      ], C));
      selectedLines.push(...buildBodyText(width, selectedIssue.message, C, C.value));
    }

    return this.renderList(width, height, {
      title: 'Knowledge',
      header: summaryLines,
      footer: [
        ...selectedLines,
        buildPanelLine(width, [['  Up/Down move  a accept  x reject  r resolve  o reopen  Tab: Browse  M memory panel', C.dim]]),
      ],
    });
  }
}
