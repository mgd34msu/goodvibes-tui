import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { PanelCategory } from './types.ts';
import type { ComponentHealthMonitor } from '../runtime/perf/panel-health-monitor.ts';
import {
  buildEmptyState,
  buildPanelWorkspace,
  buildSearchInputLine,
  DEFAULT_PANEL_PALETTE,
  resolveScrollablePanelSection,
  type PanelPalette,
} from './polish.ts';
import { GLYPHS } from '../renderer/ui-primitives.ts';
import {
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchPrintable,
} from './search-focus.ts';

// ---------------------------------------------------------------------------
// ScrollableListPanel<T>
// ---------------------------------------------------------------------------

/**
 * Base class for all list-based panels that require scroll/cursor navigation.
 *
 * Subclasses implement:
 *   - `getItems()` — the ordered list of items to display
 *   - `renderItem(item, index, selected, width)` — one `Line` per item
 *
 * Optionally override:
 *   - `getEmptyStateMessage()` / `getEmptyStateActions()` — empty-state copy
 *   - `onSelect(item)` — called when the user presses Enter
 *   - `onAction(item, action)` — for secondary key bindings
 *   - `getPalette()` — colour palette (defaults to `DEFAULT_PANEL_PALETTE`)
 *   - `getPageSize()` — rows per page-up/page-down (default 10)
 *
 * `renderList()` produces the full `Line[]` output that a trivial panel's
 * `render()` can return directly:
 *
 * ```ts
 * render(width: number, height: number): Line[] {
 *   return this.renderList(width, height, { header: this.buildHeader(width) });
 * }
 * ```
 */
export abstract class ScrollableListPanel<T> extends BasePanel {
  protected selectedIndex = 0;
  /** Tracks the first visible row index; kept in sync with resolveScrollablePanelSection. */
  protected scrollStart = 0;
  /**
   * When true, prepends a 2-column `▸ ` gutter on the selected row.
   * Unselected rows get `  ` (two spaces) to maintain alignment.
   * Opt-in; default false to avoid breaking existing panel layouts.
   */
  protected showSelectionGutter = false;

  constructor(
    id: string,
    name: string,
    icon: string,
    category: PanelCategory,
    componentHealthMonitor?: ComponentHealthMonitor,
  ) {
    super(id, name, icon, category, componentHealthMonitor);
  }

  // -------------------------------------------------------------------------
  // Abstract — subclasses must implement
  // -------------------------------------------------------------------------

  /** Return the full ordered list of items to display. */
  protected abstract getItems(): readonly T[];

  /** Render a single item as one terminal `Line`. */
  protected abstract renderItem(
    item: T,
    index: number,
    selected: boolean,
    width: number,
  ): Line;

  // -------------------------------------------------------------------------
  // Optional overrides
  // -------------------------------------------------------------------------

  /** Short label shown in the empty-state title. */
  protected getEmptyStateMessage(): string {
    return 'No items';
  }

