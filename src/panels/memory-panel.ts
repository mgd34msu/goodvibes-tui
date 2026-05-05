/**
 * MemoryPanel — project memory substrate TUI panel.
 *
 * Migrated to SearchableListPanel<MemoryRecord> (Wave B1).
 */

import type { Line } from '../types/grid.ts';
import type { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryRecord, MemoryClass } from '@pellux/goodvibes-sdk/platform/state';
import { SearchableListPanel } from './scrollable-list-panel.ts';
import {
  buildBodyText,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  extendPalette,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchCancel,
} from './search-focus.ts';

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

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function classColor(cls: MemoryClass): string {
  switch (cls) {
    case 'decision': return C.decision;
    case 'constraint': return C.constraint;
    case 'incident': return C.incident;
    case 'pattern': return C.pattern;
    case 'fact': return C.fact;
    case 'risk': return C.risk;
    case 'runbook': return C.runbook;
    case 'architecture': return C.architecture;
    case 'ownership': return C.ownership;
  }
}

export class MemoryPanel extends SearchableListPanel<MemoryRecord> {
  private registry: MemoryRegistry;
  private filterFocused = false;
  private unsubscribe?: () => void;

  constructor(registry: MemoryRegistry) {
    super('memory', 'Memory', 'M', 'agent');
    this.registry = registry;
  }

  onActivate(): void {
    super.onActivate();
    this.searchQuery = '';
    this.invalidateFilter();
    this.filterFocused = false;
    this.unsubscribe = this.registry.subscribe(() => {
      this.invalidateFilter();
      this.markDirty();
    });
  }

  onDeactivate(): void {
    super.onDeactivate();
  }

  onDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  // ---------------------------------------------------------------------------
  // SearchableListPanel implementation
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
    return this.searchQuery
      ? ` No records matching "${this.searchQuery}"`
      : ' No memory records. Use /recall add <class> <summary> to create one.';
  }
  protected override getEmptyStateActions() {
    return [
      { command: '/recall add fact <summary>', summary: 'capture a durable fact directly' },
      { command: '/recall capture incident latest', summary: 'promote the latest incident into memory' },
    ];
  }

  handleInput(key: string): boolean {
    // Filter-focus mode: typing goes into the search query
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

    return super.handleInput(key);
  }

  render(width: number, height: number): Line[] {
    this.clampSelection();
    const intro = 'Durable project memory across decisions, constraints, incidents, patterns, risks, runbooks, and related provenance.';

    const records = this.getItems();
    const byClass = new Map<MemoryClass, number>();
    for (const record of records) {
      byClass.set(record.cls, (byClass.get(record.cls) ?? 0) + 1);
    }

    const filterLine = this.buildFilterInputLine(width, 'Filter', this.filterFocused);

    const summaryLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'records', value: String(records.length), valueColor: C.value },
        { label: 'facts', value: String(byClass.get('fact') ?? 0), valueColor: C.fact },
        { label: 'decisions', value: String(byClass.get('decision') ?? 0), valueColor: C.decision },
        { label: 'incidents', value: String(byClass.get('incident') ?? 0), valueColor: C.incident },
        { label: 'runbooks', value: String(byClass.get('runbook') ?? 0), valueColor: C.runbook },
      ], C),
      filterLine,
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
        buildPanelLine(width, [['  / search  j/k or Up/Down move  r reload  Esc clear search', C.dim]]),
      ],
    });
  }
}
