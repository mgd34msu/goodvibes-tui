// ---------------------------------------------------------------------------
// PanelManager — central manager for panel lifecycle, navigation, and split
// ---------------------------------------------------------------------------

import type { Panel, PanelRegistration, PanelCategory, PanelDeepLinkTarget } from './types.ts';
export type { PanelDeepLinkTarget } from './types.ts';
// Type-only, erased at runtime, routed through the `@/` alias (not a relative
// path) so it stays out of the relative-import graph the architecture
// cycle-checker walks — same discipline as the PanelManager import in types.ts.
import type { ConfigModalSurface } from '@/input/config-modal-types.ts';

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

export interface Pane {
  panels: Panel[];
  activeIndex: number;
}

export interface WorkspaceTab {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly pane: 'top' | 'bottom';
  readonly active: boolean;
  readonly focused: boolean;
}

// ---------------------------------------------------------------------------
// PanelManager
// ---------------------------------------------------------------------------

export class PanelManager {
  private registry: PanelRegistration[] = [];
  private retainedPanels = new Map<string, Panel>();
  /** Old/absorbed panel id -> merged target id (WO-1xx console merges). */
  private aliases = new Map<string, string>();
  /**
   * Retired panel id -> modal name (panels migrated to config-modal surfaces).
   * Unlike `aliases` (panel -> panel), a hit here means no panel is ever
   * constructed for this id — `open()` invokes `openModalCallback` instead
   * and returns a sentinel. This map and the open()-time check are the
   * sole mechanism for that redirect.
   */
  private modalRedirects = new Map<string, string>();
  /**
   * Modal name -> the surface the config-modal host renders. Built once
   * in builtin-modals.ts (closing over read-models) and looked up by
   * ui-openers' openModal callback. Distinct from `modalRedirects` (panel id ->
   * modal name): a redirect resolves a legacy panel id to a name; this map
   * resolves that name to the actual surface data/actions.
   */
  private modalSurfaces = new Map<string, ConfigModalSurface>();
  /**
   * Late-bound: the modal stack is constructed after PanelManager (same
   * ordering constraint as the openAgentDetail callback in
   * builtin/shared.ts), so this is injected via a setter rather than the
   * constructor.
   */
  private openModalCallback?: (modalName: string) => void;
  private _visible: boolean = false;
  private _splitRatio: number = 0.6;

  // Two panes for the top/bottom split within the panel area
  private topPane: Pane = { panels: [], activeIndex: 0 };
  private bottomPane: Pane = { panels: [], activeIndex: 0 };
  private _focusedPane: 'top' | 'bottom' = 'top';
  private _verticalSplitRatio: number = 0.5; // top gets 50% of panel height
  private _bottomPaneVisible: boolean = false;

  // Single source of truth for prompt-vs-panel keyboard focus. Previously this
  // lived as a `panelFocused` boolean scattered across InputHandler and the
  // input-routing seams; centralizing it here is what makes it impossible for
  // panel focus to disagree with workspace visibility (see getFocusTarget).
  private _focusTarget: 'prompt' | 'panel' = 'prompt';

  // Cache for getWorkspaceTabs() — invalidated on every panel lifecycle event
  private _cachedWorkspaceTabs: readonly WorkspaceTab[] | null = null;

  // Most-recently-opened panel ids (front = newest), for the picker's "Recent"
  // group. Session-scoped; capped to keep it a short list.
  private _recentlyOpened: string[] = [];
  private static readonly RECENT_CAP = 8;

  /** Record a panel id as most-recently-opened (front of the ring, deduped). */
  private _recordRecent(panelId: string): void {
    this._recentlyOpened = [panelId, ...this._recentlyOpened.filter((id) => id !== panelId)]
      .slice(0, PanelManager.RECENT_CAP);
  }

