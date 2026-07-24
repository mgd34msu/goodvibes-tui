import type { InfiniteBuffer } from '../core/history.ts';
import type { ConversationManager } from '../core/conversation';

export interface SearchMatch {
  line: number;
  col: number;
  length: number;
}

/**
 * SearchManager - Handles search-within-output state.
 * Tracks active query, matches, and current match navigation.
 */
export class SearchManager {
  public active = false;
  /** When true, the query is locked and arrow/comma/period navigate matches. */
  public locked = false;
  public query = '';
  public matches: SearchMatch[] = [];
  public currentMatch = 0;
  /**
   * Set to true when nextMatch/prevMatch wraps around the match list.
   * Cleared on each navigation call before the wrap check, so it only
   * reflects the most recent navigation step.
   */
  public wrapAround = false;

  /** Open search mode. */
  open(): void {
    this.active = true;
    this.locked = false;
    this.query = '';
    this.matches = [];
    this.currentMatch = 0;
    this.wrapAround = false;
  }

  /** Lock the query — switches from typing mode to navigation mode. */
  lock(): void {
    this.locked = true;
  }

  /** Unlock — return to typing mode. */
  unlock(): void {
    this.locked = false;
  }

  /** Close search mode. */
  close(): void {
    this.active = false;
    this.locked = false;
  }

  /**
   * Update query and find matches in the history buffer.
   *
   * A collapsed block (or folded tool-result group) renders 1-2 summary
   * lines, so scanning only the rendered buffer misses text the user watched
   * stream by before it folded. When `conversationManager` is provided, any
   * currently-collapsed block whose searchable corpus contains the query is
   * expanded first (never re-collapsed — a false "No matches" is a lie, an
   * extra expand is not), so the match becomes a real, navigable line in the
   * rendered buffer scanned below.
   *
   * That corpus is the block's own RAW content, plus — for a folded
   * tool-result group — the raw content of every one of its member messages.
   * A group's own rawContent is only its summary header line ("2 tool results
   * folded (read exec, 18 lines total)") and its members push no BlockMeta of
   * their own while folded (see conversation-tool-groups.ts), so without the
   * member corpus a needle living inside a member matches nothing at all and
   * the user gets "No matches" for text they watched stream by. Member text is
   * read off the message snapshot, and is the same string the renderer stores
   * as that member's own block rawContent once the group is expanded.
   *
   * A hit anywhere in that corpus expands the group's own collapseKey AND
   * every member's `msg_<idx>` key — expanding the header alone would leave
   * the member holding the hit invisible, and expanding all members keeps the
   * behavior identical whether the hit came from the header or a member.
   *
   * `getDisplayBlocks()` is flushed before the buffer is scanned, and the
   * overlay's match count is always derived from that same rendered scan, so
   * it never claims more than it can actually navigate to.
   */
  search(query: string, history: InfiniteBuffer, conversationManager?: ConversationManager | null): void {
    this.query = query;
    this.matches = [];
    this.currentMatch = 0;

    this.wrapAround = false;
    if (query.length === 0) return;

    const lowerQuery = query.toLowerCase();

    if (conversationManager) {
      const registry = conversationManager.getBlockRegistry();

      // A folded tool-result group's members render nothing and register no
      // BlockMeta while collapsed (see conversation-tool-groups.ts), so the
      // group's searchable corpus is its own header rawContent PLUS each
      // member's raw content — which only the message snapshot can supply,
      // since there is no member block to read it from.
      const memberIndexes: number[] = [];
      for (const block of registry) {
        if (block.type !== 'tool_group' || !block.groupMemberIndexes) continue;
        if (!conversationManager.isCollapsed(block.blockIndex)) continue;
        memberIndexes.push(...block.groupMemberIndexes);
      }

      // Read in ONE snapshot pass: getMessageSnapshot() clones the whole
      // message array (~0.8ms on a 900-message conversation) and search() runs
      // on every keystroke, so a per-member read would stall typing outright.
      // Skipped entirely when nothing is folded.
      const memberContent = new Map<number, string>();
      if (memberIndexes.length > 0) {
        const snapshot = conversationManager.getMessageSnapshot();
        for (const memberIdx of memberIndexes) {
          // This is the exact string the renderer stores as a member's own
          // block rawContent (renderConversationToolMessage in
          // conversation-rendering.ts) — the corpus is what expanding really
          // reveals, not a second notion of "content". A member index that
          // outlived its message (undo() splices the messages tail while a
          // stale registry still names it) reads back undefined and is simply
          // skipped rather than throwing.
          const content = snapshot[memberIdx]?.content;
          if (typeof content === 'string') memberContent.set(memberIdx, content.toLowerCase());
        }
      }

      let expandedAny = false;
      for (const block of registry) {
        if (!conversationManager.isCollapsed(block.blockIndex)) continue;
        const members = block.type === 'tool_group' ? (block.groupMemberIndexes ?? []) : [];
        const hit = block.rawContent.toLowerCase().includes(lowerQuery)
          || members.some((memberIdx) => (memberContent.get(memberIdx) ?? '').includes(lowerQuery));
        if (!hit) continue;
        conversationManager.setCollapsed(block.collapseKey, false);
        // Expanding just the group header would still hide each member's own
        // content — including the member the query actually matched — so open
        // every member's own collapse key in the same pass. Already-expanded
        // keys are unaffected; setting false over false is a no-op.
        for (const memberIdx of members) {
          conversationManager.setCollapsed(`msg_${memberIdx}`, false);
        }
        expandedAny = true;
      }
      if (expandedAny) {
        // Flush the pending re-render so `history` (the same buffer
        // instance) reflects the newly-expanded content before it's scanned
        // below — mirrors the existing getDisplayBlocks()-before-read idiom
        // used by jumpToBookmark/scrollToLine.
        conversationManager.getDisplayBlocks();
      }
    }

    const lines = history.getAllLines();

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      // Build text from cells
      const text = line.map(c => c.char).join('').toLowerCase();
      let col = 0;
      while (col <= text.length - lowerQuery.length) {
        const idx = text.indexOf(lowerQuery, col);
        if (idx === -1) break;
        this.matches.push({ line: lineIdx, col: idx, length: query.length });
        col = idx + 1;
      }
    }
  }

  /** Jump to next match. Wraps around; sets wrapAround when it does. */
  nextMatch(): void {
    if (this.matches.length === 0) { this.wrapAround = false; return; }
    const next = (this.currentMatch + 1) % this.matches.length;
    this.wrapAround = next < this.currentMatch || (this.currentMatch === this.matches.length - 1);
    this.currentMatch = next;
  }

  /** Jump to previous match. Wraps around; sets wrapAround when it does. */
  prevMatch(): void {
    if (this.matches.length === 0) { this.wrapAround = false; return; }
    const prev = (this.currentMatch - 1 + this.matches.length) % this.matches.length;
    this.wrapAround = prev > this.currentMatch || (this.currentMatch === 0);
    this.currentMatch = prev;
  }

  /** Get the line number of the current match (for scroll). */
  getCurrentMatchLine(): number {
    if (this.matches.length === 0) return -1;
    return this.matches[this.currentMatch]?.line ?? -1;
  }

  /** Get matches on a given line. */
  getMatchesOnLine(lineIdx: number): SearchMatch[] {
    return this.matches.filter(m => m.line === lineIdx);
  }

  /** Is the current match on the given line at the given col? */
  isCurrentMatch(lineIdx: number, col: number): boolean {
    if (this.matches.length === 0) return false;
    const m = this.matches[this.currentMatch];
    return m !== undefined && m.line === lineIdx && m.col === col;
  }
}
