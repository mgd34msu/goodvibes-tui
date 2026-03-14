import type { SlashCommand } from './command-registry.ts';
import type { CommandRegistry } from './command-registry.ts';

/**
 * AutocompleteResult - A ranked match from the command registry.
 */
export interface AutocompleteResult {
  command: SlashCommand;
  score: number;
}

/**
 * AutocompleteState - All state for the autocomplete dropdown.
 * When `active` is false the dropdown is hidden.
 */
export interface AutocompleteState {
  active: boolean;
  query: string;
  results: AutocompleteResult[];
  selectedIndex: number;
}

/**
 * AutocompleteEngine - Manages autocomplete state for the slash command prompt.
 *
 * Usage:
 *   - Call `update(query)` whenever the partial command text changes.
 *   - Call `moveDown()` / `moveUp()` for arrow key navigation.
 *   - Call `getSelected()` to retrieve the currently highlighted command.
 *   - Call `reset()` on Escape or after a command executes.
 */
export class AutocompleteEngine {
  private state: AutocompleteState = {
    active: false,
    query: '',
    results: [],
    selectedIndex: 0,
  };

  constructor(private registry: CommandRegistry) {}

  /**
   * update - Refresh the autocomplete results for the given query.
   * Activates the dropdown whenever query changes.
   */
  update(query: string): void {
    this.state.query = query;
    this.state.results = this.registry.fuzzyMatch(query);
    this.state.active = true;
    // Clamp selection to new result count
    if (this.state.selectedIndex >= this.state.results.length) {
      this.state.selectedIndex = Math.max(0, this.state.results.length - 1);
    }
  }

  /** Move selection down one item (wraps around). */
  moveDown(): void {
    if (this.state.results.length === 0) return;
    this.state.selectedIndex = (this.state.selectedIndex + 1) % this.state.results.length;
  }

  /** Move selection up one item (wraps around). */
  moveUp(): void {
    if (this.state.results.length === 0) return;
    this.state.selectedIndex =
      (this.state.selectedIndex - 1 + this.state.results.length) % this.state.results.length;
  }

  /** Return the currently selected command, if any. */
  getSelected(): SlashCommand | undefined {
    const { results, selectedIndex } = this.state;
    return results[selectedIndex]?.command;
  }

  /** Reset autocomplete to inactive state. */
  reset(): void {
    this.state = {
      active: false,
      query: '',
      results: [],
      selectedIndex: 0,
    };
  }

  /** Read-only snapshot of current state. */
  getState(): Readonly<AutocompleteState> {
    return this.state;
  }

  /**
   * isActive - True when the dropdown should be shown.
   */
  get isActive(): boolean {
    return this.state.active && this.state.results.length > 0;
  }
}
