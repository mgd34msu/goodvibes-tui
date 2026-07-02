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
 * - `w` to close the selected panel if it is currently open (either pane)
 *
 * Open via /panel list.
 */
import type { Line, Cell } from '../types/grid.ts';
import type { PanelCategory, PanelRegistration } from './types.ts';
import { BasePanel } from './base-panel.ts';
import type { PanelManager } from './panel-manager.ts';
import type { ComponentHealthMonitor } from '../runtime/perf/panel-health-monitor.ts';
import { createEmptyLine } from '../types/grid.ts';
import {
  buildEmptyState,
  buildKeyValueLine,
  buildPanelListRow,
  buildPanelLine,
  buildSearchInputLine,
  buildSummaryBlock,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import { wrapWithHangingIndent } from '../renderer/text-layout.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

// ── Colour palette ────────────────────────────────────────────────────────────
// Domain accents only; base chrome (header/headerBg/label/value/dim/good/bad/
// info/selectBg) comes from DEFAULT_PANEL_PALETTE.
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  search:      '#f97316',   // active search-filter highlight
  paneBottom:  '#a78bfa',   // bottom-pane placement marker (distinct from top/info cyan)
} as const);

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
const PREFIX_WIDTH = 5; // arrow + dot + health-flag + space + space

/** A flat entry in the navigable list — either a section header or a panel row. */
type ListEntry =
  | { kind: 'header'; label: string }
  | { kind: 'panel'; reg: PanelRegistration };

/** Number of most-recently-opened panels to surface in the Recent group. */
const RECENT_LIMIT = 5;

function panelPlacementMarker(options: {
  isTopOpen: boolean;
  isBottomOpen: boolean;
  focusedPane: 'top' | 'bottom';
}): { text: string; color: string } {
  const { isTopOpen, isBottomOpen, focusedPane } = options;
  if (isTopOpen && isBottomOpen) return { text: '◆', color: C.value };
  if (isTopOpen) return { text: focusedPane === 'top' ? '▲' : '△', color: C.info };
  if (isBottomOpen) return { text: focusedPane === 'bottom' ? '▼' : '▽', color: C.paneBottom };
  return { text: ' ', color: C.dim };
}

/**
 * Optional per-row resource-health flag, sourced straight from the injected
 * ComponentHealthMonitor (fills the gap left by WO-004's panel-resources
 * panel removal — health is still readable, just from here instead of a
 * dedicated panel). Blank for panels with no health record yet (never
 * rendered) or currently healthy.
 */
function panelHealthMarker(health: { healthStatus: 'healthy' | 'warning' | 'overloaded' } | undefined): { text: string; color: string } {
  if (!health) return { text: ' ', color: C.dim };
  if (health.healthStatus === 'overloaded') return { text: '!', color: C.bad };
  if (health.healthStatus === 'warning') return { text: '~', color: C.warn };
  return { text: ' ', color: C.dim };
}

function wrapPanelDescription(text: string, width: number, maxLines = 2): string[] {
  if (width <= 0) return [''];
  const lines = wrapWithHangingIndent(text, width, '', maxLines);
  return lines.length > 0 ? lines.map((line) => truncateDisplay(line, width)) : [''];
}

// ── PanelListPanel ────────────────────────────────────────────────────────────

export class PanelListPanel extends BasePanel {
  private _selectedIndex  = 0;
  private _scrollOffset   = 0;
  private _query          = '';
  private _filterFocused  = false;
  private _cachedEntries: ListEntry[] | null = null;
  private _entriesDirty   = true;

