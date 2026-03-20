// ---------------------------------------------------------------------------
// ThinkingPanel — streams model reasoning tokens in real-time.
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
  reasoningFg: '#aa88ff',
  activeFg:    '#cc99ff',
  dimFg:       '#555566',
  turnLabel:   '#7766bb',
  activeLabel: '#00ffff',
  collapsedFg: '#888899',
  selected:    '#00ffff',
  selectedBg:  '#1a2a3a',
} as const;

interface ReasoningBlock {
  turnId: number;
  content: string;
  active: boolean;  // true = currently streaming
  collapsed: boolean;
}

function wrapLines(text: string, width: number): string[] {
  const result: string[] = [];
  const raw = text.split('\n');
  for (const line of raw) {
    if (line.length <= width) {
      result.push(line);
    } else {
      let start = 0;
      while (start < line.length) {
        result.push(line.slice(start, start + width));
        start += width;
      }
    }
  }
  return result;
}

type FlatRow = { kind: 'header'; blockIndex: number; text: string } | { kind: 'content'; text: string };

export class ThinkingPanel extends BasePanel {
  private blocks: ReasoningBlock[] = [];
  private nextTurnId = 1;
  private unsubs: Array<() => void> = [];
  private cursorIndex = 0;
  private scrollOffset = 0;
  private autoScroll = true;
  private lastWidth = 80;
  private static readonly MAX_BLOCKS = 100;

  constructor(private bus: EventBus) {
    super('thinking', 'Thinking', 'T', 'ai');
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

  handleInput(key: string): boolean {
    switch (key) {
      case 'up':       this._move(-1);         this.autoScroll = false; return true;
      case 'down':     this._move(1);          return true;
      case 'pageup':   this._move(-10);        this.autoScroll = false; return true;
      case 'pagedown': this._move(10);         return true;
      case 'return':   this._toggleCollapse(); return true;
      case 'g':        this.autoScroll = true; this.markDirty(); return true;
      default:         return false;
    }
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    if (height <= 0 || width <= 0) return lines;
    this.lastWidth = width;

    const hasActive = this.blocks.some(b => b.active);
    const title = hasActive ? ' Thinking  \u25cf streaming...' : ` Thinking [${this.blocks.length} blocks]`;
    lines.push(this._renderHdr(width, title, hasActive));
    if (height <= 1) return lines.slice(0, height);

    const flat = this._buildFlat(width);
    const listHeight = height - 2;

    if (this.autoScroll) {
      this.scrollOffset = Math.max(0, flat.length - listHeight);
      this.cursorIndex = Math.max(0, flat.length - 1);
    }

    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, Math.max(0, flat.length - 1)));
    if (this.cursorIndex < this.scrollOffset) this.scrollOffset = this.cursorIndex;
    if (this.cursorIndex >= this.scrollOffset + listHeight) this.scrollOffset = this.cursorIndex - listHeight + 1;

    const visible = flat.slice(this.scrollOffset, this.scrollOffset + listHeight);
    for (let i = 0; i < visible.length; i++) {
      const row = visible[i]!;
      const absIdx = this.scrollOffset + i;
      const isCursor = absIdx === this.cursorIndex;
      lines.push(this._renderRow(width, row, isCursor));
    }

    if (flat.length === 0) {
      lines.push(this._renderDim(width, ' No reasoning content yet. Model will populate this when thinking.'));
    }

    while (lines.length < height - 1) lines.push(createEmptyLine(width));
    // Status bar
    const hint = ` \u2191\u2193: scroll  Enter: collapse  g: jump to end  ${this.autoScroll ? '[auto-scroll ON]' : '[manual]'}`;
    lines.push(this._renderStatus(width, hint));

