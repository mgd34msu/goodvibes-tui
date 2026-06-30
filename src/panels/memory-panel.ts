/**
 * MemoryPanel — merged project memory substrate panel.
 *
 * TASK-040: Merged from the former separate MemoryPanel + KnowledgePanel.
 * One panel, two filter modes toggled with Tab:
 *   - 'all'    : full record list with search (former MemoryPanel behaviour)
 *   - 'review' : review-queue view with r/s/c/f actions (former KnowledgePanel behaviour)
 *
 * Panel id stays 'memory'; the 'knowledge' id is repointed to the graph view.
 * No capability removed from either previous surface.
 */

import type { Line } from '../types/grid.ts';
import type { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryClass, MemoryRecord, MemoryReviewState } from '@pellux/goodvibes-sdk/platform/state';
import { ScrollableListPanel, SearchableListPanel } from './scrollable-list-panel.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import {
  buildBodyText,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  extendPalette,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchCancel,
} from './search-focus.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ---------------------------------------------------------------------------
// Colour palette
// ---------------------------------------------------------------------------

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  header: '#94a3b8',
  headerBg: '#1e293b',
  decision: '#38bdf8',
  constraint: '#f97316',
  incident: '#ef4444',
  pattern: '#a78bfa',
  fact: '#22c55e',
  risk: '#f43f5e',
  runbook: '#eab308',
  architecture: '#60a5fa',
  ownership: '#14b8a6',
  selected: '#1e3a5f',
  searchBg: '#0f172a',
  searchFg: '#e2e8f0',
});

// ---------------------------------------------------------------------------
// Filter modes
// ---------------------------------------------------------------------------

type FilterMode = 'all' | 'review';