  /** Most-recently-opened panel ids, newest first. */
  getRecentlyOpened(): readonly string[] {
    return this._recentlyOpened;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  registerType(registration: PanelRegistration): void {
    const existing = this.registry.findIndex(r => r.id === registration.id);
    // registry-time icon-uniqueness assertion. Tab-bar icons are a
    // single glyph; two panels sharing one silently made the workspace tab
    // strip ambiguous (the historical W/R/U/K/M/Q/Y/J/P collisions). Compare
    // against every OTHER registration (excluding a re-registration of the
    // same id, which is a legitimate update, e.g. tests replacing a factory).
    const iconOwner = this.registry.find(r => r.id !== registration.id && r.icon === registration.icon);
    if (iconOwner) {
      throw new Error(
        `Panel icon '${registration.icon}' for '${registration.id}' collides with already-registered panel '${iconOwner.id}'. Panel icons must be unique across the registry.`,
      );
    }
    if (existing >= 0) {
      this.registry[existing] = registration;
    } else {
      this.registry.push(registration);
    }
  }

  /**
   * Register a compat redirect so an absorbed panel's old id still resolves
   * after a console merge (docs, saved layouts, and muscle memory do not
   * break). Resolved by open/close/activateById/getPanel/getPaneOf.
   */
  registerAlias(aliasId: string, targetId: string): void {
    this.aliases.set(aliasId, targetId);
  }

  /**
   * Register a redirect so `open(panelId)` opens the named modal instead of
   * constructing a panel (MIGRATE-TO-MODAL surfaces). Checked in open()
   * before alias/registry resolution.
   */
  registerModalRedirect(panelId: string, modalName: string): void {
    this.modalRedirects.set(panelId, modalName);
  }

  /**
   * Inject the callback `open()` invokes when it hits a modal redirect.
   * Late-bound via setter because the modal stack is constructed after
   * PanelManager (mirrors the openAgentDetail callback pattern).
   */
  setOpenModalCallback(callback: (modalName: string) => void): void {
    this.openModalCallback = callback;
  }

  /**
   * The modal name `panelIdOrAlias` redirects to, if any — lets callers
   * (e.g. the `/panel` command) print "moved to the <name> modal" before or
   * instead of calling open().
   */
  getModalRedirect(panelIdOrAlias: string): string | undefined {
    return this.modalRedirects.get(panelIdOrAlias);
  }

  /**
   * Register the surface (data + actions) the config-modal host renders for a
   * modal name. Called from builtin-modals.ts alongside registerModalRedirect.
   */
  registerModalSurface(surface: ConfigModalSurface): void {
    this.modalSurfaces.set(surface.name, surface);
  }

  /** Resolve a modal name to its registered surface, if any. */
  getModalSurface(name: string): ConfigModalSurface | undefined {
    return this.modalSurfaces.get(name);
  }

  private _resolveId(panelId: string): string {
    return this.aliases.get(panelId) ?? panelId;
  }

  /**
   * Placeholder returned by open() for a modal-redirected id. Never pushed
   * into a pane, never retained, never rendered — it exists only so open()
   * can keep its non-null `Panel` return type without constructing the real
   * (deleted) panel view. `name` carries the modal name so a caller that
   * inspects the returned panel's `name` (rather than calling
   * getModalRedirect() beforehand) still gets an honest answer.
   */
  private _modalRedirectSentinel(panelId: string, modalName: string): Panel {
    return {
      id: panelId,
      name: modalName,
      icon: '·',
      category: 'session',
      onActivate: () => {},
      onDeactivate: () => {},
      onDestroy: () => {},
      render: () => [],
      isTransient: true,
      isPinned: false,
      needsRender: false,
      invalidate: () => {},
      markRendered: () => {},
    };
  }

  getRegisteredTypes(): PanelRegistration[] {
    return [...this.registry];
  }

  getTypesByCategory(): Map<PanelCategory, PanelRegistration[]> {
    const map = new Map<PanelCategory, PanelRegistration[]>();
    for (const reg of this.registry) {
      const list = map.get(reg.category) ?? [];
      list.push(reg);
      map.set(reg.category, list);
    }
    return map;
  }

  prewarmRegistered(): void {
    for (const registration of this.registry) {
      if (!registration.preload) continue;
      if (this.getPanel(registration.id) || this.retainedPanels.has(registration.id)) continue;
      const panel = registration.factory();
      this.retainedPanels.set(registration.id, panel);
    }
  }

  // -------------------------------------------------------------------------
  // Panel lifecycle — operates on a specific pane (defaults to focused)
  // -------------------------------------------------------------------------

  /** Invalidate the workspace tab cache. Call on every panel lifecycle mutation. */
  private _invalidateWorkspaceTabs(): void {
    this._cachedWorkspaceTabs = null;
  }

  open(panelIdOrAlias: string, pane?: 'top' | 'bottom', target?: PanelDeepLinkTarget): Panel {
    const modalName = this.modalRedirects.get(panelIdOrAlias);
    if (modalName !== undefined) {
      this.openModalCallback?.(modalName);
      return this._modalRedirectSentinel(panelIdOrAlias, modalName);
    }
    const panelId = this._resolveId(panelIdOrAlias);
    this._recordRecent(panelId);
    const existingPane = this._findPaneOf(panelId);
    if (existingPane) {
      this._visible = true;
      // Honor an explicitly requested pane so open(id, pane) never lies about
      // where the panel lands: relocate it if it currently lives in the other
      // pane (fixes `/panel open <id> top` and the panel-list T/B move keys).
      if (pane && pane !== existingPane) {
        this._moveBetweenPanes(existingPane, pane, panelId);
        return this._deliverDeepLink(this.getPanel(panelId)!, target);
      }
      this._activateByIdInPane(panelId, existingPane);
      this._focusedPane = existingPane;
      if (existingPane === 'bottom') this._bottomPaneVisible = true;
      return this._deliverDeepLink(this._getPane(existingPane).panels[this._getPane(existingPane).activeIndex]!, target);
    }

    const targetPane = pane ?? this._focusedPane;
    const p = this._getPane(targetPane);

    const oldPanel = p.panels[p.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();

    const panel = this._obtainPanel(panelId);
    p.panels.push(panel);
    p.activeIndex = p.panels.length - 1;
    this._visible = true;
    // If opening into bottom pane, also make it visible
    if (targetPane === 'bottom') {
      this._bottomPaneVisible = true;
      this._focusedPane = 'bottom';
    } else {
      this._focusedPane = 'top';
    }
    panel.onActivate();
    this._invalidateWorkspaceTabs();
    return this._deliverDeepLink(panel, target);
  }

  /**
   * Hand an optional deep-link target (item 4) to a panel that just
   * resolved from open(). Panels without a "node" concept simply don't
   * implement `receiveDeepLink` — the call is a no-op via optional chaining.
   */
  private _deliverDeepLink(panel: Panel, target: PanelDeepLinkTarget | undefined): Panel {
    if (target) panel.receiveDeepLink?.(target);
    return panel;
  }

  close(panelIdOrAlias: string): void {
    const panelId = this._resolveId(panelIdOrAlias);
    // Search both panes
    for (const which of ['top', 'bottom'] as const) {
      const p = this._getPane(which);
      const index = p.panels.findIndex(panel => panel.id === panelId);
      if (index < 0) continue;

      const panel = p.panels[index];
      const wasActive = index === p.activeIndex;
      if (wasActive) panel.onDeactivate();
      if (this._shouldRetain(panelId)) {
        this.retainedPanels.set(panelId, panel);
      } else {
        panel.onDestroy();
      }
      p.panels.splice(index, 1);

      if (p.panels.length === 0) {
        p.activeIndex = 0;
        if (which === 'bottom') {
          this._bottomPaneVisible = false;
          // Move focus to top if we were focused on empty bottom
          if (this._focusedPane === 'bottom') this._focusedPane = 'top';
        }
      } else {
        p.activeIndex = Math.min(p.activeIndex, p.panels.length - 1);
        if (wasActive) {
          const newActive = p.panels[p.activeIndex];
          if (newActive) newActive.onActivate();
        }
      }

      // Hide sidebar if no panels remain in either pane
      if (this.topPane.panels.length === 0 && this.bottomPane.panels.length === 0) {
        this._visible = false;
      }
      this._invalidateWorkspaceTabs();
      return;
    }
  }

  /**
   * Move a panel to a specific pane. If panelId is omitted, moves the active
   * panel from the currently focused pane.
   */
  moveToPane(dest: 'top' | 'bottom', panelId?: string): void {
    const srcPaneName = panelId
      ? this._findPaneOf(panelId) ?? this._focusedPane
      : this._focusedPane;
    if (srcPaneName === dest) return; // already there
    const dstPaneName = dest;
    this._moveBetweenPanes(srcPaneName, dstPaneName, panelId);
  }

  /**
   * Move a panel to the other pane. If panelId is omitted, moves the active
   * panel from the currently focused pane.
   */
  moveToOtherPane(panelId?: string): void {
    const srcPaneName = panelId
      ? this._findPaneOf(panelId) ?? this._focusedPane
      : this._focusedPane;
    const dstPaneName: 'top' | 'bottom' = srcPaneName === 'top' ? 'bottom' : 'top';
    this._moveBetweenPanes(srcPaneName, dstPaneName, panelId);
  }

  // -------------------------------------------------------------------------
  // Navigation — operates on focused pane
  // -------------------------------------------------------------------------

  nextPanel(): void {
    const p = this._getFocusedPane();
    if (p.panels.length === 0) return;
    const oldPanel = p.panels[p.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();
    p.activeIndex = (p.activeIndex + 1) % p.panels.length;
    const newPanel = p.panels[p.activeIndex];
    if (newPanel) newPanel.onActivate();
    this._invalidateWorkspaceTabs();
  }

  nextWorkspaceTab(): void {
    this._cycleWorkspaceTab(1);
  }

  prevWorkspaceTab(): void {
    this._cycleWorkspaceTab(-1);
  }

  prevPanel(): void {
    const p = this._getFocusedPane();
    if (p.panels.length === 0) return;
    const oldPanel = p.panels[p.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();
    p.activeIndex = (p.activeIndex - 1 + p.panels.length) % p.panels.length;
    const newPanel = p.panels[p.activeIndex];
    if (newPanel) newPanel.onActivate();
    this._invalidateWorkspaceTabs();
  }

  activateByIndex(index: number): void {
    const p = this._getFocusedPane();
    if (index < 0 || index >= p.panels.length) return;
    if (index === p.activeIndex) return;
    const oldPanel = p.panels[p.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();
    p.activeIndex = index;
    const newPanel = p.panels[p.activeIndex];
    if (newPanel) newPanel.onActivate();
    this._invalidateWorkspaceTabs();
  }

  activateById(panelIdOrAlias: string): void {
    const panelId = this._resolveId(panelIdOrAlias);
    const which = this._findPaneOf(panelId);
    if (!which) return;
    this._activateByIdInPane(panelId, which);
  }

  // -------------------------------------------------------------------------
  // Pane focus control
  // -------------------------------------------------------------------------

  focusPane(pane: 'top' | 'bottom'): void {
    if (pane === 'bottom' && !this._bottomPaneVisible) return;
    this._focusedPane = pane;
    this._invalidateWorkspaceTabs();
  }

  getFocusedPane(): 'top' | 'bottom' {
    return this._focusedPane;
  }

  /** Get the currently active (focused) panel, or null if none. */
  getActivePanel(): Panel | null {
    const p = this._getFocusedPane();
    return p.panels[p.activeIndex] ?? null;
  }

  togglePaneFocus(): void {
    if (!this._bottomPaneVisible || this.bottomPane.panels.length === 0) return;
    this._focusedPane = this._focusedPane === 'top' ? 'bottom' : 'top';
    this._invalidateWorkspaceTabs();
  }

  // -------------------------------------------------------------------------
  // Keyboard focus ownership (prompt vs. panel workspace)
  // -------------------------------------------------------------------------

  /**
   * Which surface owns keyboard focus. Self-healing: focus can only rest on the
   * panel workspace while it is visible, non-empty, and has an active panel, so
   * panel focus can never disagree with workspace visibility. Any code that
   * asks for the focus target therefore reads a value that is always consistent
   * with what is actually on screen.
   */
  getFocusTarget(): 'prompt' | 'panel' {
    if (this._focusTarget === 'panel' && !this._workspaceIsFocusable()) {
      this._focusTarget = 'prompt';
    }
    return this._focusTarget;
  }

  /** True when the panel workspace currently owns keyboard focus. */
  isPanelFocused(): boolean {
    return this.getFocusTarget() === 'panel';
  }

  /**
   * Give keyboard focus to the panel workspace. No-op when there is nothing
   * focusable (no visible, non-empty pane with an active panel) — this is the
   * guard that upholds the focus/visibility invariant on the write path.
   */
  focusPanels(): void {
    if (this._workspaceIsFocusable()) {
      this._focusTarget = 'panel';
    }
  }

  /** Return keyboard focus to the prompt. */
  focusPrompt(): void {
    this._focusTarget = 'prompt';
  }

  private _workspaceIsFocusable(): boolean {
    return this._visible && this.getAllOpen().length > 0 && this.getActivePanel() !== null;
  }

  // -------------------------------------------------------------------------
  // Pane visibility
  // -------------------------------------------------------------------------

  toggleBottomPane(): void {
    this._invalidateWorkspaceTabs();
    if (this._bottomPaneVisible) {
      this._bottomPaneVisible = false;
      if (this._focusedPane === 'bottom') this._focusedPane = 'top';
    } else {
      this._bottomPaneVisible = true;
      // If bottom pane is empty, populate it
      if (this.bottomPane.panels.length === 0) {
        if (this.topPane.panels.length > 1) {
          // Move last panel from top to bottom
          const panel = this.topPane.panels.pop()!;
          if (this.topPane.activeIndex >= this.topPane.panels.length) {
            this.topPane.activeIndex = Math.max(0, this.topPane.panels.length - 1);
          }
          this.bottomPane.panels.push(panel);
          this.bottomPane.activeIndex = 0;
        } else {
          // Open a predictable default panel in the bottom pane. purge:
          // 'panel-list' was deleted (dead weight over a 5-panel registry —
          // see the DELETE disposition), so the default is explicitly
          // 'fleet' rather than falling back to registry[0] (whatever
          // registers first, currently 'git' — see risk 5 in the brief).
          const defaultPanel = this._getRegistration('fleet') ?? this.registry[0];
          if (defaultPanel) {
            this.open(defaultPanel.id, 'bottom');
          }
        }
      }
      this._focusedPane = 'bottom';
    }
  }

  isBottomPaneVisible(): boolean {
    return this._bottomPaneVisible && this.bottomPane.panels.length > 0;
  }

  // -------------------------------------------------------------------------
  // Pane state accessors
  // -------------------------------------------------------------------------

  getTopPane(): Readonly<Pane> {
    return this.topPane;
  }

  getBottomPane(): Readonly<Pane> {
    return this.bottomPane;
  }

  // -------------------------------------------------------------------------
  // Backward-compatible accessors (operate on focused pane)
  // -------------------------------------------------------------------------

  getOpen(): Panel[] {
    const p = this._getFocusedPane();
    return [...p.panels];
  }

  /**
   * Returns all panels across both panes (top then bottom).
   * Use this when you need to know if any panels exist at all.
   */
  getAllOpen(): Panel[] {
    return [...this.topPane.panels, ...this.bottomPane.panels];
  }

  getActive(): Panel | null {
    const p = this._getFocusedPane();
    if (p.panels.length === 0) return null;
    return p.panels[p.activeIndex] ?? null;
  }

  getPanel(panelIdOrAlias: string): Panel | null {
    const panelId = this._resolveId(panelIdOrAlias);
    return this.topPane.panels.find((panel) => panel.id === panelId)
      ?? this.bottomPane.panels.find((panel) => panel.id === panelId)
      ?? null;
  }

  getPaneOf(panelIdOrAlias: string): 'top' | 'bottom' | null {
    return this._findPaneOf(this._resolveId(panelIdOrAlias));
  }

  getWorkspaceTabs(): readonly WorkspaceTab[] {
    if (this._cachedWorkspaceTabs !== null) return this._cachedWorkspaceTabs;
    // `active` = the currently selected tab in its own pane (independent of focus).
    // `focused` = true only for the one tab in the globally focused pane that is active.
    const focusedPanelId = this.getActivePanel()?.id;
    const topActivePanelId = this.topPane.panels[this.topPane.activeIndex]?.id;
    const bottomActivePanelId = this.bottomPane.panels[this.bottomPane.activeIndex]?.id;
    const topTabs = this.topPane.panels.map((panel) => ({
      id: panel.id,
      name: panel.name,
      icon: panel.icon,
      pane: 'top' as const,
      active: panel.id === topActivePanelId,
      focused: panel.id === focusedPanelId,
    }));
    const bottomTabs = this.bottomPane.panels.map((panel) => ({
      id: panel.id,
      name: panel.name,
      icon: panel.icon,
      pane: 'bottom' as const,
      active: panel.id === bottomActivePanelId,
      focused: panel.id === focusedPanelId,
    }));
    const tabs = [...topTabs, ...bottomTabs] as WorkspaceTab[];
    this._cachedWorkspaceTabs = tabs;
    return tabs;
  }

  activateWorkspaceIndex(index: number): void {
    const tabs = this.getWorkspaceTabs();
    if (index < 0 || index >= tabs.length) return;
    const tab = tabs[index]!;
    this._focusedPane = tab.pane;
    if (tab.pane === 'bottom') this._bottomPaneVisible = true;
    this._activateByIdInPane(tab.id, tab.pane);
    this._invalidateWorkspaceTabs();
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  toggle(): void {
    this._visible = !this._visible;
    // Auto-open a default panel if toggling visible with nothing open.
    // purge: explicitly 'fleet' rather than registry[0] — see the
    // matching comment in toggleBottomPane() above.
    if (this._visible && this.topPane.panels.length === 0 && this.bottomPane.panels.length === 0) {
      const defaultPanel = this._getRegistration('fleet') ?? this.registry[0];
      if (defaultPanel) this.open(defaultPanel.id);
    }
  }

  show(): void {
    this._visible = true;
  }

  hide(): void {
    this._visible = false;
  }

  isVisible(): boolean {
    return this._visible;
  }

  // -------------------------------------------------------------------------
  // Horizontal split control (left/right)
  // -------------------------------------------------------------------------

  getSplitRatio(): number {
    return this._splitRatio;
  }

  setSplitRatio(ratio: number): void {
    this._splitRatio = Math.max(0.3, Math.min(0.85, ratio));
  }

  widenLeft(): void {
    this.setSplitRatio(this._splitRatio + 0.05);
  }

  widenRight(): void {
    this.setSplitRatio(this._splitRatio - 0.05);
  }

  getLeftWidth(totalWidth: number): number {
    return Math.floor(totalWidth * this._splitRatio);
  }

  getRightWidth(totalWidth: number): number {
    return totalWidth - this.getLeftWidth(totalWidth);
  }

  // -------------------------------------------------------------------------
  // Vertical split control (top/bottom within panel area)
  // -------------------------------------------------------------------------

  getVerticalSplitRatio(): number {
    return this._verticalSplitRatio;
  }

  setVerticalSplitRatio(ratio: number): void {
    this._verticalSplitRatio = Math.max(0.2, Math.min(0.8, ratio));
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  destroyAll(): void {
    for (const panel of [...this.topPane.panels, ...this.bottomPane.panels, ...this.retainedPanels.values()]) {
      panel.onDestroy();
    }
    this.topPane = { panels: [], activeIndex: 0 };
    this.bottomPane = { panels: [], activeIndex: 0 };
    this.retainedPanels.clear();
    this.registry = [];
    this._recentlyOpened = [];
    this._focusedPane = 'top';
    this._focusTarget = 'prompt';
    this._bottomPaneVisible = false;
    this._visible = false;
    this._invalidateWorkspaceTabs();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _getPane(which: 'top' | 'bottom'): Pane {
    return which === 'top' ? this.topPane : this.bottomPane;
  }

  private _getFocusedPane(): Pane {
    return this._getPane(this._focusedPane);
  }

  private _findPaneOf(panelId: string): 'top' | 'bottom' | null {
    if (this.topPane.panels.some(p => p.id === panelId)) return 'top';
    if (this.bottomPane.panels.some(p => p.id === panelId)) return 'bottom';
    return null;
  }

  private _moveBetweenPanes(srcPaneName: 'top' | 'bottom', dstPaneName: 'top' | 'bottom', panelId?: string): void {
    const src = this._getPane(srcPaneName);
    const dst = this._getPane(dstPaneName);

    const id = panelId ?? src.panels[src.activeIndex]?.id;
    if (!id) return;

    const index = src.panels.findIndex(p => p.id === id);
    if (index < 0) return;

    const panel = src.panels[index];
    const wasActive = index === src.activeIndex;
    if (wasActive) panel.onDeactivate();
    src.panels.splice(index, 1);
    src.activeIndex = Math.min(src.activeIndex, Math.max(0, src.panels.length - 1));

    if (wasActive && src.panels.length > 0) {
      src.panels[src.activeIndex]?.onActivate();
    }

    // Deactivate current active in dest
    const oldDstActive = dst.panels[dst.activeIndex];
    if (oldDstActive) oldDstActive.onDeactivate();

    dst.panels.push(panel);
    dst.activeIndex = dst.panels.length - 1;
    panel.onActivate();

    if (dstPaneName === 'bottom') {
      this._bottomPaneVisible = true;
    }
    this._focusedPane = dstPaneName;
    this._invalidateWorkspaceTabs();
  }

  private _cycleWorkspaceTab(direction: 1 | -1): void {
    const tabs = this.getWorkspaceTabs();
    if (tabs.length === 0) return;
    const currentIndex = tabs.findIndex((tab) => tab.focused);
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + tabs.length) % tabs.length;
    this.activateWorkspaceIndex(nextIndex);
  }

  private _obtainPanel(panelId: string): Panel {
    const retained = this.retainedPanels.get(panelId);
    if (retained) {
      this.retainedPanels.delete(panelId);
      return retained;
    }
    const registration = this._getRegistration(panelId);
    if (!registration) {
      throw new Error(`No panel type registered with id: ${panelId}`);
    }
    return registration.factory();
  }

  private _getRegistration(panelId: string): PanelRegistration | undefined {
    const resolvedId = this._resolveId(panelId);
    return this.registry.find((registration) => registration.id === resolvedId);
  }

  private _shouldRetain(panelId: string): boolean {
    return this._getRegistration(panelId)?.retainOnClose === true;
  }

  private _activateByIdInPane(panelId: string, which: 'top' | 'bottom'): void {
    const p = this._getPane(which);
    const index = p.panels.findIndex(panel => panel.id === panelId);
    if (index < 0) return;
    if (index === p.activeIndex) {
      p.panels[index]?.onActivate();
      return;
    }
    if (index !== p.activeIndex) {
      const oldPanel = p.panels[p.activeIndex];
      if (oldPanel) oldPanel.onDeactivate();
      p.activeIndex = index;
      const newPanel = p.panels[p.activeIndex];
      if (newPanel) newPanel.onActivate();
      this._invalidateWorkspaceTabs();
    }
  }
}