    return lines.slice(0, height);
  }

  private _renderHdr(width: number, text: string, active: boolean): Line {
    const cells: Line = [];
    const truncated = text.slice(0, width);
    for (const ch of truncated) {
      cells.push(createStyledCell(ch, { fg: active ? C.activeLabel : C.headerFg, bg: C.headerBg, bold: true }));
    }
    while (cells.length < width) cells.push(createStyledCell(' ', { fg: '', bg: C.headerBg }));
    return cells.slice(0, width);
  }

  private _renderStatus(width: number, text: string): Line {
    const cells: Line = [];
    const truncated = text.slice(0, width);
    for (const ch of truncated) {
      cells.push(createStyledCell(ch, { fg: C.statusFg, bg: C.statusBar }));
    }
    while (cells.length < width) cells.push(createStyledCell(' ', { fg: '', bg: C.statusBar }));
    return cells.slice(0, width);
  }

  private _renderDim(width: number, text: string): Line {
    const cells: Line = [];
    const truncated = text.slice(0, width);
    for (const ch of truncated) {
      cells.push(createStyledCell(ch, { fg: C.dimFg, bg: '' }));
    }
    while (cells.length < width) cells.push(createStyledCell(' ', { fg: '', bg: '' }));
    return cells.slice(0, width);
  }

  private _renderRow(width: number, row: FlatRow, isCursor: boolean): Line {
    const bg = isCursor ? C.selectedBg : '';
    const cells: Line = [];
    if (row.kind === 'header') {
      const indicator = this.blocks[row.blockIndex]?.collapsed ? '[+]' : '[-]';
      const active = this.blocks[row.blockIndex]?.active;
      const bullet = active ? '\u25cf ' : '\u25e6 ';
      const text = ` ${bullet}${row.text} ${indicator}`;
      for (const ch of text.slice(0, width)) {
        cells.push(createStyledCell(ch, { fg: active ? C.activeLabel : C.turnLabel, bg, bold: true }));
      }
    } else {
      cells.push(createStyledCell(' ', { fg: '', bg }));
      cells.push(createStyledCell(' ', { fg: '', bg }));
      const text = row.text.slice(0, width - 2);
      for (const ch of text) {
        cells.push(createStyledCell(ch, { fg: isCursor ? C.activeFg : C.reasoningFg, bg }));
      }
    }
    while (cells.length < width) cells.push(createStyledCell(' ', { fg: '', bg }));
    return cells.slice(0, width);
  }

  private _buildFlat(width: number): FlatRow[] {
    const rows: FlatRow[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]!;
      const turnLabel = `Turn ${block.turnId}${block.active ? ' (streaming)' : ''}`;
      rows.push({ kind: 'header', blockIndex: i, text: turnLabel });
      if (!block.collapsed) {
        const wrapped = wrapLines(block.content || '(empty)', Math.max(1, width - 2));
        for (const line of wrapped) {
          rows.push({ kind: 'content', text: line });
        }
      }
    }
    return rows;
  }

  private _toggleCollapse(): void {
    // Find the header row at or before cursorIndex
    const flat = this._buildFlat(this.lastWidth);
    for (let i = this.cursorIndex; i >= 0; i--) {
      const row = flat[i];
      if (row?.kind === 'header') {
        const block = this.blocks[row.blockIndex];
        if (block) {
          block.collapsed = !block.collapsed;
          this.markDirty();
          return;
        }
      }
    }
  }

  private _move(delta: number): void {
    const flat = this._buildFlat(this.lastWidth);
    if (flat.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(flat.length - 1, this.cursorIndex + delta));
    this.markDirty();
  }

  private _attachBus(): void {
    if (this.unsubs.length > 0) return;

    let currentBlock: ReasoningBlock | null = null;

    this.unsubs.push(this.bus.on('turn:stream-start', () => {
      const block: ReasoningBlock = {
        turnId: this.nextTurnId++,
        content: '',
        active: true,
        collapsed: false,
      };
      // Cap block count to prevent unbounded growth
      if (this.blocks.length >= ThinkingPanel.MAX_BLOCKS) {
        this.blocks.shift();
      }
      this.blocks.push(block);
      currentBlock = block;
      this.autoScroll = true;
      this.markDirty();
    }));

    this.unsubs.push(this.bus.on('turn:stream-delta', (data) => {
      const reasoning = data?.reasoning;
      if (reasoning && currentBlock) {
        currentBlock.content += reasoning;
        this.autoScroll = true;
        this.markDirty();
      }
    }));

    this.unsubs.push(this.bus.on('turn:stream-end', () => {
      if (currentBlock) {
        currentBlock.active = false;
        currentBlock = null;
        this.markDirty();
      }
    }));

    this.unsubs.push(this.bus.on('turn:complete', () => {
      if (currentBlock) {
        currentBlock.active = false;
        currentBlock = null;
        this.markDirty();
      }
    }));
  }

  private _detachBus(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }
}