  /** Suggested actions shown in the empty state. */
  protected getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [];
  }

  /** Called when the user presses Enter on the selected item. */
  protected onSelect(_item: T): void {}

  /** Called for secondary key bindings (e.g. 'd' for delete). */
  protected onAction(_item: T, _action: string): void {}

  /** Colour palette used by `renderList()`. */
  protected getPalette(): PanelPalette {
    return DEFAULT_PANEL_PALETTE;
  }

  /**
   * Rows to jump on pageup / pagedown.
   * Override in `render()` to pass the actual visible row count:
   *
   * ```ts
   * this._pageSize = Math.max(1, visibleRows - 2);
   * ```
   */
  protected getPageSize(): number {
    return 10;
  }

  // -------------------------------------------------------------------------
  // Navigation — consistent across ALL panels
  // -------------------------------------------------------------------------

  /**
   * Handle keyboard input for list navigation.
   *
   * **Auto-clearError contract**: At the top of this method, `lastError` is cleared if
   * non-null. This means any transient error set via `setError()` is dismissed on the
   * very next keystroke the user presses. Subclasses that override `handleInput()` should
   * either:
   *   1. Call `super.handleInput(key)` as a fallback (preferred), which will clear the
   *      error when navigation keys are pressed, or
   *   2. Manually call `this.clearError()` at the top of their override to maintain
   *      the same contract for their handled keys.
   *
   * Returns `true` if the key was consumed, `false` to let the panel manager try another
   * handler.
   */
  handleInput(key: string): boolean {
    // I2: auto-clear transient errors on the next keystroke so stale errors don't linger.
    // Subclasses that override handleInput should call super.handleInput(key) OR manually
    // call this.clearError() at the start of their handler.
    if (this.lastError !== null) this.clearError();

    const items = this.getItems();
    const total = items.length;

    switch (key) {
      case 'up':
      case 'k':
        if (total === 0) return false;
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.needsRender = true;
        return true;

      case 'down':
      case 'j':
        if (total === 0) return false;
        this.selectedIndex = Math.min(total - 1, this.selectedIndex + 1);
        this.needsRender = true;
        return true;

      case 'pageup':
        if (total === 0) return false;
        this.selectedIndex = Math.max(0, this.selectedIndex - this.getPageSize());
        this.needsRender = true;
        return true;

      case 'pagedown':
        if (total === 0) return false;
        this.selectedIndex = Math.min(total - 1, this.selectedIndex + this.getPageSize());
        this.needsRender = true;
        return true;

      case 'home':
      case 'g':
        if (total === 0) return false;
        this.selectedIndex = 0;
        this.needsRender = true;
        return true;

      case 'end':
      case 'G':
        if (total === 0) return false;
        this.selectedIndex = total - 1;
        this.needsRender = true;
        return true;

      case 'return':
      case 'enter': {
        if (total === 0) return false;
        const item = items[this.selectedIndex];
        if (item !== undefined) this.onSelect(item);
        return true;
      }

      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Scroll state helpers
  // -------------------------------------------------------------------------

  /**
   * Clamp `selectedIndex` to the current item count.
   * Must be called after any data refresh that may shrink the list.
   */
  protected clampSelection(): void {
    const total = this.getItems().length;
    if (total === 0) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, total - 1);
    }
  }

  // -------------------------------------------------------------------------
  // Render helper — the main convenience entry point
  // -------------------------------------------------------------------------

  /**
   * Render the full panel including optional header/footer and an empty state.
   *
   * Uses `resolveScrollablePanelSection` + `buildPanelWorkspace` internally,
   * keeping `scrollStart` in sync after each call.
   *
   * @param width  Panel width in columns.
   * @param height Panel height in rows.
   * @param options.header  Lines prepended as the first workspace section.
   * @param options.footer  Lines appended as the last workspace section.
   * @param options.emptyMessage  Override for the empty-state title text.
   * @param options.title  Workspace title (defaults to `this.name`).
   * @param options.spinnerFrame  Animation frame for the loading spinner.
   */
  protected renderList(
    width: number,
    height: number,
    options: {
      readonly header?: readonly Line[];
      readonly footer?: readonly Line[];
      readonly emptyMessage?: string;
      readonly title?: string;
      readonly spinnerFrame?: number;
    } = {},
  ): Line[] {
    this.needsRender = false;
    const palette = this.getPalette();
    const items = this.getItems();
    const title = options.title ?? this.name;

    // I2: inject error line into footer when present
    const errorLine = this.renderErrorLine(width);
    const baseFooter = options.footer ? [...options.footer as Line[]] : [];
    const effectiveFooter: Line[] = errorLine ? [errorLine, ...baseFooter] : baseFooter;

    // I3: if loading, show spinner in place of normal content
    const spinnerLine = this.renderLoadingLine(width, options.spinnerFrame ?? 0);
    if (spinnerLine) {
      const loadingSection = { lines: [spinnerLine] };
      const headerSection = options.header ? [{ lines: options.header as Line[] }] : [];
      const lines = buildPanelWorkspace(width, height, {
        title,
        sections: [...headerSection, loadingSection],
        palette,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    // Build all item lines (pre-render for resolveScrollablePanelSection)
    const scrollableLines: Line[] = items.map((item, index) =>
      this.renderItem(item, index, index === this.selectedIndex, width),
    );

    // I5: prepend selection gutter when opted in
    if (this.showSelectionGutter) {
      const infoColor = this.getPalette().info ?? DEFAULT_PANEL_PALETTE.info;
      const dimColor = this.getPalette().dim;
      for (let i = 0; i < scrollableLines.length; i++) {
        const line = scrollableLines[i]!;
        const isSelected = i === this.selectedIndex;
        // Shift all cells right by 2, drop the last 2 to preserve width
        const shifted = line.slice(0, width - 2);
        const gutterChar = isSelected ? GLYPHS.navigation.selected : ' ';
        const gutterFg = isSelected ? infoColor : dimColor;
        const g0 = createStyledCell(gutterChar, { fg: gutterFg, bold: isSelected });
        const g1 = createStyledCell(' ', { fg: gutterFg });
        scrollableLines[i] = [g0, g1, ...shifted] as Line;
      }
    }

    // Empty state
    if (scrollableLines.length === 0) {
      const emptyLines = buildEmptyState(
        width,
        options.emptyMessage ?? this.getEmptyStateMessage(),
        '',
        this.getEmptyStateActions(),
        palette,
      );
      const lines = buildPanelWorkspace(width, height, {
        title,
        sections: [
          ...(options.header ? [{ lines: options.header as Line[] }] : []),
          { lines: emptyLines },
          ...(effectiveFooter.length > 0 ? [{ lines: effectiveFooter }] : []),
        ],
        palette,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    // Resolve scrollable section (updates scrollStart)
    const beforeSections = options.header ? [{ lines: options.header as Line[] }] : [];
    const afterSections = effectiveFooter.length > 0 ? [{ lines: effectiveFooter }] : [];

    const resolved = resolveScrollablePanelSection(width, height, {
      palette,
      beforeSections,
      afterSections,
      section: {
        scrollableLines,
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollStart,
        guardRows: 1,
        appendWindowSummary: scrollableLines.length > 5 ? { dimColor: palette.dim } : undefined,
      },
    });
    this.scrollStart = resolved.scrollOffset;

    const sections = [
      ...beforeSections,
      resolved.section,
      ...afterSections,
    ];

    const lines = buildPanelWorkspace(width, height, {
      title,
      sections,
      palette,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}

// ---------------------------------------------------------------------------
// SearchableListPanel<T>
// ---------------------------------------------------------------------------

/**
 * Extends `ScrollableListPanel<T>` with inline search/filter support.
 *
 * Subclasses implement:
 *   - `getAllItems()` — the full (unfiltered) item list
 *   - `matchesSearch(item, query)` — case-insensitive filter predicate
 *
 * `getItems()` is implemented here and returns filtered results. Do NOT
 * override `getItems()` in subclasses — override `getAllItems()` instead.
 *
 * Search state:
 *   - Printable characters append to `searchQuery`.
 *   - Backspace/Delete removes the last character.
 *   - Escape clears the query.
 *   - Navigation keys (up/down/etc.) are forwarded to the parent.
 *
 * Render the search input line by calling `buildSearchInput(width)` from
 * your panel's header builder.
 */
export abstract class SearchableListPanel<T> extends ScrollableListPanel<T> {
  protected searchQuery = '';

  private _filteredItems: readonly T[] = [];
  private _filterDirty = true;

  // -------------------------------------------------------------------------
  // Abstract — subclasses must implement
  // -------------------------------------------------------------------------

  /** Return the full unfiltered item list. */
  protected abstract getAllItems(): readonly T[];

  /** Return true if `item` matches the search `query`. */
  protected abstract matchesSearch(item: T, query: string): boolean;

  // -------------------------------------------------------------------------
  // getItems — returns filtered list (do NOT override in subclasses)
  // -------------------------------------------------------------------------

  protected getItems(): readonly T[] {
    if (this._filterDirty) {
      const all = this.getAllItems();
      this._filteredItems = this.searchQuery
        ? all.filter((item) => this.matchesSearch(item, this.searchQuery))
        : all;
      this._filterDirty = false;
      // Clamp after filter to keep selection in bounds
      this.clampSelection();
    }
    return this._filteredItems;
  }

  /**
   * Mark the filter cache as stale.
   * Call this whenever `getAllItems()` returns new data.
   */
  protected invalidateFilter(): void {
    this._filterDirty = true;
    this.needsRender = true;
  }

  // -------------------------------------------------------------------------
  // Input — search first, navigation second
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    // Backspace: trim query
    if (isPanelSearchBackspace(key)) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this._filterDirty = true;
        this.needsRender = true;
        return true;
      }
      return false;
    }

    // Escape: clear query
    if (isPanelSearchCancel(key)) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = '';
        this._filterDirty = true;
        this.needsRender = true;
        return true;
      }
      return false;
    }

    // Printable characters: append to query
    if (isPanelSearchPrintable(key)) {
      this.searchQuery += key;
      this._filterDirty = true;
      this.needsRender = true;
      return true;
    }

    // Navigation and Enter: delegate to parent
    return super.handleInput(key);
  }

  /**
   * Build the filter input `Line` for use in a panel header section.
   *
   * Renders the filter label and current query with context-sensitive formatting:
   *
   * - **Focused** (`focused = true`): `[Filter] query_`  — active, bold, cursor visible
   * - **Unfocused** (`focused = false`): `Filter: query`  — dim, no cursor
   *
   * @param width   Panel width in columns.
   * @param label   Label text (default: `'Filter'`).
   * @param focused Whether the filter input is currently active.
   */
  protected buildFilterInputLine(width: number, label = 'Filter', focused: boolean): Line {
    const palette = this.getPalette();
    const formattedLabel = focused ? `[${label}] ` : `${label}: `;
    const value = focused ? `${this.searchQuery}_` : this.searchQuery;
    // Pass active:false when focused to prevent buildSearchInputLine from converting the
    // trailing '_' cursor to the block-glyph (GLYPHS.surface.cursor). The focused visual
    // affordance is provided by the '[Label] ' bracket format and explicit inputBg/info colors.
    const opts = focused
      ? { active: false, bg: palette.inputBg, valueColor: palette.info }
      : { active: false };
    return buildSearchInputLine(width, formattedLabel, value, palette, opts);
  }
}
