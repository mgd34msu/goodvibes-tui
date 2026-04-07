/**
 * PanelListPanel — Shows all registered panels grouped by category.
 *
 * Features:
 * - Arrow keys to navigate, Enter to open the selected panel
 * - Open/closed indicator (● open, ○ closed)
 * - Search/filter by typing
 * - Grouped by category
 * - `T` / `B` to place a panel in the top/bottom pane
 * - `M` to move an open panel to the other pane
 * - `S` to toggle the split and Tab to switch pane focus
 *
 * Open via /panel list.
 */
import type { Line, Cell } from '../types/grid.ts';
import type { PanelCategory, PanelRegistration } from './types.ts';
import { BasePanel } from './base-panel.ts';
import { getPanelManager } from './panel-manager.ts';
import { createEmptyLine } from '../types/grid.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildSearchInputLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  ...DEFAULT_PANEL_PALETTE,
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
  paneTop:     '#38bdf8',
  paneBottom:  '#a78bfa',
  intro:       '#94a3b8',
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

/** A flat entry in the navigable list — either a category header or a panel row. */
type ListEntry =
  | { kind: 'header'; category: PanelCategory }
  | { kind: 'panel'; reg: PanelRegistration };

function panelPlacementMarker(options: {
  isTopOpen: boolean;
  isBottomOpen: boolean;
  focusedPane: 'top' | 'bottom';
}): { text: string; color: string } {
  const { isTopOpen, isBottomOpen, focusedPane } = options;
  if (isTopOpen && isBottomOpen) return { text: '◆', color: C.selected };
  if (isTopOpen) return { text: focusedPane === 'top' ? '▲' : '△', color: C.paneTop };
  if (isBottomOpen) return { text: focusedPane === 'bottom' ? '▼' : '▽', color: C.paneBottom };
  return { text: ' ', color: C.dim };
}

function wrapPanelDescription(text: string, width: number, maxLines = 2): string[] {
  if (width <= 0) return [''];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length > maxLines) lines.length = maxLines;
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = truncateDisplay(lines[maxLines - 1] ?? '', width);
  }
  return lines;
}

// ── PanelListPanel ────────────────────────────────────────────────────────────

