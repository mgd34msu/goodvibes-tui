/**
 * PanelListPanel — Shows all registered panels grouped by category.
 *
 * Features:
 * - Arrow keys to navigate, Enter to open the selected panel
 * - Open/closed indicator (● open, ○ closed)
 * - Search/filter by typing
 * - Grouped by category
 *
 * Open via /panel list.
 */
import type { Line, Cell } from '../types/grid.ts';
import type { PanelCategory, PanelRegistration } from './types.ts';
import { BasePanel } from './base-panel.ts';
import { getPanelManager } from './panel-manager.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  header:      '#94a3b8',
  headerBg:    '#1e293b',
  category:    '#64748b',
  categoryBg:  '#1e293b',
  icon:        '#38bdf8',
  name:        '#e2e8f0',
  desc:        '#64748b',
  openDot:     '#22c55e',
  closedDot:   '#475569',
  selected:    '#e2e8f0',
  selectedBg:  '#1e3a5f',
  selIcon:     '#38bdf8',
  hint:        '#475569',
  search:      '#f97316',
  searchBg:    '#1e293b',
  dim:         '#334155',
} as const;

const CATEGORY_ORDER: PanelCategory[] = ['development', 'agent', 'monitoring', 'session', 'ai'];
const CATEGORY_LABELS: Record<PanelCategory, string> = {
  development: 'Development',
  agent:       'Agent',
  monitoring:  'Monitoring',
  session:     'Session',
  ai:          'AI',
};

// ── Layout constants ──────────────────────────────────────────────────────────
const NAME_COL_WIDTH = 22;
const PREFIX_WIDTH = 4; // arrow + dot + space + space

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a Line from [text, fg, bg?] segments, one Cell per character, padded to width. */
function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  for (const [text, fg, bg] of segments) {
    const style = { fg, bg: bg ?? '' };
    for (const ch of text) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, style));
    }
  }
  while (cells.length < width) {
    cells.push(createStyledCell(' ', { fg: '' }));
  }
  return cells;
}

/** A flat entry in the navigable list — either a category header or a panel row. */
type ListEntry =
  | { kind: 'header'; category: PanelCategory }
  | { kind: 'panel'; reg: PanelRegistration };

// ── PanelListPanel ────────────────────────────────────────────────────────────

export class PanelListPanel extends BasePanel {
  private _selectedIndex  = 0;
  private _scrollOffset   = 0;
  private _query          = '';
  private _cachedEntries: ListEntry[] | null = null;
  private _entriesDirty   = true;

  public constructor() {
    super('panel-list', 'Panel List', 'L', 'session');
  }

  public override onActivate(): void {
    super.onActivate();
    this._selectedIndex  = 0;
    this._scrollOffset   = 0;
    this._query          = '';
    this._entriesDirty   = true;
  }

  protected override markDirty(): void {
    super.markDirty();
    this._entriesDirty = true;
  }

  public handleInput(key: string): boolean {
    const entries = this._buildEntries();

    // Navigation
    if (key === 'up' || key === 'k') {
      this._movePrevPanel();
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this._moveNextPanel(entries);
      this.markDirty();
      return true;
    }

    // Open selected panel
    if (key === 'return' || key === 'enter') {
      const selectedPanel = this._getSelectedPanelEntry(entries);
      if (selectedPanel) {
        try {
          getPanelManager().open(selectedPanel.reg.id);
        } catch (err) {
          console.debug('[panel-list] failed to open panel:', err);
        }
        this.markDirty();
      }
      return true;
    }

    // Search: backspace
    if (key === 'backspace' || key === 'delete') {
      if (this._query.length > 0) {
        this._query = this._query.slice(0, -1);
        this._clampSelection(entries);
        this.markDirty();
        return true;
      }
      return false;
    }

    // Escape: clear search
    if (key === 'escape') {
      if (this._query.length > 0) {
        this._query = '';
        this._clampSelection(entries);
        this.markDirty();
        return true;
      }
      return false;
    }

    // Printable character: append to search query
    if (key.length === 1 && key >= ' ') {
      this._query += key;
      this._selectedIndex = 0;
      this._scrollOffset  = 0;
      this.markDirty();
      return true;
    }

    return false;
  }

