// ---------------------------------------------------------------------------
// PanelManager — central manager for panel lifecycle, navigation, and split
// ---------------------------------------------------------------------------

import type { Panel, PanelRegistration, PanelCategory } from './types.ts';

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _instance: PanelManager | null = null;

export function getPanelManager(): PanelManager {
  if (!_instance) {
    _instance = new PanelManager();
  }
  return _instance;
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

export interface Pane {
  panels: Panel[];
  activeIndex: number;
}

// ---------------------------------------------------------------------------
// PanelManager
// ---------------------------------------------------------------------------

export class PanelManager {
  private registry: PanelRegistration[] = [];
  private _visible: boolean = false;
  private _splitRatio: number = 0.6;

  // Two panes for the top/bottom split within the panel area
  private topPane: Pane = { panels: [], activeIndex: 0 };
  private bottomPane: Pane = { panels: [], activeIndex: 0 };
  private _focusedPane: 'top' | 'bottom' = 'top';
  private _verticalSplitRatio: number = 0.5; // top gets 50% of panel height
  private _bottomPaneVisible: boolean = false;

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  registerType(registration: PanelRegistration): void {
    const existing = this.registry.findIndex(r => r.id === registration.id);
    if (existing >= 0) {
      this.registry[existing] = registration;
    } else {
      this.registry.push(registration);
    }
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

  // -------------------------------------------------------------------------
  // Panel lifecycle — operates on a specific pane (defaults to focused)
  // -------------------------------------------------------------------------

  open(panelId: string, pane?: 'top' | 'bottom'): Panel {
    const targetPane = pane ?? this._focusedPane;
    const p = this._getPane(targetPane);

    const existing = p.panels.find(panel => panel.id === panelId);
    if (existing) {
      this._activateByIdInPane(panelId, targetPane);
      return existing;
    }

    const registration = this.registry.find(r => r.id === panelId);
    if (!registration) {
      throw new Error(`No panel type registered with id: ${panelId}`);
    }

    const oldPanel = p.panels[p.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();

    const panel = registration.factory();
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
    return panel;
  }

  close(panelId: string): void {
    // Search both panes
    for (const which of ['top', 'bottom'] as const) {
      const p = this._getPane(which);
      const index = p.panels.findIndex(panel => panel.id === panelId);
      if (index < 0) continue;

      const panel = p.panels[index];
      const wasActive = index === p.activeIndex;
      if (wasActive) panel.onDeactivate();
      panel.onDestroy();
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
  }

  prevPanel(): void {
    const p = this._getFocusedPane();
    if (p.panels.length === 0) return;
    const oldPanel = p.panels[p.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();
    p.activeIndex = (p.activeIndex - 1 + p.panels.length) % p.panels.length;
    const newPanel = p.panels[p.activeIndex];
    if (newPanel) newPanel.onActivate();
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
  }

  activateById(panelId: string): void {
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
  }

  getFocusedPane(): 'top' | 'bottom' {
    return this._focusedPane;
  }

  togglePaneFocus(): void {
    if (!this._bottomPaneVisible || this.bottomPane.panels.length === 0) return;
    this._focusedPane = this._focusedPane === 'top' ? 'bottom' : 'top';
  }

  // -------------------------------------------------------------------------
  // Pane visibility
  // -------------------------------------------------------------------------

  toggleBottomPane(): void {
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
          // Open a default panel in bottom pane
          const firstType = this.registry[0];
          if (firstType) {
            this.open(firstType.id, 'bottom');
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

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  toggle(): void {
    this._visible = !this._visible;
    // Auto-open a default panel if toggling visible with nothing open
    if (this._visible && this.topPane.panels.length === 0 && this.bottomPane.panels.length === 0) {
      // Try to open the first registered panel type
      const firstType = this.registry[0];
      if (firstType) {
        this.open(firstType.id);
      }
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
    for (const panel of [...this.topPane.panels, ...this.bottomPane.panels]) {
      panel.onDestroy();
    }
    this.topPane = { panels: [], activeIndex: 0 };
    this.bottomPane = { panels: [], activeIndex: 0 };
    this._focusedPane = 'top';
    this._bottomPaneVisible = false;
    this._visible = false;
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
  }

  private _activateByIdInPane(panelId: string, which: 'top' | 'bottom'): void {
    const p = this._getPane(which);
    const index = p.panels.findIndex(panel => panel.id === panelId);
    if (index >= 0 && index !== p.activeIndex) {
      const oldPanel = p.panels[p.activeIndex];
      if (oldPanel) oldPanel.onDeactivate();
      p.activeIndex = index;
      const newPanel = p.panels[p.activeIndex];
      if (newPanel) newPanel.onActivate();
    }
  }
}
