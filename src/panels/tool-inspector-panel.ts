// ---------------------------------------------------------------------------
// ToolInspectorPanel — chronological list of tool calls with args/results.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { EventBus } from '../core/event-bus.ts';

const C = {
  headerBg:    '#1a1a2e',
  headerFg:    '#ffffff',
  statusBar:   '#222233',
  statusFg:    '#aaaaaa',
  toolFg:      '#00ccff',
  resultFg:    '#66ddff',
  errorFg:     '#ff6666',
  durationFg:  '#aaaa66',
  argsFg:      '#aaaaaa',
  dimFg:       '#555566',
  selected:    '#00ffff',
  selectedBg:  '#1a2a3a',
  labelFg:     '#8888bb',
  filterFg:    '#ffcc44',
} as const;

const MAX_ENTRIES = 500;

interface ToolCallRecord {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  startMs: number;
  endMs?: number;
  result?: unknown;
  error?: string;
  expanded: boolean;
}

type FilterMode = 'all' | string;

type FlatRow =
  | { kind: 'call'; recordIndex: number; text: string }
  | { kind: 'detail'; text: string; isError: boolean };

function shortTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function truncateJson(val: unknown, maxLen = 120): string {
  const s = JSON.stringify(val) ?? 'null';
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '\u2026' : s;
}

export class ToolInspectorPanel extends BasePanel {
  private records: ToolCallRecord[] = [];
  private filterMode: FilterMode = 'all';
  private unsubs: Array<() => void> = [];
  private cursorIndex = 0;
  private scrollOffset = 0;
  private autoScroll = true;
  private _flatCache: FlatRow[] | null = null;

  constructor(private bus: EventBus) {
    super('tools', 'Tools', 'X', 'ai');
  }

  override onActivate(): void {
    this.needsRender = true;
    this._attachBus();
  }

  override onDeactivate(): void {
    this._detachBus();
  }

  override onDestroy(): void {
    this._detachBus();
  }

  override markDirty(): void {
    this._flatCache = null;
    super.markDirty();
  }

