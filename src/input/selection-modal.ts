/**
 * SelectionModal - Generic reusable selection modal with fuzzy search.
 * Used by /template, /sessions, /bookmarks, /tools, and focused pickers.
 */

export interface SelectionItem {
  id: string;
  label: string;
  detail?: string;        // shown to the right of label
  category?: string;      // optional grouping header
  actions?: string;       // hint text for available actions (e.g., "[d] delete")
  fg?: string;             // optional foreground color override for this item
  primaryAction?: SelectionAction; // default Enter/Space behavior for this row
  adjustable?: boolean;   // supports left/right adjustment without leaving the modal
  adjustStep?: number;    // base step for left/right adjustments
  adjustMin?: number;     // minimum numeric value when adjustable
  adjustMax?: number;     // maximum numeric value when adjustable
  adjustPrecision?: number; // decimal places to preserve for numeric adjustments
}

export type SelectionAction = 'select' | 'delete' | 'edit' | 'toggle' | 'increment' | 'decrement';

export interface SelectionResult {
  item: SelectionItem;
  action: SelectionAction;
  step?: number;
}

export class SelectionModal {
  public active = false;
  public title = '';
  public query = '';           // fuzzy search query
  public searchFocused = false;
  public items: SelectionItem[] = [];
  public filteredItems: SelectionItem[] = [];
  public selectedIndex = 0;
  public allowSearch = true;
  public customActions: Map<string, SelectionAction> = new Map();
  /**
   * vocab unification: overrides the default per-primaryAction Enter
   * verb ("Select"/"Toggle"/"Edit"/"Delete") shown in the footer hint. Used by
   * callers whose items are really commands (e.g. /help) so the hint reads
   * "[Enter] Run", matching the slash-command palette's own verb, instead of
   * the generic "Select".
   */
  public primaryVerbLabel: string | undefined = undefined;

  /** Open the modal with items and title */
  open(
    title: string,
    items: SelectionItem[],
    opts?: {
      preSelectId?: string;
      allowSearch?: boolean;
      customActions?: Map<string, SelectionAction>;
      primaryVerbLabel?: string;
    }
  ): void {
    this.title = title;
    this.items = items;
    this.query = '';
    this.allowSearch = opts?.allowSearch ?? true;
    this.searchFocused = false;
    this.customActions = opts?.customActions ?? new Map();
    this.primaryVerbLabel = opts?.primaryVerbLabel;
    this.active = true;
    this.filterItems();

    // Pre-select by id if provided
    if (opts?.preSelectId) {
      const idx = this.filteredItems.findIndex(it => it.id === opts.preSelectId);
      this.selectedIndex = idx >= 0 ? idx : 0;
    } else {
      this.selectedIndex = 0;
    }
  }

  close(): void {
    this.active = false;
    this.title = '';
    this.query = '';
    this.searchFocused = false;
    this.items = [];
    this.filteredItems = [];
    this.selectedIndex = 0;
    this.customActions = new Map();
    this.primaryVerbLabel = undefined;
  }

  moveUp(): void {
    // Skip category headers (items with no id-based content, filtered items include only selectable ones)
    if (this.filteredItems.length === 0) return;
    this.selectedIndex = this.selectedIndex > 0
      ? this.selectedIndex - 1
      : this.filteredItems.length - 1;
  }

  moveDown(): void {
    if (this.filteredItems.length === 0) return;
    this.selectedIndex = this.selectedIndex < this.filteredItems.length - 1
      ? this.selectedIndex + 1
      : 0;
  }

  /** Update fuzzy search filter */
  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
    this.filterItems();
  }

  canFocusSearch(): boolean {
    return this.allowSearch;
  }

  focusSearch(): void {
    if (this.allowSearch) this.searchFocused = true;
  }

  blurSearch(): void {
    this.searchFocused = false;
  }

  /** Get currently highlighted item */
  getSelected(): SelectionItem | null {
    if (this.filteredItems.length === 0) return null;
    return this.filteredItems[this.selectedIndex] ?? null;
  }

  /** Fuzzy match items against query, resets filteredItems */
  private filterItems(): void {
    if (this.query.length === 0) {
      this.filteredItems = this.items.slice();
      return;
    }

    const scored = this.items
      .map(item => ({ item, ...this.fuzzyMatch(this.query, item.label + ' ' + (item.detail ?? '') + ' ' + (item.category ?? '')) }))
      .filter(r => r.match)
      .sort((a, b) => b.score - a.score);

    this.filteredItems = scored.map(r => r.item);
    if (this.selectedIndex >= this.filteredItems.length) {
      this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
    }
  }

  /** Fuzzy match: does the query match the candidate? */
  private fuzzyMatch(query: string, candidate: string): { match: boolean; score: number } {
    if (query.length === 0) return { match: true, score: 0 };
    const lowerQuery = query.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();

    // Substring match (highest priority)
    const subIdx = lowerCandidate.indexOf(lowerQuery);
    if (subIdx !== -1) {
      return { match: true, score: 100 - subIdx };
    }

    // Character-by-character fuzzy match
    let qi = 0;
    let score = 0;
    for (let ci = 0; ci < lowerCandidate.length && qi < lowerQuery.length; ci++) {
      if (lowerCandidate[ci] === lowerQuery[qi]) {
        qi++;
        score += 1;
      }
    }
    if (qi === lowerQuery.length) {
      return { match: true, score };
    }
    return { match: false, score: 0 };
  }
}
