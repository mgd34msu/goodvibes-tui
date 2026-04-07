// ---------------------------------------------------------------------------
// DocsPanel — tool list, model capabilities, and keyboard shortcut reference.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { buildPanelLine, buildPanelWorkspace, buildSearchInputLine, DEFAULT_PANEL_PALETTE } from './polish.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';

const C = {
  headerBg:   '#1a1a2e',
  headerFg:   '#ffffff',
  statusBar:  '#222233',
  statusFg:   '#aaaaaa',
  sectionFg:  '#00ffff',
  sectionBg:  '#0d1a2a',
  toolFg:     '#88ccff',
  descFg:     '#aaaaaa',
  keyFg:      '#ffcc44',
  valueFg:    '#ccccdd',
  dimFg:      '#555566',
  selected:   '#00ffff',
  selectedBg: '#1a2a3a',
  searchFg:   '#ffffff',
} as const;

// ---------------------------------------------------------------------------
// Hardcoded keyboard shortcut reference
// ---------------------------------------------------------------------------
const SHORTCUTS: Array<{ key: string; desc: string }> = [
  { key: 'Ctrl+C',      desc: 'Cancel generation / exit (double)' },
  { key: 'Ctrl+P',      desc: 'Open panel picker' },
  { key: 'Ctrl+F',      desc: 'Search conversation' },
  { key: 'Ctrl+K',      desc: 'Copy last response to clipboard' },
  { key: 'Ctrl+L',      desc: 'Clear screen' },
  { key: 'Ctrl+Z',      desc: 'Undo input' },
  { key: 'Alt+Enter',   desc: 'Insert newline in prompt' },
  { key: 'PageUp/Down', desc: 'Scroll conversation' },
  { key: 'Alt+PgUp/Dn', desc: 'Scroll panel' },
  { key: 'Tab',         desc: 'Path completion / tab panels' },
  { key: '/',           desc: 'Start slash command' },
  { key: 'Enter',       desc: 'Submit prompt' },
  { key: 'Esc',         desc: 'Close overlay / cancel search' },
  { key: 'Up/Down',      desc: 'Scroll history / navigate list' },
  { key: 'Alt+Up/Down',  desc: 'Move cursor in multi-line input' },
  { key: 'Ctrl+A/E',    desc: 'Jump to start/end of line' },
  { key: 'Ctrl+W',      desc: 'Delete word backward' },
  { key: 'Ctrl+U',      desc: 'Clear line' },
  { key: 'F1',          desc: 'Toggle help overlay' },
  { key: 'F2',          desc: 'Toggle shortcuts overlay' },
];

type DocSection = 'tools' | 'models' | 'shortcuts';

interface FlatRow {
  kind: 'header' | 'item' | 'detail' | 'empty';
  text: string;
  fg: string;
  bg: string;
  bold?: boolean;
}

function renderRow(width: number, row: FlatRow, isCursor: boolean): Line {
  const bg = isCursor ? C.selectedBg : row.bg;
  return buildPanelLine(width, [
    [isCursor ? '>' : ' ', C.selected, bg],
    [row.text, isCursor ? C.selected : row.fg, bg],
  ]);
}

export class DocsPanel extends BasePanel {
  private toolRegistry: ToolRegistry | null = null;
  private providerRegistry: ProviderRegistry | null = null;
  private section: DocSection = 'tools';
  private searchQuery = '';
  private searching = false;
  private rows: FlatRow[] = [];
  private cursorIndex = 0;
  private scrollOffset = 0;

  constructor(toolRegistry?: ToolRegistry, providerRegistry?: ProviderRegistry) {
    super('docs', 'Docs', '?', 'session');
    this.toolRegistry = toolRegistry ?? null;
    this.providerRegistry = providerRegistry ?? null;
  }

  override onActivate(): void {
    this.needsRender = true;
    this._buildRows();
  }

