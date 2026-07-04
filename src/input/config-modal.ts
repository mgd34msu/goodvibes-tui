import type {
  ConfigModalAction,
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from './config-modal-types.ts';
import type { ModalSectionStyle } from '../renderer/modal-factory.ts';
import { truncateDisplay, wrapText } from '../utils/terminal-width.ts';

export type {
  ConfigModalAction,
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from './config-modal-types.ts';

/** A tab as the renderer sees it (structure frozen, label live). */
export interface ConfigModalRenderTab {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
}

/** A row as the renderer sees it: frozen identity, live label/value overlay. */
export interface ConfigModalRenderRow {
  readonly id: string;
  readonly label: string;
  readonly style?: ModalSectionStyle;
  readonly selected: boolean;
  readonly selectable: boolean;
  /** True when this frozen row has no live counterpart this tick (value went
   *  stale — kept in place, dimmed, until the next interaction boundary). */
  readonly stale: boolean;
}

/** Everything renderConfigModal needs — computed by overlaying live values onto
 *  the frozen structure so layout stays stable between key presses. */
export interface ConfigModalRenderModel {
  readonly title: string;
  readonly tabs: readonly ConfigModalRenderTab[];
  readonly header: readonly string[];
  readonly rows: readonly ConfigModalRenderRow[];
  readonly emptyText?: string;
  readonly degraded?: string;
  readonly status?: string;
  readonly hints: readonly string[];
  readonly scroll: { readonly offset: number; readonly total: number; readonly visible: number };
}

const DEFAULT_VISIBLE_ROWS = 10;

/**
 * Default label wrap width for getRenderModel() callers that don't pass one
 * (tests, mainly). Matches the renderer's real list-item wrap width at the
 * common terminal sizes this codebase tests against: default box width 76,
 * minus the 4-column text margin and 2-column selection indicator (see
 * ModalFactory._renderListSection's `contentW - 2`). renderConfigModal()
 * itself always computes and passes the ACTUAL width for the current
 * terminal size — this constant only matters when getRenderModel() is
 * called directly without going through the renderer.
 */
const DEFAULT_LABEL_WRAP_WIDTH = 70;

/**
 * Stable id for the synthesized "no matches" row DEBT-5 item 1 injects when a
 * filter query excludes every selectable row in a tab. Non-selectable (info
 * rows are never filtered — see ConfigModal's filter doc) so this id can
 * never collide with a real surface row id.
 */
const FILTER_NO_MATCH_ROW_ID = '__config_modal_filter_no_match__';

/**
 * ConfigModal — the single, generic, named config-modal host. One instance
 * lives on the InputHandler (like `settingsModal`); it renders whatever
 * `ConfigModalSurface` is currently open. Key routing is a single
 * `handleConfigModalToken` path (handler-modal-routes.ts) — no parallel input
 * system. See config-modal-types.ts for the surface contract and the liveness
 * doctrine this class enforces.
 */
export class ConfigModal {
  public active = false;

  private surface: ConfigModalSurface | null = null;
  private requestRender: () => void = () => {};

  /** Active tab / selected row tracked by STABLE id (survives value refresh). */
  private activeTabId = '';
  private selectedRowId = '';

  /** Transient status line (action result, error, or confirm prompt). */
  private statusMessage = '';
  /** Pending destructive confirm: the action key awaiting a second press. */
  private pendingConfirmKey: string | null = null;

  /**
   * DEBT-5 item 1 — the host's own type-to-filter, armed with '/' (matching
   * the pre-existing "'/' to filter" convention: scrollable-list-panel.ts's
   * opt-in filter, and SettingsModal's own '/'-armed search). `filterActive`
   * gates whether printable keys go to the query instead of nav/actions;
   * `filterQuery` is the TEXT-CAPTURE buffer itself (a multi-char paste token
   * appends in one shot — see handleConfigModalToken). Filtering only ever
   * narrows the ACTIVE tab's rows and is reset on tab switch (a query typed
   * against one tab's rows has no defined meaning against another's).
   *
   * FILTER-CONVENTION RULING (batch integration — where '/'-armed vs instant
   * filtering is decided across the TUI's list UIs):
   *   - '/'-ARMED here (config-modal host surfaces): these surfaces bind PLAIN
   *     single keys to ACTION HOTKEYS (e.g. 'r' refresh, 'd' delete). A key
   *     can't be both an action and a filter character, so filtering must be
   *     explicitly armed with '/' first. This is DEBT-5's design.
   *   - INSTANT filtering (pure pickers — help overlay, command palette,
   *     selection-modal): these have no single-key actions, so every printable
   *     key is unambiguously a filter character and narrows the list on the
   *     first keystroke. This is UX-C's design (selection-modal-overlay.ts).
   *   - Both keep single-Esc-close semantics. The only extra step is here: a
   *     two-stage Esc (first Esc clears a NON-EMPTY query, second Esc closes)
   *     — see the Esc branch in handleConfigModalToken. With an empty query,
   *     one Esc closes, exactly like the instant pickers.
   */
  private filterActive = false;
  private filterQuery = '';

  /**
   * Structure captured at the last interaction boundary (open / key press).
   * Renders overlay live values onto THIS so rows never reflow mid-interaction.
   */
  private frozenView: ConfigModalView | null = null;

  private scrollOffset = 0;
  private visibleRows = DEFAULT_VISIBLE_ROWS;

  /**
   * False until the first token reaches the open modal. While false, renders
   * may re-sync structure so an async onOpen load replaces the "Loading…"
   * placeholder WITHOUT requiring a keypress; the freeze-to-interaction-
   * boundary rule protects a cursor the user has engaged, and before the
   * first interaction there is nothing to protect (refutation finding 3).
   */
  private interactedSinceOpen = false;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  open(surface: ConfigModalSurface, requestRender: () => void = () => {}): void {
    // Re-opening a different surface closes the previous one cleanly.
    if (this.surface && this.surface !== surface) this.surface.onClose?.();
    this.surface = surface;
    this.requestRender = requestRender;
    this.active = true;
    this.statusMessage = '';
    this.pendingConfirmKey = null;
    this.scrollOffset = 0;
    this.filterActive = false;
    this.filterQuery = '';
    this.interactedSinceOpen = false;
    const view = surface.buildView();
    this.frozenView = view;
    this.activeTabId = view.tabs[0]?.id ?? '';
    this.selectedRowId = this._firstSelectableId(this._frozenTab());
    surface.onOpen?.(requestRender);
  }

  close(): void {
    if (!this.active) return;
    this.surface?.onClose?.();
    this.active = false;
    this.surface = null;
    this.frozenView = null;
    this.statusMessage = '';
    this.pendingConfirmKey = null;
    this.filterActive = false;
    this.filterQuery = '';
  }

  /** Re-activate the current surface after a nested modal closes (Esc stack). */
  reopen(): void {
    if (!this.surface) return;
    this.active = true;
    this.syncStructure();
    this.surface.onOpen?.(this.requestRender);
  }

  getSurfaceName(): string | null {
    return this.surface?.name ?? null;
  }

  setViewportRows(rows: number): void {
    this.visibleRows = Math.max(3, rows);
    this._clampScroll();
  }

  // ── Interaction boundary ────────────────────────────────────────────────────

  /** Token router calls this for every token the open modal receives. */
  noteInteraction(): void {
    this.interactedSinceOpen = true;
  }

  /**
   * Re-capture the structure from the current live view. Called on every key
   * press (never during a pure render tick — with one exception: before the
   * FIRST interaction, getRenderModel syncs so async loads paint) — this is
   * what makes structural changes appear only at an interaction boundary.
   * Selection + active tab are preserved by id and clamped if their target
   * vanished.
   */
  syncStructure(): void {
    if (!this.surface) return;
    const view = this._applyFilter(this.surface.buildView());
    this.frozenView = view;
    if (!view.tabs.some((t) => t.id === this.activeTabId)) {
      this.activeTabId = view.tabs[0]?.id ?? '';
    }
    const tab = this._frozenTab();
    if (!this._selectableIds(tab).includes(this.selectedRowId)) {
      this.selectedRowId = this._firstSelectableId(tab);
    }
    this._clampScroll();
  }

  // ── Filter (DEBT-5 item 1 — each mutation is an interaction boundary) ──────

  isFilterActive(): boolean {
    return this.filterActive;
  }

  getFilterQuery(): string {
    return this.filterQuery;
  }

  /** Arm the filter (handleConfigModalToken calls this on '/'). Idempotent. */
  activateFilter(): void {
    if (this.filterActive) return;
    this._clearConfirm();
    this.filterActive = true;
    this.syncStructure();
  }

  /**
   * Append text to the query — the WHOLE token value in one call, so a
   * multi-char paste token lands in the filter atomically rather than being
   * split into per-char nav/action dispatch (the text-capture invariant this
   * item's brief calls out). A no-op when the filter isn't armed.
   */
  appendFilterText(text: string): void {
    if (!this.filterActive || text.length === 0) return;
    this.filterQuery += text;
    this.syncStructure();
  }

  backspaceFilter(): void {
    if (!this.filterActive || this.filterQuery.length === 0) return;
    this.filterQuery = this.filterQuery.slice(0, -1);
    this.syncStructure();
  }

  /**
   * Esc while filtering: a non-empty query is CLEARED (stays armed, ready to
   * retype without pressing '/' again) and this returns true so the caller
   * (handleConfigModalToken) stops here instead of closing the modal. An
   * empty query returns false — the caller falls through to the ordinary
   * close path, preserving single-Esc-close for the no-filter case (the one
   * documented exception: two-stage Esc only when there is something to
   * clear).
   */
  clearFilterOrFallthrough(): boolean {
    if (!this.filterActive || this.filterQuery.length === 0) return false;
    this.filterQuery = '';
    this.syncStructure();
    return true;
  }

  // ── Navigation (each is an interaction boundary) ────────────────────────────

  moveDown(): void {
    this._clearConfirm();
    this.syncStructure();
    const ids = this._selectableIds(this._frozenTab());
    if (ids.length === 0) return;
    const i = ids.indexOf(this.selectedRowId);
    this.selectedRowId = ids[(i + 1) % ids.length]!;
    this._clampScroll();
  }

  moveUp(): void {
    this._clearConfirm();
    this.syncStructure();
    const ids = this._selectableIds(this._frozenTab());
    if (ids.length === 0) return;
    const i = ids.indexOf(this.selectedRowId);
    this.selectedRowId = ids[(i - 1 + ids.length) % ids.length]!;
    this._clampScroll();
  }

  nextTab(): void {
    this._switchTab(1);
  }

  prevTab(): void {
    this._switchTab(-1);
  }

  private _switchTab(dir: 1 | -1): void {
    this._clearConfirm();
    // A filter query is scoped to the tab it was typed against — switching
    // tabs resets it (DEBT-5 item 1), same as statusMessage below.
    this.filterActive = false;
    this.filterQuery = '';
    this.syncStructure();
    const tabs = this.frozenView?.tabs ?? [];
    if (tabs.length <= 1) return;
    const i = tabs.findIndex((t) => t.id === this.activeTabId);
    const next = tabs[(i + dir + tabs.length) % tabs.length]!;
    this.activeTabId = next.id;
    this.selectedRowId = this._firstSelectableId(next);
    this.scrollOffset = 0;
    this.statusMessage = '';
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  /** The action bound to `key` on the active tab/row, if enabled. */
  resolveAction(key: string): ConfigModalAction | null {
    const actions = this.surface?.actions ?? [];
    const row = this.getSelectedRow();
    for (const action of actions) {
      if (action.key !== key) continue;
      if (action.enabledFor && !action.enabledFor(row, this.activeTabId)) return null;
      return action;
    }
    return null;
  }

  /**
   * Attempt to fire the action bound to `key`. Returns true if a key was an
   * action (consumed). Handles the two-press confirm for destructive actions.
   * This is an interaction boundary (syncs structure first).
   */
  fireAction(key: string, ctx: Omit<ConfigModalActionContext, 'row' | 'tabId' | 'setStatus' | 'close' | 'requestRender'>): boolean {
    this.syncStructure();
    const action = this.resolveAction(key);
    if (!action) return false;
    if (action.confirm && this.pendingConfirmKey !== key) {
      this.pendingConfirmKey = key;
      this.statusMessage = `Press ${key} again to ${action.label}.`;
      return true;
    }
    this._clearConfirm();
    const fullCtx: ConfigModalActionContext = {
      row: this.getSelectedRow(),
      tabId: this.activeTabId,
      print: ctx.print,
      executeCommand: ctx.executeCommand,
      openModal: ctx.openModal,
      submitInput: ctx.submitInput,
      requestRender: this.requestRender,
      setStatus: (m: string) => { this.statusMessage = m; },
      close: () => this.close(),
    };
    this.surface?.onAction?.(action.id, fullCtx);
    return true;
  }

  /** Clear a pending confirm when the user navigates or presses an unrelated key. */
  clearConfirmOnMiss(): void {
    this._clearConfirm();
  }

  // ── Read accessors (for the renderer + tests) ───────────────────────────────

  getSelectedRow(): ConfigModalRow | null {
    const tab = this._liveTab(this.activeTabId) ?? this._frozenTab();
    return tab?.rows.find((r) => r.id === this.selectedRowId) ?? null;
  }

  getActiveTabId(): string {
    return this.activeTabId;
  }

  getSelectedRowId(): string {
    return this.selectedRowId;
  }

  getStatusMessage(): string {
    return this.statusMessage;
  }

  /**
   * Compute the render model: frozen structure + live value overlay. Pure —
   * does NOT sync structure, so calling it repeatedly with only value mutations
   * yields byte-identical layout (the liveness contract).
   *
   * `labelWrapWidth` is the wrap column ModalFactory's list section will use
   * for row labels (renderConfigModal computes and passes the real one for
   * the current terminal size). It exists so the wrap-clamp below (DEBT-5
   * item 2) can pre-empt a live label growing past ModalFactory's wrap width
   * mid-tick — a structural change (an extra visible line) without an
   * interaction — by measuring wrapped line counts here, before the label
   * ever reaches the renderer.
   */
  getRenderModel(labelWrapWidth: number = DEFAULT_LABEL_WRAP_WIDTH): ConfigModalRenderModel {
    // Pre-first-interaction: async onOpen loads may restructure freely (the
    // user hasn't engaged a cursor yet) — sync so "Loading…" is replaced by
    // real content on the load's own requestRender, not the next keypress.
    if (this.active && !this.interactedSinceOpen) this.syncStructure();
    const live = this.surface?.buildView() ?? null;
    const frozen = this.frozenView;
    if (!frozen) {
      return { title: '', tabs: [], header: [], rows: [], hints: [], scroll: { offset: 0, total: 0, visible: this.visibleRows } };
    }

    const tabs: ConfigModalRenderTab[] = frozen.tabs.map((ft) => {
      const lt = live?.tabs.find((t) => t.id === ft.id);
      return { id: ft.id, label: lt?.label ?? ft.label, active: ft.id === this.activeTabId };
    });

    const frozenTab = frozen.tabs.find((t) => t.id === this.activeTabId) ?? frozen.tabs[0];
    const liveTab = live?.tabs.find((t) => t.id === this.activeTabId);

    // Header: all-or-nothing live overlay. Same line count → use live values;
    // a count change is a structural change, deferred (keep frozen header).
    const frozenHeader = frozenTab?.header ?? [];
    const liveHeader = liveTab?.header ?? [];
    const header = liveHeader.length === frozenHeader.length ? liveHeader : frozenHeader;

    // Rows: iterate the frozen id order; overlay the live row (value refresh) by
    // id, or keep the frozen row marked stale when its live counterpart is gone.
    const frozenRows = frozenTab?.rows ?? [];
    const allRows: ConfigModalRenderRow[] = frozenRows.map((fr) => {
      const lr = liveTab?.rows.find((r) => r.id === fr.id);
      const src = lr ?? fr;
      return {
        id: fr.id,
        label: this._clampRowLabel(fr.label, src.label, labelWrapWidth),
        style: src.style,
        selected: fr.id === this.selectedRowId,
        selectable: fr.selectable !== false,
        stale: lr === undefined,
      };
    });

    const visible = this.visibleRows;
    const windowed = allRows.slice(this.scrollOffset, this.scrollOffset + visible);

    // DEBT-5 item 1: while filtering, the surface's own action/tab hints are
    // unreliable (their printable-letter keys are captured by the filter
    // instead of firing — see handleConfigModalToken), so the footer swaps
    // to just the filter status (query + a truthful match count) and the
    // Esc contract for this mode. See getFilterQuery/isFilterActive callers.
    const filtering = this.filterActive;
    const hasQuery = filtering && this.filterQuery.length > 0;
    const hints = filtering
      ? [
          this._filterStatusHint(
            frozenRows.filter((r) => r.selectable !== false).length,
            (liveTab?.rows ?? []).filter((r) => r.selectable !== false).length,
          ),
          hasQuery ? 'Esc clear · Esc close' : 'Esc close',
        ]
      : [
          ...(frozen.hints ?? []),
          ...(frozenTab?.hints ?? []),
          ...this._actionHints(),
          'Esc close',
        ];

    return {
      title: live?.title ?? frozen.title,
      tabs,
      header,
      rows: windowed,
      emptyText: frozenRows.length === 0 ? (frozenTab?.emptyText ?? 'Nothing to show.') : undefined,
      degraded: live?.degraded ?? frozen.degraded,
      status: this.statusMessage || undefined,
      hints,
      scroll: { offset: this.scrollOffset, total: allRows.length, visible },
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /**
   * DEBT-5 item 2 (wrap-clamp overlay): keep a live label within the FROZEN
   * row's line footprint until the next interaction boundary re-freezes it.
   * `frozenLabel` is what the row wrapped to when the structure was captured
   * (open/nav/filter keystroke); `liveLabel` is this tick's value. If the
   * live label would wrap into MORE lines than the frozen one, that is a
   * structural change (an extra visible row) happening without a keypress —
   * exactly the hazard this closes. Clamp to the frozen line count, ellipsis
   * on the last line to signal truncation; a live label that wraps to the
   * SAME or FEWER lines passes through untouched (not the documented hazard).
   * Identical strings short-circuit (the common per-tick case: unchanged or
   * non-selected/stale rows) without doing any wrap work.
   */
  private _clampRowLabel(frozenLabel: string, liveLabel: string, width: number): string {
    if (liveLabel === frozenLabel) return liveLabel;
    const frozenLineCount = Math.max(1, wrapText(frozenLabel, width).length);
    const liveLines = wrapText(liveLabel, width);
    if (liveLines.length <= frozenLineCount) return liveLabel;
    const clamped = liveLines.slice(0, frozenLineCount);
    const lastIdx = clamped.length - 1;
    clamped[lastIdx] = `${truncateDisplay(clamped[lastIdx]!, Math.max(1, width - 1))}…`;
    return clamped.join('\n');
  }

  /** Footer text for the active filter: the query + a truthful match count. */
  private _filterStatusHint(matched: number, total: number): string {
    const q = this.filterQuery;
    if (q.length === 0) return `/ type to filter (${total} row${total === 1 ? '' : 's'})`;
    return `/${q} — ${matched} of ${total} match${matched === 1 ? '' : 'es'}`;
  }

  /** Apply the active filter query to every tab's rows. A no-op passthrough when not filtering. */
  private _applyFilter(view: ConfigModalView): ConfigModalView {
    if (!this.filterActive || this.filterQuery === '') return view;
    const query = this.filterQuery.toLowerCase();
    return { ...view, tabs: view.tabs.map((tab) => this._filterTab(tab, query)) };
  }

  /**
   * Narrow one tab's rows to those matching `query` (case-insensitive
   * substring on the label). Non-selectable rows (section titles, honest
   * empty-state copy, warning banners) always pass through unfiltered —
   * they're context, not data. When the query excludes every selectable row
   * but the tab genuinely had some, append the honest "no rows match" line
   * (DEBT-5 item 1's empty-result case) instead of silently showing nothing
   * or misleadingly falling back to the surface's own emptyText (which
   * describes "no data at all", not "no data matches your filter").
   */
  private _filterTab(tab: ConfigModalTab, query: string): ConfigModalTab {
    const kept = tab.rows.filter((r) => r.selectable === false || r.label.toLowerCase().includes(query));
    const hadSelectable = tab.rows.some((r) => r.selectable !== false);
    const stillMatched = kept.some((r) => r.selectable !== false);
    if (hadSelectable && !stillMatched) {
      return {
        ...tab,
        rows: [...kept, { id: FILTER_NO_MATCH_ROW_ID, label: `No rows match "${this.filterQuery}".`, selectable: false }],
      };
    }
    return { ...tab, rows: kept };
  }

  private _actionHints(): string[] {
    const actions = this.surface?.actions ?? [];
    const row = this.getSelectedRow();
    const out: string[] = [];
    for (const a of actions) {
      if (a.enabledFor && !a.enabledFor(row, this.activeTabId)) continue;
      out.push(`${a.key} ${a.label}`);
    }
    return out;
  }

  private _clearConfirm(): void {
    if (this.pendingConfirmKey !== null) {
      this.pendingConfirmKey = null;
      this.statusMessage = '';
    }
  }

  private _frozenTab(): ConfigModalTab | undefined {
    return this.frozenView?.tabs.find((t) => t.id === this.activeTabId) ?? this.frozenView?.tabs[0];
  }

  private _liveTab(id: string): ConfigModalTab | undefined {
    return this.surface?.buildView().tabs.find((t) => t.id === id);
  }

  private _selectableIds(tab: ConfigModalTab | undefined): string[] {
    return (tab?.rows ?? []).filter((r) => r.selectable !== false).map((r) => r.id);
  }

  private _firstSelectableId(tab: ConfigModalTab | undefined): string {
    return this._selectableIds(tab)[0] ?? '';
  }

  private _clampScroll(): void {
    const tab = this._frozenTab();
    const rows = tab?.rows ?? [];
    const idx = rows.findIndex((r) => r.id === this.selectedRowId);
    const visible = Math.max(3, this.visibleRows);
    if (idx >= 0) {
      if (idx < this.scrollOffset) this.scrollOffset = idx;
      else if (idx >= this.scrollOffset + visible) this.scrollOffset = idx - visible + 1;
    }
    const maxOffset = Math.max(0, rows.length - visible);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }
}