  handleInput(key: string): boolean {
    switch (key) {
      case 'up':       this._move(-1);           this.autoScroll = false; return true;
      case 'down':     this._move(1);            return true;
      case 'pageup':   this._move(-10);          this.autoScroll = false; return true;
      case 'pagedown': this._move(10);           return true;
      case 'return':   this._toggleExpand();     return true;
      case 'c':        this.records = []; this.markDirty(); return true;
      case 'g':        this.autoScroll = true;   this.markDirty(); return true;
      case 'f':        this._cycleFilter();      return true;
      default:         return false;
    }
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    if (height <= 0 || width <= 0) return lines;

    const running = this.records.filter(r => r.endMs === undefined).length;
    const filterLabel = this.filterMode === 'all' ? '' : ` [${this.filterMode}]`;
    const title = ` Tools [${this.records.length} calls${running > 0 ? `, ${running} running` : ''}]${filterLabel}`;
    lines.push(this._renderHdr(width, title));
    if (height <= 1) return lines.slice(0, height);

    const hint = ` \u2191\u2193: scroll  Enter: expand  f: filter  c: clear  g: end`;
    lines.push(this._renderStatus(width, hint));
    if (height <= 2) return lines.slice(0, height);

    const flat = this._getFlat();
    const listHeight = height - 2;

    if (this.autoScroll) {
      this.scrollOffset = Math.max(0, flat.length - listHeight);
      this.cursorIndex = Math.max(0, flat.length - 1);
    }

    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, Math.max(0, flat.length - 1)));
    if (this.cursorIndex < this.scrollOffset) this.scrollOffset = this.cursorIndex;
    if (this.cursorIndex >= this.scrollOffset + listHeight) this.scrollOffset = this.cursorIndex - listHeight + 1;

    if (flat.length === 0) {
      lines.push(this._renderDim(width, ' No tool calls yet.'));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    const visible = flat.slice(this.scrollOffset, this.scrollOffset + listHeight);
    for (let i = 0; i < visible.length; i++) {
      const row = visible[i]!;
      const absIdx = this.scrollOffset + i;
      const isCursor = absIdx === this.cursorIndex;
      lines.push(this._renderRow(width, row, isCursor));
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

  private _renderDim(width: number, text: string): Line {
    const cells: Line = [];
    for (const ch of text.slice(0, width)) {
      cells.push(createStyledCell(ch, { fg: C.dimFg, bg: '' }));
    }
    while (cells.length < width) cells.push(createStyledCell(' ', { fg: '', bg: '' }));
    return cells.slice(0, width);
  }

  private _renderRow(width: number, row: FlatRow, isCursor: boolean): Line {
    const bg = isCursor ? C.selectedBg : '';
    const cells: Line = [];
    if (row.kind === 'call') {
      cells.push(createStyledCell(isCursor ? '>' : ' ', { fg: C.selected, bg, bold: isCursor }));
      const text = row.text.slice(0, width - 1);
      for (const ch of text) {
        cells.push(createStyledCell(ch, { fg: isCursor ? C.selected : C.toolFg, bg, bold: isCursor }));
      }
    } else {
      cells.push(createStyledCell(' ', { fg: '', bg }));
      cells.push(createStyledCell(' ', { fg: '', bg }));
      const text = row.text.slice(0, width - 2);
      for (const ch of text) {
        cells.push(createStyledCell(ch, { fg: row.isError ? C.errorFg : C.argsFg, bg }));
      }
    }
    while (cells.length < width) cells.push(createStyledCell(' ', { fg: '', bg }));
    return cells.slice(0, width);
  }

  private _getFlat(): FlatRow[] {
    if (this._flatCache) return this._flatCache;
    const flat: FlatRow[] = [];
    const filtered = this.filterMode === 'all'
      ? this.records
      : this.records.filter(r => r.tool === this.filterMode);

    for (let i = 0; i < filtered.length; i++) {
      const rec = filtered[i]!;
      const dur = rec.endMs !== undefined ? ` (${formatMs(rec.endMs - rec.startMs)})` : ' (running)';
      const expand = rec.expanded ? ' [-]' : ' [+]';
      const ts = shortTime(rec.startMs);
      const callText = `${ts} ${rec.tool}${dur}${expand}`;
      flat.push({ kind: 'call', recordIndex: i, text: callText });

      if (rec.expanded) {
        const argsStr = truncateJson(rec.args, 200);
        flat.push({ kind: 'detail', text: `Args: ${argsStr}`, isError: false });
        if (rec.result !== undefined) {
          flat.push({ kind: 'detail', text: `Result: ${truncateJson(rec.result, 200)}`, isError: false });
        }
        if (rec.error) {
          flat.push({ kind: 'detail', text: `Error: ${rec.error}`, isError: true });
        }
      }
    }
    this._flatCache = flat;
    return flat;
  }

  private _toggleExpand(): void {
    const flat = this._getFlat();
    const row = flat[this.cursorIndex];
    if (!row || row.kind !== 'call') return;
    const rec = this.records.filter(r =>
      this.filterMode === 'all' ? true : r.tool === this.filterMode
    )[row.recordIndex];
    if (rec) {
      rec.expanded = !rec.expanded;
      this.markDirty();
    }
  }

  private _cycleFilter(): void {
    const tools = [...new Set(this.records.map(r => r.tool))];
    if (tools.length === 0) return;
    if (this.filterMode === 'all') {
      this.filterMode = tools[0]!;
    } else {
      const idx = tools.indexOf(this.filterMode);
      this.filterMode = idx >= tools.length - 1 ? 'all' : tools[idx + 1]!;
    }
    this.markDirty();
  }

  private _move(delta: number): void {
    const flat = this._getFlat();
    if (flat.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(flat.length - 1, this.cursorIndex + delta));
    this.markDirty();
  }

  private _attachBus(): void {
    if (this.unsubs.length > 0) return;

    this.unsubs.push(this.bus.on('turn:tool-executing', (data) => {
      if (this.records.length >= MAX_ENTRIES) {
        this.records.shift();
      }
      this.records.push({
        callId: data.callId,
        tool: data.tool,
        args: data.args,
        startMs: Date.now(),
        expanded: false,
      });
      this.autoScroll = true;
      this.markDirty();
    }));

    this.unsubs.push(this.bus.on('turn:tool-result', (data) => {
      const rec = this.records.findLast(r => r.callId === data.callId);
      if (rec) {
        rec.endMs = Date.now();
        rec.result = data.result;
      }
      this.markDirty();
    }));

    this.unsubs.push(this.bus.on('turn:error', (data) => {
      // Mark any running calls as errored
      for (const rec of this.records) {
        if (rec.endMs === undefined) {
          rec.endMs = Date.now();
          rec.error = data.error?.message ?? 'unknown error';
        }
      }
      this.markDirty();
    }));
  }

  private _detachBus(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }
}