  handleInput(key: string): boolean {
    if (this.searching) {
      const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.cursorIndex, itemCount: this.rows.length });
      if (transition === 'focus-list') {
        this.searching = false;
        this.cursorIndex = 0;
        this.markDirty();
        return true;
      }
      if (isPanelSearchCancel(key) || isPanelSearchCommit(key)) {
        this.searching = false;
        this._buildRows();
        return true;
      }
      if (isPanelSearchBackspace(key)) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this._buildRows();
        return true;
      }
      if (isPanelSearchPrintable(key)) {
        this.searchQuery += key;
        this._buildRows();
        return true;
      }
      return false;
    }

    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.cursorIndex, itemCount: this.rows.length });
    if (transition === 'focus-search') {
      this._startSearch();
      return true;
    }

    switch (key) {
      case 'up':       this._move(-1);         return true;
      case 'down':     this._move(1);          return true;
      case 'pageup':   this._move(-10);        return true;
      case 'pagedown': this._move(10);         return true;
      case 't':        this._setSection('tools');     return true;
      case 'm':        this._setSection('models');    return true;
      case 'k':        this._setSection('shortcuts'); return true;
      default:         return false;
    }
  }

  render(width: number, height: number): Line[] {
    if (height <= 0 || width <= 0) return [];
    const sectionLabel = this.section === 'tools' ? 'Tools' : this.section === 'models' ? 'Models' : 'Shortcuts';
    const searchLine = this.searching
      ? ` Search: ${this.searchQuery}\u258a`
      : this.searchQuery
      ? ` Filter: ${this.searchQuery}  (/ or up at top to edit)`
      : ` / or up at top to search`;
    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, Math.max(0, this.rows.length - 1)));
    const window = getTrackedVisibleWindow(this.rows.length, this.cursorIndex, Math.max(8, height - 8), this.scrollOffset, 1);
    this.scrollOffset = window.start;
    const visible = this.rows.slice(window.start, window.end);
    const sectionRows = visible.map((row, index) => {
      const absIdx = window.start + index;
      const isCursor = absIdx === this.cursorIndex && row.kind !== 'header' && row.kind !== 'empty';
      return renderRow(width, row, isCursor);
    });

    return buildPanelWorkspace(width, height, {
      title: ` Docs / ${sectionLabel}`,
      intro: 'Browse built-in tool docs, available models, and keyboard shortcuts from one shared reference surface.',
      sections: [
        {
          title: 'Controls',
          lines: [
            buildPanelLine(width, [
              [' t', DEFAULT_PANEL_PALETTE.info], [' tools', DEFAULT_PANEL_PALETTE.dim],
              ['   m', DEFAULT_PANEL_PALETTE.info], [' models', DEFAULT_PANEL_PALETTE.dim],
              ['   k', DEFAULT_PANEL_PALETTE.info], [' shortcuts', DEFAULT_PANEL_PALETTE.dim],
              ['   /', DEFAULT_PANEL_PALETTE.info], [' search', DEFAULT_PANEL_PALETTE.dim],
            ]),
            buildSearchInputLine(width, '', searchLine.trimStart(), DEFAULT_PANEL_PALETTE, { active: this.searching }),
          ],
        },
        {
          title: sectionLabel,
          lines: sectionRows.length > 0 ? sectionRows : [buildPanelLine(width, [[' No matching docs', DEFAULT_PANEL_PALETTE.dim]])],
        },
      ],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  private _setSection(section: DocSection): void {
    this.section = section;
    this.searchQuery = '';
    this.cursorIndex = 0;
    this.scrollOffset = 0;
    this._buildRows();
  }

  private _startSearch(): void {
    this.searching = true;
    this.markDirty();
  }

  private _move(delta: number): void {
    if (this.rows.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(this.rows.length - 1, this.cursorIndex + delta));
    this.markDirty();
  }

  private _buildRows(): void {
    const q = this.searchQuery.trim().toLowerCase();
    const rows: FlatRow[] = [];

    if (this.section === 'tools') {
      const tools = this.toolRegistry?.list() ?? [];
      const filtered = q ? tools.filter(t => t.definition.name.toLowerCase().includes(q) || (t.definition.description ?? '').toLowerCase().includes(q)) : tools;
      if (filtered.length === 0) {
        rows.push({ kind: 'empty', text: ' No tools match.', fg: C.dimFg, bg: '' });
      } else {
        rows.push({ kind: 'header', text: ` Tools (${filtered.length})`, fg: C.sectionFg, bg: C.sectionBg, bold: true });
        for (const tool of filtered) {
          rows.push({ kind: 'item', text: `  ${tool.definition.name}`, fg: C.toolFg, bg: '', bold: true });
          if (tool.definition.description) {
            rows.push({ kind: 'detail', text: `    ${tool.definition.description}`, fg: C.descFg, bg: '' });
          }
          const metadata: string[] = [];
          if (tool.definition.sideEffects && tool.definition.sideEffects.length > 0) {
            metadata.push(`effects: ${tool.definition.sideEffects.join(', ')}`);
          }
          if (tool.definition.concurrency) {
            metadata.push(`concurrency: ${tool.definition.concurrency}`);
          }
          if (tool.definition.supportsProgress) {
            metadata.push('progress');
          }
          if (tool.definition.supportsStreamingOutput) {
            metadata.push('streaming');
          }
          if (metadata.length > 0) {
            rows.push({ kind: 'detail', text: `    ${metadata.join('  |  ')}`, fg: C.dimFg, bg: '' });
          }
        }
      }
    } else if (this.section === 'models') {
      const models = this.providerRegistry?.listModels() ?? [];
      const filtered = q ? models.filter(m => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q)) : models;
      if (filtered.length === 0) {
        rows.push({ kind: 'empty', text: ' No models match.', fg: C.dimFg, bg: '' });
      } else {
        // Group by provider
        const byProvider = new Map<string, typeof filtered>();
        for (const m of filtered) {
          let arr = byProvider.get(m.provider);
          if (!arr) { arr = []; byProvider.set(m.provider, arr); }
          arr.push(m);
        }
        for (const [provider, pModels] of byProvider) {
          rows.push({ kind: 'header', text: ` ${provider} (${pModels.length})`, fg: C.sectionFg, bg: C.sectionBg, bold: true });
          for (const m of pModels) {
            const ctxK = m.contextWindow > 0 ? `${(m.contextWindow / 1000).toFixed(0)}k` : '?';
            const caps = [m.contextWindow > 0 ? `ctx:${ctxK}` : ''].filter(Boolean).join(' ');
            rows.push({ kind: 'item', text: `  ${m.displayName}  ${caps}`, fg: C.toolFg, bg: '' });
            rows.push({ kind: 'detail', text: `    ${m.id}`, fg: C.descFg, bg: '' });
          }
        }
      }
    } else {
      // Shortcuts
      const filtered = q ? SHORTCUTS.filter(s => s.key.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q)) : SHORTCUTS;
      rows.push({ kind: 'header', text: ' Keyboard Shortcuts', fg: C.sectionFg, bg: C.sectionBg, bold: true });
      for (const s of filtered) {
        const key = s.key.padEnd(16);
        rows.push({ kind: 'item', text: `  ${key} ${s.desc}`, fg: C.valueFg, bg: '' });
      }
    }

    this.rows = rows;
    this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, rows.length - 1));
    this.markDirty();
  }
}