  public constructor(
    private readonly panelManager: PanelManager,
    componentHealthMonitor?: ComponentHealthMonitor,
  ) {
    super('panel-list', 'Panel List', 'L', 'session', componentHealthMonitor);
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
            this.panelManager.open(selectedPanel.reg.id);
          } catch (err) {
            logger.warn(`[panel-list] failed to open panel: ${err}`);
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
          this.panelManager.open(selectedPanel.reg.id);
        } catch (err) {
          logger.warn(`[panel-list] failed to open panel: ${err}`);
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
          const pm = this.panelManager;
          pm.open(selectedPanel.reg.id, pane);
          pm.show();
        } catch (err) {
          logger.warn(`[panel-list] failed to place panel: ${err}`);
        }
        this.markDirty();
      }
      return true;
    }

    if (key === 'M') {
      const selectedPanel = this._getSelectedPanelEntry(entries);
      if (selectedPanel) {
        try {
          this.panelManager.moveToOtherPane(selectedPanel.reg.id);
        } catch (err) {
          logger.warn(`[panel-list] failed to move panel: ${err}`);
        }
        this.markDirty();
      }
      return true;
    }

    if (key === 'S') {
      this.panelManager.toggleBottomPane();
      this.markDirty();
      return true;
    }

    if (key === 'w') {
      const selectedPanel = this._getSelectedPanelEntry(entries);
      if (selectedPanel) {
        try {
          // Existing public PanelManager.close() API only — panel-manager.ts
          // itself is WO-150's surface this wave.
          this.panelManager.close(selectedPanel.reg.id);
        } catch (err) {
          logger.warn(`[panel-list] failed to close panel: ${err}`);
        }
        this.markDirty();
      }
      return true;
    }

    if (key === 'tab') {
      this.panelManager.togglePaneFocus();
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

    // Printable character: focus the filter and append it — the class-doc
    // promise ("Search/filter by typing") previously had no matching
    // behavior here; typing anything but '/' while list-focused was a no-op.
    if (isPanelSearchPrintable(key)) {
      this._filterFocused = true;
      this._query += key;
      this._selectedIndex = 0;
      this._scrollOffset = 0;
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
            bg: C.headerBg,
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
    const pm = this.panelManager;
    const topIds = new Set(pm.getTopPane().panels.map(p => p.id));
    const bottomIds = new Set(pm.getBottomPane().panels.map(p => p.id));
    const focusedPane = pm.getFocusedPane();
    const footerLines = [buildPanelLine(width, [[truncateDisplay(` [${this._selectedIndex + 1}/${panelEntries.length}] ↑/↓ nav  Enter open  w close  T/B place  M move  S split  Tab focus`, width), C.dim]])];
    // Optional health rollup — only present when a ComponentHealthMonitor was
    // injected (fills the gap left by WO-004's panel-resources panel removal).
    const allHealth = this.componentHealthMonitor?.getAllHealth() ?? [];
    const unhealthyCount = allHealth.filter((h) => h.healthStatus !== 'healthy').length;

    const postureLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'visible panels', value: String(pm.getAllOpen().length), valueColor: pm.getAllOpen().length > 0 ? C.value : C.dim },
        { label: 'focused pane', value: focusedPane, valueColor: focusedPane === 'top' ? C.info : C.paneBottom },
        { label: 'split', value: pm.isBottomPaneVisible() ? 'dual' : 'single', valueColor: pm.isBottomPaneVisible() ? C.info : C.dim },
        { label: 'results', value: String(panelEntries.length), valueColor: C.value },
        ...(this.componentHealthMonitor
          ? [{ label: 'flagged', value: String(unhealthyCount), valueColor: unhealthyCount > 0 ? C.warn : C.good }]
          : []),
      ], C),
      buildPanelLine(width, [[` Filter owns input only when selected. Open and switch operations should land directly in focused panel state.`, C.header]]),
    ];
    const entryLines: Line[] = [
      buildSearchInputLine(width, 'Filter: ', `${this._query}${this._filterFocused ? '_' : ''}`, C, {
        active: this._filterFocused,
        bg: C.headerBg,
        emptyLabel: this._filterFocused ? '(type to filter)' : '(/ or up at top)',
        valueColor: C.search,
      }),
    ];
    const renderedBlocks: Array<{ entry: ListEntry; lines: Line[]; panelFlatIndex?: number }> = [];
    let flatPanelIndex = 0;
    for (const entry of entries) {
      if (entry.kind === 'header') {
        const label = ` ── ${entry.label} ${'─'.repeat(Math.max(0, width - 6 - entry.label.length))}`;
        renderedBlocks.push({
          entry,
          lines: [buildPanelLine(width, [[truncateDisplay(label, width), C.label, C.headerBg]])],
        });
      } else {
        const flatIdx = flatPanelIndex++;
        const isSelected = flatIdx === this._selectedIndex;
        const isTopOpen = topIds.has(entry.reg.id);
        const isBottomOpen = bottomIds.has(entry.reg.id);
        const dot = isTopOpen || isBottomOpen ? '●' : '○';
        const dotColor = isTopOpen || isBottomOpen ? C.good : C.dim;
        const nameColor = C.value;
        const nameStr = fitDisplay(entry.reg.name, NAME_COL_WIDTH);
        const descStartCol = PREFIX_WIDTH + NAME_COL_WIDTH + 1;
        const descWidth = Math.max(1, width - descStartCol);
        const descLines = wrapPanelDescription(entry.reg.description, descWidth, 2);
        const placement = panelPlacementMarker({ isTopOpen, isBottomOpen, focusedPane });
        const health = panelHealthMarker(this.componentHealthMonitor?.getHealth(entry.reg.id));
        // When searching, the flat result list loses its category grouping — so
        // tag each result with a dim [Category] so the origin stays discoverable.
        const categoryTag = this._query
          ? `[${CATEGORY_LABELS[entry.reg.category]}] `
          : '';
        const blockLines: Line[] = [
          buildPanelListRow(width, [
            { text: dot, fg: dotColor },
            { text: placement.text, fg: placement.color },
            { text: health.text, fg: health.color },
            { text: ' ', fg: C.dim },
            { text: `${nameStr} `, fg: nameColor },
            { text: categoryTag, fg: C.label },
            { text: descLines[0] ?? '', fg: C.label },
          ], C, { selected: isSelected, selectedBg: C.selectBg, markerColor: C.info }),
        ];
        if ((descLines[1] ?? '').length > 0) {
          blockLines.push(buildPanelLine(width, [
            [' '.repeat(PREFIX_WIDTH), C.dim, isSelected ? C.selectBg : C.surfaceBg],
            [' '.repeat(NAME_COL_WIDTH), C.dim, isSelected ? C.selectBg : C.surfaceBg],
            [' ', C.dim, isSelected ? C.selectBg : C.surfaceBg],
            [descLines[1] ?? '', C.label, isSelected ? C.selectBg : C.surfaceBg],
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
    const postureSection: PanelWorkspaceSection = { lines: buildSummaryBlock(width, 'Panel posture', postureLines, C) };
    const resolvedSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines,
      palette: C,
      beforeSections: [postureSection],
      section: {
        title: 'Panels',
        fixedLines: entryLines,
        scrollableLines: renderedBlocks.flatMap((block) => block.lines),
        selectedIndex: selectedRow,
        scrollOffset: this._scrollOffset,
        guardRows: 1,
        minRows: 1,
        appendWindowSummary: {
          dimColor: C.dim,
        },
      },
    });
    this._scrollOffset = resolvedSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      resolvedSection.section,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Panel Workspace',
      intro,
      sections,
      footerLines,
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

    const manager = this.panelManager;
    const byCategory = manager.getTypesByCategory();
    const q = this._query.toLowerCase();
    const entries: ListEntry[] = [];

    // Recent group (browse mode only): the most-recently-opened panels, newest
    // first, so frequently used panels are one keystroke away.
    if (!q) {
      const byId = new Map(manager.getRegisteredTypes().map((r) => [r.id, r]));
      const recent: PanelRegistration[] = [];
      for (const id of manager.getRecentlyOpened()) {
        const reg = byId.get(id);
        if (reg) recent.push(reg);
        if (recent.length >= RECENT_LIMIT) break;
      }
      if (recent.length > 0) {
        entries.push({ kind: 'header', label: 'Recent' });
        for (const reg of recent) entries.push({ kind: 'panel', reg });
      }
    }

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

      entries.push({ kind: 'header', label: CATEGORY_LABELS[cat] });
      for (const reg of filtered) {
        entries.push({ kind: 'panel', reg });
      }
    }

    this._cachedEntries = entries;
    this._entriesDirty = false;
    return entries;
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
