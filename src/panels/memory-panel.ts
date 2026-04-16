/**
 * MemoryPanel — project memory substrate TUI panel.
 */

import type { Line } from '../types/grid.ts';
import type { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/memory-store';
import type { MemoryRecord, MemoryClass } from '@pellux/goodvibes-sdk/platform/state/memory-store';
import { BasePanel } from './base-panel.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildSearchInputLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
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
} as const;

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

export class MemoryPanel extends BasePanel {
  private registry: MemoryRegistry;
  private records: MemoryRecord[] = [];
  private selectedIdx = 0;
  private scrollOffset = 0;
  private searchMode = false;
  private searchQuery = '';
  private unsubscribe?: () => void;

  constructor(registry: MemoryRegistry) {
    super('memory', 'Memory', 'M', 'agent');
    this.registry = registry;
  }

  onActivate(): void {
    super.onActivate();
    this.reload();
    this.unsubscribe = this.registry.subscribe(() => {
      this.reload();
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

  private reload(): void {
    const filter = this.searchQuery.trim()
      ? { query: this.searchQuery.trim(), limit: 100 }
      : { limit: 100 };
    this.records = this.registry.search(filter);
    this.selectedIdx = Math.min(this.selectedIdx, Math.max(0, this.records.length - 1));
  }

  handleInput(key: string): boolean {
    if (this.searchMode) return this.handleSearchInput(key);

    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIdx, itemCount: this.records.length });
    if (transition === 'focus-search') {
      this.searchMode = true;
      this.markDirty();
      return true;
    }

    switch (key) {
      case 'ArrowUp':
      case 'k':
        if (this.selectedIdx > 0) {
          this.selectedIdx--;
          this.markDirty();
        }
        return true;
      case 'ArrowDown':
      case 'j':
        if (this.selectedIdx < this.records.length - 1) {
          this.selectedIdx++;
          this.markDirty();
        }
        return true;
      case 'Escape':
        if (this.searchQuery) {
          this.searchQuery = '';
          this.reload();
          this.markDirty();
        }
        return true;
      case 'r':
        this.reload();
        this.markDirty();
        return true;
    }
    return false;
  }

  private handleSearchInput(key: string): boolean {
    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.selectedIdx, itemCount: this.records.length });
    if (transition === 'focus-list') {
      this.searchMode = false;
      this.selectedIdx = 0;
      this.markDirty();
      return true;
    }
    if (isPanelSearchCommit(key) || isPanelSearchCancel(key)) {
      this.searchMode = false;
      this.reload();
      this.markDirty();
      return true;
    }
    if (isPanelSearchBackspace(key)) {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.markDirty();
      return true;
    }
    if (isPanelSearchPrintable(key)) {
      this.searchQuery += key;
      this.markDirty();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const intro = 'Durable project memory across decisions, constraints, incidents, patterns, risks, runbooks, and related provenance.';

    if (!this.records.length && !this.searchQuery) {
      this.reload();
    }

    if (!this.records.length) {
      const message = this.searchQuery
        ? `No records matching "${this.searchQuery}"`
        : 'No memory records. Use /recall add <class> <summary> to create one.';
      return buildPanelWorkspace(width, height, {
        title: 'Memory',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ` ${message}`,
            'Memory becomes useful once durable facts, incidents, and decisions are promoted into the project substrate.',
            [
              { command: '/recall add fact <summary>', summary: 'capture a durable fact directly' },
              { command: '/recall capture incident latest', summary: 'promote the latest incident into memory' },
            ],
            C,
          ),
        }],
        footerLines: [
          buildPanelLine(width, [['  / search  j/k or Up/Down move  r reload', C.dim]]),
        ],
        palette: C,
      });
    }

    const byClass = new Map<MemoryClass, number>();
    for (const record of this.records) {
      byClass.set(record.cls, (byClass.get(record.cls) ?? 0) + 1);
    }

    const summaryLines = [
      buildKeyValueLine(width, [
        { label: 'records', value: String(this.records.length), valueColor: C.value },
        { label: 'facts', value: String(byClass.get('fact') ?? 0), valueColor: C.fact },
        { label: 'decisions', value: String(byClass.get('decision') ?? 0), valueColor: C.decision },
        { label: 'incidents', value: String(byClass.get('incident') ?? 0), valueColor: C.incident },
        { label: 'runbooks', value: String(byClass.get('runbook') ?? 0), valueColor: C.runbook },
      ], C),
      ...(this.searchMode || this.searchQuery
        ? [buildSearchInputLine(width, '', `${this.searchMode ? '/ ' : '~ '}${this.searchQuery}${this.searchMode ? '_' : ''}`, C, { active: this.searchMode, bg: C.searchBg, valueColor: C.searchFg })]
        : []),
      buildGuidanceLine(width, '/recall review', 'review durable knowledge and queue posture from the command surface', C),
    ];

    const selected = this.records[this.selectedIdx];
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

    const summarySection: PanelWorkspaceSection = { title: 'Summary', lines: summaryLines };
    const selectedSection: PanelWorkspaceSection = selectedLines.length > 0 ? { title: 'Selected', lines: selectedLines } : { title: 'Selected', lines: [] };
    const recordsSection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines: [
        buildPanelLine(width, [['  / search  j/k or Up/Down move  r reload  Esc clear search', C.dim]]),
      ],
      palette: C,
      beforeSections: [summarySection],
      section: {
        title: 'Records',
        scrollableLines: this.records.map((record, globalIndex) => {
          const bg = globalIndex === this.selectedIdx ? C.selected : undefined;
          return buildPanelLine(width, [
            ['  ', C.label, bg],
            [`[${record.scope.slice(0, 1).toUpperCase()}/${record.cls.slice(0, 3).toUpperCase()}] `, classColor(record.cls), bg],
            [record.id.slice(-8), C.dim, bg],
            ['  ', C.label, bg],
            [fmtTime(record.createdAt), C.dim, bg],
            ['  ', C.label, bg],
            [record.summary.slice(0, Math.max(0, width - 33)), C.value, bg],
          ]);
        }),
        selectedIndex: this.selectedIdx,
        scrollOffset: this.scrollOffset,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: selectedLines.length > 0 ? [selectedSection] : [],
    });
    this.scrollOffset = recordsSection.scrollOffset;
    const sections: PanelWorkspaceSection[] = [
      summarySection,
      recordsSection.section,
    ];
    if (selectedLines.length > 0) sections.push(selectedSection);

    return buildPanelWorkspace(width, height, {
      title: 'Memory',
      intro,
      sections,
      footerLines: [
        buildPanelLine(width, [['  / search  j/k or Up/Down move  r reload  Esc clear search', C.dim]]),
      ],
      palette: C,
    });
  }
}