  public render(width: number, height: number): Line[] {
    if (!this.canRenderNow()) {
      return Array.from({ length: height }, () => createEmptyLine(width));
    }
    const start = Date.now();
    this.needsRender = false;
    const lines: Line[] = [];

    // Panel header
    const titleText = ' Panel List';
    const pad = Math.max(0, width - titleText.length);
    lines.push(buildLine(width, [[titleText + ' '.repeat(pad), C.header, C.headerBg]]));

    // Search bar
    const searchLabel = ' Filter: ';
    const searchValue = this._query || '';
    const cursor = '▊';
    lines.push(buildLine(width, [
      [searchLabel,              C.hint, C.searchBg],
      [searchValue + cursor,     C.search, C.searchBg],
      [' '.repeat(Math.max(0, width - searchLabel.length - searchValue.length - 1)), C.dim, C.searchBg],
    ]));

    const headerCount = 2; // title + search bar
    const bodyHeight = Math.max(1, height - headerCount - 1); // -1 for hint line

    const entries = this._buildEntries();

    if (entries.length === 0) {
      lines.push(buildLine(width, [[' No panels match filter.', C.hint]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      this.reportRenderDuration(Date.now() - start);
      return lines;
    }

    // Clamp scroll so selected row is visible
    this._clampScroll(entries, bodyHeight);

    const visible = entries.slice(this._scrollOffset, this._scrollOffset + bodyHeight);
    const openIds = new Set(getPanelManager().getAllOpen().map(p => p.id));

    for (const entry of visible) {
      if (entry.kind === 'header') {
        const label = ` ── ${CATEGORY_LABELS[entry.category]} ${'─'.repeat(Math.max(0, width - 6 - CATEGORY_LABELS[entry.category].length))}`;
        lines.push(buildLine(width, [[label.slice(0, width), C.category, C.categoryBg]]));
      } else {
        const flatIdx = this._flatPanelIndex(entries, entry.reg.id);
        const isSelected = flatIdx === this._selectedIndex;
        const isOpen = openIds.has(entry.reg.id);
        const bg = isSelected ? C.selectedBg : '';
        const dot = isOpen ? '●' : '○';
        const dotColor = isOpen ? C.openDot : C.closedDot;
        const arrow = isSelected ? '▶' : ' ';
        const nameColor = isSelected ? C.selected : C.name;
        const nameStr = entry.reg.name.padEnd(NAME_COL_WIDTH, ' ').slice(0, NAME_COL_WIDTH);
        const descMax = Math.max(0, width - PREFIX_WIDTH - NAME_COL_WIDTH - 1);
        const desc = entry.reg.description.slice(0, descMax);

        lines.push(buildLine(width, [
          [arrow,            C.selIcon, bg],
          [dot,              dotColor,  bg],
          [' ',              '',        bg],
          [nameStr + ' ',    nameColor, bg],
          [desc,             C.desc,    bg],
        ]));
      }
    }

    // Hint line
    const panelEntries = entries.filter(e => e.kind === 'panel');
    const hintText = ` [${this._selectedIndex + 1}/${panelEntries.length}] ↑/↓ nav  Enter open  type to filter`;
    while (lines.length < height - 1) lines.push(createEmptyLine(width));
    lines.push(buildLine(width, [[hintText.slice(0, width), C.hint]]));

    while (lines.length < height) lines.push(createEmptyLine(width));
    this.reportRenderDuration(Date.now() - start);
    return lines;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Build flat list of entries (headers + panel rows) filtered by query. */
  private _buildEntries(): ListEntry[] {
    if (this._cachedEntries !== null && !this._entriesDirty) {
      return this._cachedEntries;
    }

    const manager = getPanelManager();
    const byCategory = manager.getTypesByCategory();
    const q = this._query.toLowerCase();
    const entries: ListEntry[] = [];

    for (const cat of CATEGORY_ORDER) {
      const regs = byCategory.get(cat) ?? [];
      const filtered = q
        ? regs.filter(r =>
            r.id.toLowerCase().includes(q) ||
            r.name.toLowerCase().includes(q) ||
            r.description.toLowerCase().includes(q) ||
            r.category.toLowerCase().includes(q)
          )
        : regs;

      if (filtered.length === 0) continue;

      entries.push({ kind: 'header', category: cat });
      for (const reg of filtered) {
        entries.push({ kind: 'panel', reg });
      }
    }

    this._cachedEntries = entries;
    this._entriesDirty = false;
    return entries;
  }

  /** Get the flat panel index (counting only panel entries) for a given panel id. */
  private _flatPanelIndex(entries: ListEntry[], id: string): number {
    let idx = 0;
    for (const e of entries) {
      if (e.kind !== 'panel') continue;
      if (e.reg.id === id) return idx;
      idx++;
    }
    return -1;
  }

  /** Get the ListEntry for the currently selected panel. */
  private _getSelectedPanelEntry(entries: ListEntry[]): Extract<ListEntry, { kind: 'panel' }> | null {
    let idx = 0;
    for (const e of entries) {
      if (e.kind !== 'panel') continue;
      if (idx === this._selectedIndex) return e;
      idx++;
    }
    return null;
  }

  /** Move selection to the previous panel entry. */
  private _movePrevPanel(): void {
    this._selectedIndex = Math.max(0, this._selectedIndex - 1);
  }

  /** Move selection to the next panel entry. */
  private _moveNextPanel(entries: ListEntry[]): void {
    const panelCount = entries.filter(e => e.kind === 'panel').length;
    this._selectedIndex = Math.min(panelCount - 1, this._selectedIndex + 1);
  }

  /** Clamp selectedIndex within available panels. */
  private _clampSelection(entries: ListEntry[]): void {
    const panelCount = entries.filter(e => e.kind === 'panel').length;
    this._selectedIndex = Math.max(0, Math.min(this._selectedIndex, panelCount - 1));
  }

  /**
   * Adjust _scrollOffset so that the entry containing the selected panel
   * is within the visible window.
   */
  private _clampScroll(entries: ListEntry[], bodyHeight: number): void {
    // Find the flat (entries) index of the selected panel entry
    let panelsSeen = 0;
    let entryIdx = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.kind === 'panel') {
        if (panelsSeen === this._selectedIndex) {
          entryIdx = i;
          break;
        }
        panelsSeen++;
      }
    }

    const maxScroll = Math.max(0, entries.length - bodyHeight);
    if (entryIdx < this._scrollOffset) {
      this._scrollOffset = entryIdx;
    } else if (entryIdx >= this._scrollOffset + bodyHeight) {
      this._scrollOffset = entryIdx - bodyHeight + 1;
    }
    this._scrollOffset = Math.min(this._scrollOffset, maxScroll);
  }
}