export class PanelListPanel extends BasePanel {
  private _selectedIndex  = 0;
  private _scrollOffset   = 0;
  private _query          = '';
  private _filterFocused  = false;
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
    this._filterFocused  = false;
    this._entriesDirty   = true;
  }

  protected override markDirty(): void {
    super.markDirty();
    this._entriesDirty = true;
  }

  public handleInput(key: string): boolean {
    const entries = this._buildEntries();
    const panelCount = entries.filter(e => e.kind === 'panel').length;

    if (this._filterFocused) {
      const transition = getPanelSearchFocusTransition(key, { selectedIndex: this._selectedIndex, itemCount: panelCount });
      if (transition === 'focus-list') {
        this._filterFocused = false;
        this._selectedIndex = 0;
        this._scrollOffset = 0;
        this.markDirty();
        return true;
      }
      if (isPanelSearchBackspace(key)) {
        if (this._query.length === 0) return true;
        this._query = this._query.slice(0, -1);
        this._clampSelection(entries);
        this.markDirty();
        return true;
      }
      if (isPanelSearchCancel(key)) {
        this._filterFocused = false;
        this.markDirty();
        return true;
      }
      if (isPanelSearchCommit(key)) {
        this._filterFocused = false;
        const selectedPanel = this._getSelectedPanelEntry(this._buildEntries());
        if (selectedPanel) {
          try {
            getPanelManager().open(selectedPanel.reg.id);
          } catch (err) {
            console.debug('[panel-list] failed to open panel:', err);
          }
        }
        this.markDirty();
        return true;
      }
      if (isPanelSearchPrintable(key)) {
        this._query += key;
        this._selectedIndex = 0;
        this._scrollOffset = 0;
        this.markDirty();
        return true;
      }
      return false;
    }

    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this._selectedIndex, itemCount: panelCount });
    if (transition === 'focus-search') {
      this._filterFocused = true;
      this.markDirty();
      return true;
    }

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

    if (key === 'T' || key === 'B') {
      const selectedPanel = this._getSelectedPanelEntry(entries);
      if (selectedPanel) {
        const pane = key === 'T' ? 'top' : 'bottom';
        try {
          const pm = getPanelManager();
          pm.open(selectedPanel.reg.id, pane);
          pm.show();
        } catch (err) {
          console.debug('[panel-list] failed to place panel:', err);
        }
        this.markDirty();
      }
      return true;
    }

    if (key === 'M') {
      const selectedPanel = this._getSelectedPanelEntry(entries);
      if (selectedPanel) {
        try {
          getPanelManager().moveToOtherPane(selectedPanel.reg.id);
        } catch (err) {
          console.debug('[panel-list] failed to move panel:', err);
        }
        this.markDirty();
      }
      return true;
    }

    if (key === 'S') {
      getPanelManager().toggleBottomPane();
      this.markDirty();
      return true;
    }

    if (key === 'tab') {
      getPanelManager().togglePaneFocus();
      this.markDirty();
      return true;
    }

    // Search: backspace
    if (isPanelSearchBackspace(key)) {
      if (this._query.length > 0) {
        this._query = this._query.slice(0, -1);
        this._clampSelection(entries);
        this.markDirty();
        return true;
      }
      return false;
    }

    // Escape: clear search
    if (isPanelSearchCancel(key)) {
      if (this._query.length > 0) {
        this._query = '';
        this._clampSelection(entries);
        this.markDirty();
        return true;
      }
      return false;
    }

    // Printable character: append to search query
    return false;
  }

  public render(width: number, height: number): Line[] {
    if (!this.canRenderNow()) {
      return Array.from({ length: height }, () => createEmptyLine(width));
    }
    const start = Date.now();
    this.needsRender = false;
    const intro = 'Browse, place, split, and move panels without dropping into raw panel-management commands.';
    const entries = this._buildEntries();

    if (entries.length === 0) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Panel Workspace',
        intro,
        sections: [{
          title: 'Filter',
          lines: [buildSearchInputLine(width, 'Filter: ', `${this._query}${this._filterFocused ? '_' : ''}`, C, {
            active: this._filterFocused,
            bg: C.searchBg,
            emptyLabel: this._filterFocused ? '(type to filter)' : '(/ or up at top)',
            valueColor: C.search,
          })],
        }, {
          lines: buildEmptyState(
            width,
            ' No panels match filter.',
            'Clear the filter or search for another panel by id, name, description, or category.',
            [{ command: '/panel list', summary: 'reopen the panel workspace from the shell' }],
            C,
          ),
        }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      if (lines.length > height) lines.length = height;
      this.reportRenderDuration(Date.now() - start);
      return lines;
    }

    const panelEntries = entries.filter(e => e.kind === 'panel');
    const bodyHeight = Math.max(1, height - 7);
    const pm = getPanelManager();
    const topIds = new Set(pm.getTopPane().panels.map(p => p.id));
    const bottomIds = new Set(pm.getBottomPane().panels.map(p => p.id));
    const focusedPane = pm.getFocusedPane();
    const entryLines: Line[] = [
      buildSearchInputLine(width, 'Filter: ', `${this._query}${this._filterFocused ? '_' : ''}`, C, {
        active: this._filterFocused,
        bg: C.searchBg,
        emptyLabel: this._filterFocused ? '(type to filter)' : '(/ or up at top)',
        valueColor: C.search,
      }),
    ];
    const renderedBlocks: Array<{ entry: ListEntry; lines: Line[]; panelFlatIndex?: number }> = [];
    let flatPanelIndex = 0;
    for (const entry of entries) {
      if (entry.kind === 'header') {
        const label = ` ── ${CATEGORY_LABELS[entry.category]} ${'─'.repeat(Math.max(0, width - 6 - CATEGORY_LABELS[entry.category].length))}`;
        renderedBlocks.push({
          entry,
          lines: [buildPanelLine(width, [[label.slice(0, width), C.category, C.categoryBg]])],
        });
      } else {
        const flatIdx = flatPanelIndex++;
        const isSelected = flatIdx === this._selectedIndex;
        const bg = isSelected ? C.selectedBg : '';
        const isTopOpen = topIds.has(entry.reg.id);
        const isBottomOpen = bottomIds.has(entry.reg.id);
        const dot = isTopOpen || isBottomOpen ? '●' : '○';
        const dotColor = isTopOpen || isBottomOpen ? C.openDot : C.closedDot;
        const arrow = isSelected ? '▶' : ' ';
        const nameColor = isSelected ? C.selected : C.name;
        const nameStr = entry.reg.name.padEnd(NAME_COL_WIDTH, ' ').slice(0, NAME_COL_WIDTH);
        const descStartCol = PREFIX_WIDTH + NAME_COL_WIDTH + 1;
        const descWidth = Math.max(1, width - descStartCol);
        const descLines = wrapPanelDescription(entry.reg.description, descWidth, 2);
        const placement = panelPlacementMarker({ isTopOpen, isBottomOpen, focusedPane });
        const blockLines: Line[] = [
          buildPanelLine(width, [
            [arrow, C.selIcon, bg],
            [dot, dotColor, bg],
            [placement.text, placement.color, bg],
            [' ', C.dim, bg],
            [nameStr + ' ', nameColor, bg],
            [descLines[0] ?? '', C.desc, bg],
          ]),
        ];
        if ((descLines[1] ?? '').length > 0) {
          blockLines.push(buildPanelLine(width, [
            [' '.repeat(PREFIX_WIDTH), C.dim, bg],
            [' '.repeat(NAME_COL_WIDTH), C.dim, bg],
            [' ', C.dim, bg],
            [descLines[1] ?? '', C.desc, bg],
          ]));
        }
        renderedBlocks.push({ entry, lines: blockLines, panelFlatIndex: flatIdx });
      }
    }
    const blockStarts: number[] = [];
    let totalRows = 0;
    for (const block of renderedBlocks) {
      blockStarts.push(totalRows);
      totalRows += block.lines.length;
    }
    const selectedEntryIndex = renderedBlocks.findIndex((block) => block.panelFlatIndex === this._selectedIndex);
    const selectedRow = selectedEntryIndex >= 0 ? blockStarts[selectedEntryIndex] ?? 0 : 0;
    const window = getTrackedVisibleWindow(totalRows, selectedRow, bodyHeight, this._scrollOffset, 1);
    this._scrollOffset = window.start;
    let consumedRows = 0;
    for (let i = 0; i < renderedBlocks.length; i++) {
      const block = renderedBlocks[i]!;
      const startRow = blockStarts[i] ?? 0;
      const endRow = startRow + block.lines.length;
      if (endRow <= window.start) continue;
      if (startRow >= window.end) break;
      const sliceStart = Math.max(0, window.start - startRow);
      const sliceEnd = Math.min(block.lines.length, window.end - startRow);
      for (const line of block.lines.slice(sliceStart, sliceEnd)) {
        entryLines.push(line);
        consumedRows++;
      }
      if (consumedRows >= bodyHeight) break;
    }

    const hintText = ` [${this._selectedIndex + 1}/${panelEntries.length}] ↑/↓ nav  Enter open  T/B place  M move  S split  Tab focus`;
    const sections: PanelWorkspaceSection[] = [{ title: 'Panels', lines: entryLines }];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Panel Workspace',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [[hintText.slice(0, width), C.hint]])],
      palette: C,
    });

    while (lines.length < height) lines.push(createEmptyLine(width));
    if (lines.length > height) lines.length = height;
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

}
