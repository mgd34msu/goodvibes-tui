/**
 * MemoryPanel — project memory substrate TUI panel.
 *
 * Displays durable memory records (decisions, constraints, incidents, patterns)
 * with full provenance and cross-record links. Supports keyboard navigation
 * and inline search.
 */

import type { Line } from '../types/grid.ts';
import type { MemoryRegistry } from '../state/memory-store.ts';
import type { MemoryRecord, MemoryClass } from '../state/memory-store.ts';
import { BasePanel } from './base-panel.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';

// ── Colour palette ──────────────────────────────────────────────────────────────────
const C = {
  header:      '#94a3b8',
  headerBg:    '#1e293b',
  id:          '#475569',
  timestamp:   '#64748b',
  decision:    '#38bdf8',
  constraint:  '#f97316',
  incident:    '#ef4444',
  pattern:     '#a78bfa',
  summary:     '#e2e8f0',
  detail:      '#94a3b8',
  tag:         '#22c55e',
  provKey:     '#64748b',
  provVal:     '#cbd5e1',
  linkArrow:   '#38bdf8',
  linkRel:     '#94a3b8',
  selected:    '#1e3a5f',
  separator:   '#1e293b',
  dim:         '#334155',
  empty:       '#4b5563',
  searchBg:    '#0f172a',
  searchFg:    '#e2e8f0',
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function classColor(cls: MemoryClass): string {
  switch (cls) {
    case 'decision':   return C.decision;
    case 'constraint': return C.constraint;
    case 'incident':   return C.incident;
    case 'pattern':    return C.pattern;
  }
}

function writeLine(width: number, text: string, fg: string, bg = '', bold = false): Line {
  const line = createEmptyLine(width);
  let col = 0;
  for (const ch of text) {
    if (col >= width) break;
    line[col] = createStyledCell(ch, { fg, bg, bold });
    col++;
  }
  if (bg) {
    for (let i = col; i < width; i++) {
      line[i] = createStyledCell(' ', { fg, bg });
    }
  }
  return line;
}

// ── MemoryPanel ───────────────────────────────────────────────────────────────────

export class MemoryPanel extends BasePanel {
  private registry: MemoryRegistry;
  private records: MemoryRecord[] = [];
  private selectedIdx = 0;
  private scrollTop = 0;
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
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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
    if (this.searchMode) {
      return this.handleSearchInput(key);
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

      case '/':
        this.searchMode = true;
        this.searchQuery = '';
        this.markDirty();
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
    if (key === 'Enter' || key === 'Escape') {
      this.searchMode = false;
      this.reload();
      this.markDirty();
      return true;
    }
    if (key === 'Backspace') {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.markDirty();
      return true;
    }
    if (key.length === 1) {
      this.searchQuery += key;
      this.markDirty();
      return true;
    }
    return false;
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];

    // Header
    const countStr = `${this.records.length} record${this.records.length !== 1 ? 's' : ''}`;
    const headerText = `  MEMORY  ${countStr.padStart(width - 10 - 1)}`;
    lines.push(writeLine(width, headerText, C.header, C.headerBg, true));

    if (height <= 1) return lines;

    // Search bar
    if (this.searchMode || this.searchQuery) {
      const prefix = this.searchMode ? '/ ' : '~ ';
      const bar = `${prefix}${this.searchQuery}${this.searchMode ? '_' : ''}`;
      lines.push(writeLine(width, bar.padEnd(width), C.searchFg, C.searchBg));
    }

    const contentHeight = height - lines.length;

    if (!this.records.length) {
      const msg = this.searchQuery
        ? `No records matching "${this.searchQuery}"`
        : 'No memory records. Use /recall add <class> <summary> to create one.';
      lines.push(writeLine(width, '  ' + msg, C.empty));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    // Each record renders up to 4 lines (header, summary, provenance, separator)
    const visibleCount = Math.max(1, Math.floor(contentHeight / 4));

    // Adjust scroll so selected row is visible
    if (this.selectedIdx < this.scrollTop) {
      this.scrollTop = this.selectedIdx;
    } else if (this.selectedIdx >= this.scrollTop + visibleCount) {
      this.scrollTop = this.selectedIdx - visibleCount + 1;
    }

    const visible = this.records.slice(this.scrollTop, this.scrollTop + visibleCount);

    for (let i = 0; i < visible.length; i++) {
      const r = visible[i];
      const absIdx = this.scrollTop + i;
      const isSelected = absIdx === this.selectedIdx;
      const bg = isSelected ? C.selected : '';

      const clsColor = classColor(r.cls);
      const ts = fmtTime(r.createdAt);
      const tagStr = r.tags.length ? ` [${r.tags.join(' ')}]` : '';
      const idShort = r.id.slice(-8);

      // Row 1: [cls] id  timestamp  tags
      const rowText = `  [${r.cls.slice(0, 3).toUpperCase()}] ${idShort}  ${ts}${tagStr}`;
      const row1 = createEmptyLine(width);
      let col = 0;
      for (const ch of rowText) {
        if (col >= width) break;
        const fg = col < 2 ? C.dim
                 : col < 7 ? clsColor
                 : col < 10 ? C.id
                 : col < 10 + ts.length + 2 ? C.timestamp
                 : C.tag;
        row1[col] = createStyledCell(ch, { fg, bg, bold: isSelected });
        col++;
      }
      if (bg) for (let c = col; c < width; c++) row1[c] = createStyledCell(' ', { fg: '', bg });
      lines.push(row1);

      // Row 2: summary
      const summaryText = `       ${r.summary}`.slice(0, width);
      lines.push(writeLine(width, summaryText, C.summary, bg));

      // Provenance (compact)
      if (r.provenance.length) {
        const provStr = r.provenance.map(p => `${p.kind}:${p.ref}`).join('  ');
        const provLine = `       via ${provStr}`.slice(0, width);
        lines.push(writeLine(width, provLine, C.provKey, bg));
      }

      // Separator
      if (!isSelected) {
        const sep = createEmptyLine(width);
        for (let c = 0; c < width; c++) {
          sep[c] = createStyledCell(c < 4 ? ' ' : '─', { fg: C.separator });
        }
        lines.push(sep);
      } else {
        lines.push(createEmptyLine(width));
      }

      if (lines.length >= height) break;
    }

    // Fill remaining lines
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines;
  }
}
