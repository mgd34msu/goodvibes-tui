import type {
  ConfigModalAction,
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from './config-modal-types.ts';
import type { ModalSectionStyle } from '../renderer/modal-factory.ts';

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
   * Structure captured at the last interaction boundary (open / key press).
   * Renders overlay live values onto THIS so rows never reflow mid-interaction.
   */
  private frozenView: ConfigModalView | null = null;

  private scrollOffset = 0;
  private visibleRows = DEFAULT_VISIBLE_ROWS;

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

  /**
   * Re-capture the structure from the current live view. Called on every key
   * press (never during a pure render tick) — this is what makes structural
   * changes appear only at an interaction boundary. Selection + active tab are
   * preserved by id and clamped if their target vanished.
   */
  syncStructure(): void {
    if (!this.surface) return;
    const view = this.surface.buildView();
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
   */
  getRenderModel(): ConfigModalRenderModel {
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
        label: src.label,
        style: src.style,
        selected: fr.id === this.selectedRowId,
        selectable: fr.selectable !== false,
        stale: lr === undefined,
      };
    });

    const visible = this.visibleRows;
    const windowed = allRows.slice(this.scrollOffset, this.scrollOffset + visible);

    const hints = [
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