const FILTER_LABELS: Record<FilterMode, string> = {
  all:    'All Records',
  review: 'Review Queue',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function classColor(cls: MemoryClass): string {
  switch (cls) {
    case 'decision':     return C.decision;
    case 'constraint':   return C.constraint;
    case 'incident':     return C.incident;
    case 'pattern':      return C.pattern;
    case 'fact':         return C.fact;
    case 'risk':         return C.risk;
    case 'runbook':      return C.runbook;
    case 'architecture': return C.architecture;
    case 'ownership':    return C.ownership;
  }
}

function reviewStateColor(state: MemoryReviewState): string {
  switch (state) {
    case 'reviewed':     return C.good;
    case 'stale':        return C.warn;
    case 'contradicted': return C.bad;
    case 'fresh':
    default:             return C.info;
  }
}

function formatConfidence(confidence: number): string {
  return `${confidence.toString().padStart(3, ' ')}%`;
}

// ---------------------------------------------------------------------------
// MemoryPanel
// ---------------------------------------------------------------------------

export class MemoryPanel extends SearchableListPanel<MemoryRecord> {
  private readonly registry: MemoryRegistry;
  private filterMode: FilterMode = 'all';
  private filterFocused = false;
  private unsubscribe?: () => void;

  // Review-mode confirm state (for destructive stale/contradict actions)
  private confirm: ConfirmState<{ id: string; action: 'stale' | 'contradicted' }> | null = null;

  // Cached records for review-mode (reviewQueue-first, same as former KnowledgePanel)
  private reviewRecords: MemoryRecord[] = [];

  constructor(registry: MemoryRegistry) {
    super('memory', 'Memory', 'M', 'agent');
    this.registry = registry;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    this.searchQuery = '';
    this.invalidateFilter();
    this.filterFocused = false;
    this.confirm = null;
    this.refreshReviewRecords();
    this.unsubscribe = this.registry.subscribe(() => {
      this.invalidateFilter();
      this.refreshReviewRecords();
      this.markDirty();
    });
  }

  override onDeactivate(): void {
    super.onDeactivate();
  }

  override onDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  // ---------------------------------------------------------------------------
  // SearchableListPanel implementation (used in 'all' filter mode)
  // ---------------------------------------------------------------------------

  protected getAllItems(): readonly MemoryRecord[] {
    return this.registry.search({ limit: 100 });
  }

  protected matchesSearch(record: MemoryRecord, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const haystack = [
      record.summary,
      record.detail ?? '',
      record.cls,
      record.scope,
      record.tags.join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  }

  protected renderItem(record: MemoryRecord, index: number, selected: boolean, width: number): Line {
    if (this.filterMode === 'review') {
      // Review-mode row: reviewState + confidence (matches former KnowledgePanel row)
      const bg = selected ? C.selectBg : undefined;
      return buildPanelLine(width, [
        ['  ', C.label, bg],
        [record.reviewState.padEnd(13), reviewStateColor(record.reviewState), bg],
        [` ${formatConfidence(record.confidence)} `, C.value, bg],
        [record.summary.slice(0, Math.max(0, width - 26)), C.value, bg],
      ]);
    }
    // All-mode row: scope/class + id + time + summary (matches former MemoryPanel row)
    const bg = selected ? C.selected : undefined;
    return buildPanelLine(width, [
      ['  ', C.label, bg],
      [`[${record.scope.slice(0, 1).toUpperCase()}/${record.cls.slice(0, 3).toUpperCase()}] `, classColor(record.cls), bg],
      [record.id.slice(-8), C.dim, bg],
      ['  ', C.label, bg],
      [fmtTime(record.createdAt), C.dim, bg],
      ['  ', C.label, bg],
      [record.summary.slice(0, Math.max(0, width - 33)), C.value, bg],
    ]);
  }

  protected override getPalette() { return C; }

  protected override getEmptyStateMessage() {
    if (this.filterMode === 'review') return 'No records in the review queue.';
    return this.searchQuery
      ? ` No records matching "${this.searchQuery}"`
      : ' No memory records. Use /recall add <class> <summary> to create one.';
  }

  protected override getEmptyStateActions() {
    return [
      { command: '/recall add fact <summary>', summary: 'capture a durable fact directly' },
      { command: '/recall capture incident latest', summary: 'promote the latest incident into memory' },
      { command: '/recall capture policy', summary: 'store the current policy posture as durable evidence' },
    ];
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Override getItems() so that ScrollableListPanel infrastructure (renderList,
   * clampSelection, navigation bounds) all operate on reviewRecords in review
   * mode — preventing the render/action index desync where rendered list index N
   * did not correspond to reviewRecords[N] when the two lists differ.
   */
  protected override getItems(): readonly MemoryRecord[] {
    if (this.filterMode === 'review') return this.reviewRecords;
    return super.getItems();
  }

  private refreshReviewRecords(): void {
    this.reviewRecords = this.registry.reviewQueue(24);
    this.clampSelection();
  }

  private cycleFilter(): void {
    const modes: FilterMode[] = ['all', 'review'];
    const next = modes[(modes.indexOf(this.filterMode) + 1) % modes.length];
    this.filterMode = next;
    this.invalidateFilter();
    this.refreshReviewRecords();
    this.markDirty();
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  handleInput(key: string): boolean {
    // Review confirm dialog intercepts all input
    if (this.confirm) {
      const result = handleConfirmInput(this.confirm, key);
      if (result === 'confirmed') {
        const { id, action } = this.confirm.subject;
        this.confirm = null;
        const record = this.reviewRecords.find((r) => r.id === id);
        if (record) {
          try {
            if (action === 'stale') {
              this.registry.review(id, {
                state: 'stale',
                confidence: Math.min(record.confidence, 40),
                reviewedBy: 'operator',
                staleReason: 'marked stale from the memory panel',
              });
            } else {
              this.registry.review(id, {
                state: 'contradicted',
                confidence: 0,
                reviewedBy: 'operator',
                staleReason: 'marked contradicted from the memory panel',
              });
            }
          } catch (e) {
            this.setError(`Review update failed: ${summarizeError(e)}`);
          }
        }
        this.refreshReviewRecords();
        this.markDirty();
        return true;
      }
      if (result === 'cancelled') {
        this.confirm = null;
        this.markDirty();
        return true;
      }
      if (result === 'absorbed') return true;
    }

    // Tab cycles filter modes
    if (key === 'tab') {
      this.cycleFilter();
      return true;
    }

    // Review-mode specific actions (r/s/c/f)
    if (this.filterMode === 'review') {
      const selected = this.reviewRecords[this.selectedIndex];

      if (key === 'enter' || key === 'return' || key === 'r') {
        if (!selected) return false;
        this.registry.review(selected.id, {
          state: 'reviewed',
          confidence: Math.max(selected.confidence, 85),
          reviewedBy: 'operator',
        });
        this.refreshReviewRecords();
        this.markDirty();
        return true;
      }
      if (key === 's') {
        if (!selected) return false;
        this.confirm = { subject: { id: selected.id, action: 'stale' }, label: selected.summary.slice(0, 40) };
        this.markDirty();
        return true;
      }
      if (key === 'c') {
        if (!selected) return false;
        this.confirm = { subject: { id: selected.id, action: 'contradicted' }, label: selected.summary.slice(0, 40) };
        this.markDirty();
        return true;
      }
      if (key === 'f') {
        if (!selected) return false;
        this.registry.review(selected.id, {
          state: 'fresh',
          confidence: Math.max(selected.confidence, 60),
          reviewedBy: 'operator',
        });
        this.refreshReviewRecords();
        this.markDirty();
        return true;
      }
    }

    // All-mode: search filter focus
    if (this.filterMode === 'all') {
      if (this.filterFocused) {
        const items = this.getItems();
        const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIndex, itemCount: items.length });
        if (transition === 'focus-list') {
          this.filterFocused = false;
          this.markDirty();
          return true;
        }
        if (isPanelSearchCancel(key)) {
          this.filterFocused = false;
          return super.handleInput(key);
        }
        return super.handleInput(key);
      }

      const items = this.getItems();
      const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIndex, itemCount: items.length });
      if (transition === 'focus-search') {
        this.filterFocused = true;
        this.markDirty();
        return true;
      }

      if (key === 'r') {
        this.invalidateFilter();
        this.markDirty();
        return true;
      }
    }

    // In review mode, navigation keys (j/k/up/down/etc.) must bypass
    // SearchableListPanel's printable-character interception, which would
    // otherwise swallow single-char keys like 'j' and 'k' as search input.
    if (this.filterMode === 'review') {
      return ScrollableListPanel.prototype.handleInput.call(this, key);
    }
    return super.handleInput(key);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    this.clampSelection();

    // Review confirm dialog takes over the full panel
    if (this.confirm) {
      return buildPanelWorkspace(width, height, {
        title: 'Memory',
        intro: '',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
        footerLines: [buildPanelLine(width, [['  y confirm  n / Esc cancel', C.dim]])],
        palette: C,
      });
    }

    const filterLabel = FILTER_LABELS[this.filterMode];
    const filterToggleLine = buildPanelLine(width, [
      ['  Filter: ', C.label],
      [filterLabel, C.info],
      ['  (Tab to toggle)', C.dim],
    ]);

    if (this.filterMode === 'review') {
      return this.renderReviewMode(width, height, filterToggleLine);
    }
    return this.renderAllMode(width, height, filterToggleLine);
  }

  private renderAllMode(width: number, height: number, filterToggleLine: Line): Line[] {
    const records = this.getItems();
    const byClass = new Map<MemoryClass, number>();
    for (const record of records) {
      byClass.set(record.cls, (byClass.get(record.cls) ?? 0) + 1);
    }

    const filterInputLine = this.buildFilterInputLine(width, 'Search', this.filterFocused);

    const summaryLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'records', value: String(records.length), valueColor: C.value },
        { label: 'facts', value: String(byClass.get('fact') ?? 0), valueColor: C.fact },
        { label: 'decisions', value: String(byClass.get('decision') ?? 0), valueColor: C.decision },
        { label: 'incidents', value: String(byClass.get('incident') ?? 0), valueColor: C.incident },
        { label: 'runbooks', value: String(byClass.get('runbook') ?? 0), valueColor: C.runbook },
      ], C),
      filterToggleLine,
      filterInputLine,
      buildGuidanceLine(width, '/recall review', 'review durable knowledge and queue posture from the command surface', C),
    ];

    const selected = records[this.selectedIndex];
    const selectedLines: Line[] = [];
    if (selected) {
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'scope', value: selected.scope, valueColor: C.info },
        { label: 'class', value: selected.cls, valueColor: classColor(selected.cls) },
        { label: 'created', value: fmtTime(selected.createdAt), valueColor: C.dim },
      ], C));
      selectedLines.push(...buildBodyText(width, selected.summary, C, C.value));
      if (selected.detail) selectedLines.push(...buildBodyText(width, `Detail: ${selected.detail}`, C, C.dim));
      if (selected.tags.length) selectedLines.push(buildPanelLine(width, [[`  Tags: ${selected.tags.join(', ')}`, C.good]]));
      if (selected.provenance.length) {
        selectedLines.push(...buildBodyText(
          width,
          `Provenance: ${selected.provenance.map((p) => `${p.kind}:${p.ref}`).join('  ')}`,
          C,
          C.dim,
        ));
      }
    }

    return this.renderList(width, height, {
      title: 'Memory',
      header: summaryLines,
      footer: [
        ...selectedLines,
        buildPanelLine(width, [['  / search  j/k or Up/Down move  r reload  Tab: Review Queue  Esc clear search', C.dim]]),
      ],
    });
  }

  private renderReviewMode(width: number, height: number, filterToggleLine: Line): Line[] {
    if (this.reviewRecords.length === 0) this.refreshReviewRecords();

    const allRecords = this.registry.search({ limit: 200 });
    const queue = this.registry.reviewQueue(24);
    const byClass = new Map<MemoryClass, number>();
    const byReview = new Map<MemoryReviewState, number>();
    const byScope = new Map<string, number>();
    for (const record of allRecords) {
      byClass.set(record.cls, (byClass.get(record.cls) ?? 0) + 1);
      byReview.set(record.reviewState, (byReview.get(record.reviewState) ?? 0) + 1);
      byScope.set(record.scope, (byScope.get(record.scope) ?? 0) + 1);
    }

    const classLines: Line[] = [
      buildPanelLine(width, [
        [' facts ', C.label], [String(byClass.get('fact') ?? 0), C.good],
        ['  risks ', C.label], [String(byClass.get('risk') ?? 0), (byClass.get('risk') ?? 0) > 0 ? C.warn : C.good],
        ['  runbooks ', C.label], [String(byClass.get('runbook') ?? 0), C.info],
        ['  architecture ', C.label], [String(byClass.get('architecture') ?? 0), C.info],
        ['  incidents ', C.label], [String(byClass.get('incident') ?? 0), (byClass.get('incident') ?? 0) > 0 ? C.bad : C.good],
      ]),
      buildPanelLine(width, [
        [' decisions ', C.label], [String(byClass.get('decision') ?? 0), C.value],
        ['  constraints ', C.label], [String(byClass.get('constraint') ?? 0), C.value],
        ['  ownership ', C.label], [String(byClass.get('ownership') ?? 0), C.value],
        ['  patterns ', C.label], [String(byClass.get('pattern') ?? 0), C.value],
        ['  total ', C.label], [String(allRecords.length), C.value],
      ]),
    ];

    const reviewLines: Line[] = [
      buildPanelLine(width, [
        [' reviewed ', C.label], [String(byReview.get('reviewed') ?? 0), C.good],
        ['  fresh ', C.label], [String(byReview.get('fresh') ?? 0), C.info],
        ['  stale ', C.label], [String(byReview.get('stale') ?? 0), C.warn],
        ['  contradicted ', C.label], [String(byReview.get('contradicted') ?? 0), C.bad],
        ['  Queue ', C.label], [String(queue.length), queue.length > 0 ? C.warn : C.good],
      ]),
      buildPanelLine(width, [
        [' session ', C.label], [String(byScope.get('session') ?? 0), C.info],
        ['  project ', C.label], [String(byScope.get('project') ?? 0), C.value],
        ['  team ', C.label], [String(byScope.get('team') ?? 0), C.good],
      ]),
      filterToggleLine,
      buildGuidanceLine(width, '/recall review', 'work the stale and contradicted queue from the command surface', C),
    ];

    const selectedRecord = this.reviewRecords[this.selectedIndex];
    const selectedLines: Line[] = [];
    if (selectedRecord) {
      selectedLines.push(buildPanelLine(width, [['  Selected', C.label]]));
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'Class', value: selectedRecord.cls, valueColor: C.value },
        { label: 'Scope', value: selectedRecord.scope, valueColor: C.info },
        { label: 'Review', value: selectedRecord.reviewState, valueColor: reviewStateColor(selectedRecord.reviewState) },
        { label: 'Confidence', value: formatConfidence(selectedRecord.confidence), valueColor: C.value },
      ], C));
      selectedLines.push(...buildBodyText(width, `Summary: ${selectedRecord.summary}`, C, C.value));
      if (selectedRecord.detail) selectedLines.push(...buildBodyText(width, `Detail: ${selectedRecord.detail}`, C, C.dim));
      if (selectedRecord.provenance.length) {
        selectedLines.push(...buildBodyText(
          width,
          `Provenance: ${selectedRecord.provenance.map((p) => `${p.kind}:${p.ref}`).join(', ')}`,
          C,
          C.dim,
        ));
      }
      if (selectedRecord.staleReason) {
        selectedLines.push(...buildBodyText(
          width,
          `Stale reason: ${selectedRecord.staleReason}`,
          C,
          selectedRecord.reviewState === 'contradicted' ? C.bad : C.warn,
        ));
      }
      if (selectedRecord.reviewedAt) {
        selectedLines.push(buildPanelLine(width, [
          ['  Reviewed: ', C.label],
          [new Date(selectedRecord.reviewedAt).toLocaleString(), C.dim],
        ]));
        if (selectedRecord.reviewedBy) {
          selectedLines.push(buildPanelLine(width, [
            ['  Reviewer: ', C.label],
            [selectedRecord.reviewedBy, C.dim],
          ]));
        }
      }
    }

    return this.renderList(width, height, {
      title: 'Memory',
      header: [...classLines, ...reviewLines],
      footer: [
        ...(selectedLines.length > 0 ? selectedLines : []),
        buildPanelLine(width, [['  Tab: All Records  Up/Down move  r/Enter reviewed  s stale  c contradicted  f fresh', C.dim]]),
      ],
    });
  }
}
