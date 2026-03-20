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
// PanelManager
// ---------------------------------------------------------------------------

export class PanelManager {
  private panels: Panel[] = [];
  private registry: PanelRegistration[] = [];
  private activeIndex: number = 0;
  private _visible: boolean = false;
  private _splitRatio: number = 0.6;

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
  // Panel lifecycle
  // -------------------------------------------------------------------------

  open(panelId: string): Panel {
    const existing = this.panels.find(p => p.id === panelId);
    if (existing) {
      this.activateById(panelId);
      return existing;
    }

    const registration = this.registry.find(r => r.id === panelId);
    if (!registration) {
      throw new Error(`No panel type registered with id: ${panelId}`);
    }

    const oldPanel = this.panels[this.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();

    const panel = registration.factory();
    this.panels.push(panel);
    this.activeIndex = this.panels.length - 1;
    this._visible = true;
    panel.onActivate();
    return panel;
  }

  close(panelId: string): void {
    const index = this.panels.findIndex(p => p.id === panelId);
    if (index < 0) return;

    const panel = this.panels[index];
    const wasActive = index === this.activeIndex;
    if (wasActive) panel.onDeactivate();
    panel.onDestroy();
    this.panels.splice(index, 1);

    if (this.panels.length === 0) {
      this.activeIndex = 0;
      this._visible = false;
    } else {
      this.activeIndex = Math.min(this.activeIndex, this.panels.length - 1);
      if (wasActive) {
        const newActive = this.panels[this.activeIndex];
        if (newActive) newActive.onActivate();
      }
    }
  }

  getOpen(): Panel[] {
    return [...this.panels];
  }

  getActive(): Panel | null {
    if (this.panels.length === 0) return null;
    return this.panels[this.activeIndex] ?? null;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  nextPanel(): void {
    if (this.panels.length === 0) return;
    const oldPanel = this.panels[this.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();
    this.activeIndex = (this.activeIndex + 1) % this.panels.length;
    const newPanel = this.panels[this.activeIndex];
    if (newPanel) newPanel.onActivate();
  }

  prevPanel(): void {
    if (this.panels.length === 0) return;
    const oldPanel = this.panels[this.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();
    this.activeIndex = (this.activeIndex - 1 + this.panels.length) % this.panels.length;
    const newPanel = this.panels[this.activeIndex];
    if (newPanel) newPanel.onActivate();
  }

  activateByIndex(index: number): void {
    if (index < 0 || index >= this.panels.length) return;
    if (index === this.activeIndex) return;
    const oldPanel = this.panels[this.activeIndex];
    if (oldPanel) oldPanel.onDeactivate();
    this.activeIndex = index;
    const newPanel = this.panels[this.activeIndex];
    if (newPanel) newPanel.onActivate();
  }

  activateById(panelId: string): void {
    const index = this.panels.findIndex(p => p.id === panelId);
    if (index >= 0 && index !== this.activeIndex) {
      const oldPanel = this.panels[this.activeIndex];
      if (oldPanel) oldPanel.onDeactivate();
      this.activeIndex = index;
      const newPanel = this.panels[this.activeIndex];
      if (newPanel) newPanel.onActivate();
    }
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  toggle(): void {
    this._visible = !this._visible;
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
  // Split control
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
  // Cleanup
  // -------------------------------------------------------------------------

  destroyAll(): void {
    for (const panel of this.panels) {
      panel.onDestroy();
    }
    this.panels = [];
    this.activeIndex = 0;
    this._visible = false;
  }
}
