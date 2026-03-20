import type { PanelRegistration, PanelCategory } from './types.ts';

/** Display order for panel categories. */
const CATEGORY_ORDER: PanelCategory[] = ['development', 'agent', 'monitoring', 'session', 'ai'];

/** Human-readable labels for each category. */
const CATEGORY_LABELS: Record<PanelCategory, string> = {
  development: 'Development',
  agent:       'Agent',
  monitoring:  'Monitoring',
  session:     'Session',
  ai:          'AI',
};

/**
 * Modal state for browsing and selecting panel registrations.
 * The filtered list is a flat list of PanelRegistration items matching the
 * current search query. Category headers are rendered by the overlay, not
 * stored here — keeping this class pure data/logic.
 */
export class PanelPicker {
  public active: boolean = false;
  public selectedIndex: number = 0;
  public searchQuery: string = '';
  private items: PanelRegistration[] = [];
  private filtered: PanelRegistration[] = [];

  /** Open the picker with the given set of registered panels. */
  open(registrations: PanelRegistration[]): void {
    this.items = registrations;
    this.searchQuery = '';
    this.filtered = this._applyFilter('');
    this.selectedIndex = 0;
    this.active = true;
  }

  /** Close and reset the picker. */
  close(): void {
    this.active = false;
    this.searchQuery = '';
    this.selectedIndex = 0;
  }

  /**
   * Filter the list by name or description (case-insensitive).
   * Resets selectedIndex to 0.
   */
  search(query: string): void {
    this.searchQuery = query;
    this.filtered = this._applyFilter(query);
    this.selectedIndex = 0;
  }

  /** Move selection up by one, wrapping at top. */
  moveUp(): void {
    if (this.filtered.length === 0) return;
    this.selectedIndex = this.selectedIndex <= 0
      ? this.filtered.length - 1
      : this.selectedIndex - 1;
  }

  /** Move selection down by one, wrapping at bottom. */
  moveDown(): void {
    if (this.filtered.length === 0) return;
    this.selectedIndex = this.selectedIndex >= this.filtered.length - 1
      ? 0
      : this.selectedIndex + 1;
  }

  /**
   * Returns the filtered list, sorted by category order then name.
   * The overlay is responsible for inserting category headers between groups.
   */
  getVisible(): PanelRegistration[] {
    return this.filtered;
  }

  /** Returns the currently selected registration, or null if the list is empty. */
  getSelected(): PanelRegistration | null {
    if (this.filtered.length === 0) return null;
    return this.filtered[this.selectedIndex] ?? null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _applyFilter(query: string): PanelRegistration[] {
    const q = query.trim().toLowerCase();
    const source = q
      ? this.items.filter(
          r =>
            r.name.toLowerCase().includes(q) ||
            r.description.toLowerCase().includes(q),
        )
      : [...this.items];

    // Sort by category order, then alphabetically within each category
    return source.sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.category);
      const bi = CATEGORY_ORDER.indexOf(b.category);
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });
  }
}

export { CATEGORY_LABELS, CATEGORY_ORDER };
