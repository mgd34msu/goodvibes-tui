/**
 * selected-index-rule.ts, panel selection-safety architecture-gate rule.
 *
 * Bans the raw token `[this.selectedIndex]` in src/panels/**\/*.ts.
 *
 * Four real bugs shipped because an action key or detail block indexed a RAW
 * item array (`this.rows`, `this.entries`, `getItems()`, a mode-specific
 * array, …) with `this.selectedIndex`, while navigation moves `selectedIndex`
 * over the FILTERED `getVisibleItems()`. When a filter is active the raw index
 * points at the wrong row. To make that class of bug structurally impossible,
 * panel code must read the selected row through `getSelectedItem()` (the
 * ScrollableListPanel accessor that indexes `getVisibleItems()`), through a
 * function-scope `const visible = this.getVisibleItems()` local, or, for
 * bespoke panels with their own selection state, through a single private
 * selected-item accessor.
 *
 * The base classes that OWN list navigation (scrollable-list-panel.ts,
 * expandable-list-panel.ts) legitimately index their internal cursor over the
 * visible list and are the only files exempt from the ban. Any bespoke panel
 * that genuinely needs its own indexing site should either write its private
 * accessor without the literal token (e.g. `rows.at(this.selectedIndex)`) or,
 * as a last resort, be added to the exempt list with a justifying comment.
 * Prefer zero panel exemptions.
 */

/** The exact token this rule bans outside the exempt base classes. */
export const SELECTED_INDEX_TOKEN = '[this.selectedIndex]';

/**
 * Base-class files that own list-cursor navigation and legitimately index the
 * visible list by `this.selectedIndex`. Keep this list minimal, prefer
 * converting bespoke panels (step 2 of the panel-selection hardening) over
 * adding entries here. Each entry must carry a justifying comment.
 */
export const SELECTED_INDEX_EXEMPT: ReadonlySet<string> = new Set([
  // Owns the shared list cursor; getSelectedItem()/handleInput index the
  // visible list here so every subclass inherits the safe read.
  'src/panels/scrollable-list-panel.ts',
  // Extends ScrollableListPanel; expandSelected() indexes the visible list to
  // open the detail view for the cursor row.
  'src/panels/expandable-list-panel.ts',
]);

/** Whether a repo-relative path falls under the selected-index ban's scope. */
export function isSelectedIndexRuleTarget(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/');
  return (
    normalized.startsWith('src/panels/') &&
    normalized.endsWith('.ts') &&
    !SELECTED_INDEX_EXEMPT.has(normalized)
  );
}

/** Count occurrences of the raw `[this.selectedIndex]` token in a file's source. */
export function countSelectedIndexReads(text: string): number {
  let count = 0;
  let idx = text.indexOf(SELECTED_INDEX_TOKEN);
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf(SELECTED_INDEX_TOKEN, idx + SELECTED_INDEX_TOKEN.length);
  }
  return count;
}

export interface SelectedIndexCandidate {
  readonly relPath: string;
  readonly text: string;
}

/**
 * Enforce the selected-index ban across a set of candidate panel files.
 * Returns one violation message per non-exempt panel file that contains the
 * raw `[this.selectedIndex]` token.
 */
export function checkSelectedIndexReads(
  files: readonly SelectedIndexCandidate[],
): string[] {
  const violations: string[] = [];
  for (const { relPath, text } of files) {
    if (!isSelectedIndexRuleTarget(relPath)) continue;
    const count = countSelectedIndexReads(text);
    if (count > 0) {
      violations.push(
        `${relPath}: raw [this.selectedIndex] read (${count}) indexes an item array by the list cursor; ` +
          `read the selected row via getSelectedItem() (or a const visible = this.getVisibleItems() local, ` +
          `or a single private selected-item accessor) so filtered lists stay correct [no-raw-selectedindex-read]`,
      );
    }
  }
  return violations;
}
