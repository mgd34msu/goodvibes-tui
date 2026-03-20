// ---------------------------------------------------------------------------
// ContextVisualizerPanel — stacked bar showing context window composition.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { EventBus } from '../core/event-bus.ts';

const C = {
  headerBg:     '#1a1a2e',
  headerFg:     '#ffffff',
  statusBar:    '#222233',
  statusFg:     '#aaaaaa',
  dimFg:        '#555566',
  systemFg:     '#00ccff',
  supplementFg: '#44aaff',
  planFg:       '#99aaff',
  convFg:       '#cc99ff',
  toolsFg:      '#ffcc44',
  overFg:       '#ff6666',
  barEmpty:     '#333344',
  labelFg:      '#8888bb',
  valueFg:      '#ccccdd',
} as const;



interface ContextSnapshot {
  input: number;
  limit: number;
}

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export class ContextVisualizerPanel extends BasePanel {
  private snapshot: ContextSnapshot = { input: 0, limit: 0 };
  private unsubs: Array<() => void> = [];

  constructor(
    private bus: EventBus,
    private getUsage?: () => { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string },
    private contextLimit?: number,
  ) {
    super('context', 'Context', 'C', 'ai');
  }

  override onActivate(): void {
    this.needsRender = true;
    this._attachBus();
    this._refresh();
  }

  override onDeactivate(): void {
    this._detachBus();
  }

  override onDestroy(): void {
    this._detachBus();
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    if (height <= 0 || width <= 0) return lines;

    const input = this.snapshot.input;
    const limit = this.snapshot.limit;
    const pct = limit > 0 ? Math.min(100, Math.round((input / limit) * 100)) : 0;
    const title = ` Input Token Usage`;
    lines.push(this._renderHdr(width, title));
    if (height <= 1) return lines.slice(0, height);

    if (height <= 2) {
      lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    // Single bar: input vs context window
    const barWidth = Math.max(1, width - 2);
    lines.push(this._renderBar(width, barWidth, input, limit));
    if (height <= 3) return lines.slice(0, height);

    // Summary line
    if (lines.length < height) {
      const overLimit = limit > 0 && input > limit;
      const fg = overLimit ? C.overFg : C.convFg;
      lines.push(this._renderSegLine(width, 'Input tokens', input, pct, fg));
    }

    // Status
    if (lines.length < height) {
      lines.push(this._renderStatus(width, ` ${formatK(input)} / ${limit > 0 ? formatK(limit) : '?'} tokens  (${pct}%)  Refreshes each LLM call`));
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }

  private _renderHdr(width: number, text: string): Line {
    const cells: Line = [];
    for (const ch of text.slice(0, width)) {
      cells.push(createStyledCell(ch, { fg: C.headerFg, bg: C.headerBg, bold: true }));
    }
    while (cells.length < width) cells.push(createStyledCell(' ', { fg: '', bg: C.headerBg }));
    return cells.slice(0, width);
  }

  private _renderStatus(width: number, text: string): Line {
    const cells: Line = [];
    for (const ch of text.slice(0, width)) {
      cells.push(createStyledCell(ch, { fg: C.statusFg, bg: C.statusBar }));
    }
    while (cells.length < width) cells.push(createStyledCell(' ', { fg: '', bg: C.statusBar }));
    return cells.slice(0, width);
  }

  private _renderBar(width: number, barWidth: number, input: number, limit: number): Line {
    const cells: Line = [];
    cells.push(createStyledCell(' ', { fg: '', bg: '' }));

    const filled = limit > 0 ? Math.min(barWidth, Math.round((input / limit) * barWidth)) : 0;
    const overLimit = limit > 0 && input > limit;
    const barFg = overLimit ? C.overFg : C.convFg;

    for (let i = 0; i < filled; i++) {
      cells.push(createStyledCell('\u2588', { fg: barFg, bg: '' }));
    }
    // Empty remainder
    let empty = filled;
    while (empty < barWidth) {
      cells.push(createStyledCell('\u2591', { fg: C.barEmpty, bg: '' }));
      empty++;
    }

    cells.push(createStyledCell(' ', { fg: '', bg: '' }));
    return cells.slice(0, width);
  }

  private _renderSegLine(width: number, label: string, val: number, pct: number, fg: string): Line {
    const cells: Line = [];
    const labelPadded = `  ${label}`.padEnd(22);
    const valStr = formatK(val).padStart(7);
    const pctStr = `${pct}%`.padStart(5);
    const line = `${labelPadded}${valStr}  ${pctStr}`;
    for (const ch of line.slice(0, width)) {
      const isFg = cells.length >= 2 && cells.length < 2 + 22; // label column dim
      cells.push(createStyledCell(ch, { fg: isFg ? C.labelFg : fg, bg: '' }));
    }
    while (cells.length < width) cells.push(createStyledCell(' ', { fg: '', bg: '' }));
    return cells.slice(0, width);
  }

  private _refresh(): void {
    const usage = this.getUsage?.();
    if (usage) {
      this.snapshot.input = usage.input;
      this.snapshot.limit = this.contextLimit ?? 0;
    }
    this.markDirty();
  }

  private _attachBus(): void {
    if (this.unsubs.length > 0) return;
    this.unsubs.push(this.bus.on('turn:complete', () => {
      this._refresh();
    }));
    this.unsubs.push(this.bus.on('turn:start', () => {
      this._refresh();
    }));
  }

  private _detachBus(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }
}
