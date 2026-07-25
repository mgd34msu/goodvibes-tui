/**
 * conversation-search-expansion.ts — tracks which collapse keys transcript
 * search auto-expanded so they can be restored on search close, unless the
 * user explicitly acted on the block while it was open.
 *
 * Extracted from conversation.ts to keep that file under the architecture
 * line-count gate. restoreOnto() applies restoration through a structural
 * `{ setCollapsed }` shape (ConversationManager's own public setCollapsed())
 * rather than importing ConversationManager itself, so this module has no
 * import-cycle back to conversation.ts.
 *
 * The contract (see SearchManager.revealCurrentMatch and .close in
 * search.ts): a single keystroke in the search field must never expand
 * collapsed content — only navigating TO a match hidden inside it does, and
 * that expansion is undone when search closes UNLESS the user separately
 * touched the block (toggled, copied, bookmarked, saved, or bulk-expanded
 * via /expand) while it sat auto-expanded. An explicit user action always
 * wins over search's own bookkeeping, regardless of which happened first.
 */

/** Structural shape restoreOnto() needs — matches ConversationManager's own
 *  public setCollapsed() without importing the class (avoids a cycle). */
export interface CollapseSettable {
  setCollapsed(collapseKey: string, collapsed: boolean): void;
}

export class SearchExpansionTracker {
  /**
   * Collapse keys currently expanded because the user navigated to a search
   * match hidden inside them. Never contains a key the user has touched
   * explicitly — noteUserTouch() removes it on the way in.
   */
  private searchExpandedKeys = new Set<string>();

  /**
   * Collapse keys the user has explicitly acted on at least once. Growth is
   * unbounded for the life of the conversation — membership only ever gates
   * one decision (whether restoreSearchExpansions() may re-collapse a key),
   * so a stale positive is harmless and pruning would add complexity for no
   * behavioral gain.
   */
  private userTouchedKeys = new Set<string>();

  /** Record that `collapseKey` was expanded because the user navigated to a
   *  search match hidden inside it. No-op for a key the user already
   *  touched explicitly, since that ownership always wins. */
  markSearchExpanded(collapseKey: string): void {
    if (!this.userTouchedKeys.has(collapseKey)) this.searchExpandedKeys.add(collapseKey);
  }

  /** Record an explicit user action on `collapseKey` (toggle/copy/bookmark/
   *  save/bulk-expand). Exempts it from restoreSearchExpansions()'s
   *  auto-re-collapse for the rest of the session. */
  noteUserTouch(collapseKey: string): void {
    this.userTouchedKeys.add(collapseKey);
    this.searchExpandedKeys.delete(collapseKey);
  }

  /** Re-collapse every key search auto-expanded and not since user-touched,
   *  through `conversationManager`'s public setCollapsed() — called from
   *  SearchManager.close() to restore pre-search collapse state. */
  restoreOnto(conversationManager: CollapseSettable): void {
    const keys = [...this.searchExpandedKeys];
    this.searchExpandedKeys.clear();
    for (const key of keys) conversationManager.setCollapsed(key, true);
  }
}
