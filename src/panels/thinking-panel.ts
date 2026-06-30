// ---------------------------------------------------------------------------
// ThinkingPanel — streams model reasoning tokens in real-time.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { TurnEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  extendPalette,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  // Domain-specific reasoning tones (purples) and the active-stream cyan have no
  // clean shared equivalent; selection background maps to the shared selectBg.
  reasoningFg: '#aa88ff',
  activeFg:    '#cc99ff',
  turnLabel:   '#7766bb',
  activeLabel: '#00ffff',
});

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

  constructor(private readonly turnEvents: UiEventFeed<TurnEvent>) {
    super('thinking', 'Thinking', 'T', 'ai');
    this._attachBus();
  }

  override onActivate(): void {
    this.needsRender = true;
  }

  override onDeactivate(): void {
    super.onDeactivate();
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
    if (height <= 0 || width <= 0) return [];
    this.lastWidth = width;

    const hasActive = this.blocks.some(b => b.active);
    const flat = this._buildFlat(width);
    const title = hasActive ? ' Thinking [streaming]' : ` Thinking [${this.blocks.length} blocks]`;
    const footerLines = [
      buildPanelLine(width, [
        [' Up/Down', DEFAULT_PANEL_PALETTE.info],
        [' scroll', DEFAULT_PANEL_PALETTE.dim],
        ['   Enter', DEFAULT_PANEL_PALETTE.info],
        [' collapse', DEFAULT_PANEL_PALETTE.dim],
        ['   g', DEFAULT_PANEL_PALETTE.info],
        [' jump to end', DEFAULT_PANEL_PALETTE.dim],
        [this.autoScroll ? '   auto-scroll ON' : '   manual', this.autoScroll ? DEFAULT_PANEL_PALETTE.good : DEFAULT_PANEL_PALETTE.warn],
      ]),
    ];

    if (flat.length === 0) {
      return buildPanelWorkspace(width, height, {
        title,
        intro: 'Live reasoning blocks stream here while the model is actively thinking.',
        sections: [
          {
            title: 'Reasoning',
            lines: buildEmptyState(
              width,
              ' No reasoning content yet',
              'When the model emits thinking or reasoning deltas, they accumulate here in expandable blocks.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        footerLines,
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    if (this.autoScroll) {
      this.cursorIndex = Math.max(0, flat.length - 1);
    }

    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, Math.max(0, flat.length - 1)));

    const summary: PanelWorkspaceSection = {
      title: 'Summary',
      lines: [
        buildPanelLine(width, [
          [' Blocks ', DEFAULT_PANEL_PALETTE.label],
          [String(this.blocks.length), DEFAULT_PANEL_PALETTE.value],
          ['   Active ', DEFAULT_PANEL_PALETTE.label],
          [String(this.blocks.filter((block) => block.active).length), hasActive ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
          ['   Mode ', DEFAULT_PANEL_PALETTE.label],
          [this.autoScroll ? 'auto-scroll' : 'manual', this.autoScroll ? DEFAULT_PANEL_PALETTE.good : DEFAULT_PANEL_PALETTE.info],
        ]),
      ],
    };

    const selectedRow = flat[this.cursorIndex];
    const selectedSection: PanelWorkspaceSection = {
      title: 'Selected',
      lines: [
        buildPanelLine(width, [[' Row Type ', DEFAULT_PANEL_PALETTE.label], [selectedRow?.kind ?? 'none', DEFAULT_PANEL_PALETTE.value]]),
      ],
    };

    const reasoningSection = resolveScrollablePanelSection(width, height, {
      intro: 'Live reasoning blocks stream here while the model is actively thinking.',
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summary],
      section: {
        title: 'Reasoning',
        scrollableLines: flat.map((row, index) => this._renderRow(width, row, index === this.cursorIndex)),
        selectedIndex: this.cursorIndex,
        scrollOffset: this.scrollOffset,
        minRows: 8,
      },
      afterSections: [selectedSection],
    });
    this.scrollOffset = reasoningSection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title,
      intro: 'Live reasoning blocks stream here while the model is actively thinking.',
      sections: [
        summary,
        reasoningSection.section,
        selectedSection,
      ],
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  private _renderRow(width: number, row: FlatRow, isCursor: boolean): Line {
    const bg = isCursor ? C.selectBg : '';
    if (row.kind === 'header') {
      const indicator = this.blocks[row.blockIndex]?.collapsed ? '▸' : '▾';
      const active = this.blocks[row.blockIndex]?.active;
      const bullet = active ? '\u25cf ' : '\u25e6 ';
      return buildStyledPanelLine(width, [
        { text: truncateDisplay(` ${bullet}${row.text} ${indicator}`, width), fg: active ? C.activeLabel : C.turnLabel, bg, bold: true },
      ]);
    }
    return buildStyledPanelLine(width, [
      { text: '  ', fg: C.reasoningFg, bg },
      { text: truncateDisplay(row.text, Math.max(0, width - 2)), fg: isCursor ? C.activeFg : C.reasoningFg, bg },
    ]);
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

    this.unsubs.push(this.turnEvents.on('STREAM_START', () => {
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

    this.unsubs.push(this.turnEvents.on('STREAM_DELTA', (env) => {
      const reasoning = env.reasoning;
      if (reasoning && currentBlock) {
        currentBlock.content += reasoning;
        this.autoScroll = true;
        this.markDirty();
      }
    }));

    this.unsubs.push(this.turnEvents.on('STREAM_END', () => {
      if (currentBlock) {
        currentBlock.active = false;
        currentBlock = null;
        this.markDirty();
      }
    }));

    this.unsubs.push(this.turnEvents.on('TURN_COMPLETED', () => {
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
