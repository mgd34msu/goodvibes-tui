import type { InfiniteBuffer } from '../core/history.ts';
import type { ConversationManager } from '../core/conversation';

export interface SearchMatch {
  line: number;
  col: number;
  length: number;
  /**
   * Present when this match lives inside content that is still collapsed —
   * `line`/`col` are placeholders (the containing block's own header line,
   * col 0) rather than a real navigable position. `collapseKeys` names every
   * collapse key that must be expanded to make the hit a real rendered
   * line; `primaryKey` is the specific key whose block range identifies
   * where the revealed match will land (see revealCurrentMatch).
   * Absent entirely for a match already visible in the rendered buffer.
   */
  collapseKeys?: readonly string[];
  primaryKey?: string;
}

/** Count non-overlapping occurrences of `needle` in `haystack` — used for
 *  the collapsed-content scan below, mirroring the per-line indexOf loop
 *  search() already runs over the rendered buffer, so a hidden hit counts
 *  the same way a visible one would once revealed. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let col = 0;
  while (col <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, col);
    if (idx === -1) break;
    count++;
    col = idx + 1;
  }
  return count;
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

  /**
   * Close search mode. Re-collapses every block/group search auto-expanded
   * while it was open — except ones the user explicitly acted on (toggled,
   * copied, bookmarked, saved) while they were expanded, which stay exactly
   * as the user left them (see SearchExpansionTracker.restoreOnto).
   * `conversationManager` is optional so existing call sites that never had
   * one (and therefore never auto-expanded anything) keep working unchanged.
   */
  close(conversationManager?: ConversationManager | null): void {
    conversationManager?.searchExpansion.restoreOnto(conversationManager);
    this.active = false;
    this.locked = false;
  }

  /**
   * Update query and find matches — honestly counting hits inside collapsed
   * blocks and folded tool-result groups WITHOUT expanding them. Expansion
   * only happens on navigation (see revealCurrentMatch): typing a query must
   * never collapse-destroy the transcript the user folded on purpose, but a
   * "no matches" while text the user watched stream by sits collapsed
   * somewhere would be a lie too — so the count includes it, tagged as
   * hidden until the user actually navigates there.
   *
   * That collapsed corpus is the block's own RAW content, plus — for a
   * folded tool-result group — the raw content of every one of its member
   * messages (a group's own rawContent is only its summary header line, and
   * its members push no BlockMeta of their own while folded — see
   * conversation-tool-groups.ts — so without the member corpus a needle
   * living inside a member would count as zero hits for text the user
   * watched stream by).
   *
   * Matches are built in one pass over `history.getAllLines()` combined with
   * one pass over collapsed blocks, then sorted into document order (by
   * rendered line, with a collapsed block's hidden hits keyed to its own
   * still-real header line) so that navigation lands on hits in the order
   * they actually appear in the transcript.
   */
  search(query: string, history: InfiniteBuffer, conversationManager?: ConversationManager | null): void {
    this.query = query;
    this.currentMatch = 0;
    this.wrapAround = false;

    if (query.length === 0) {
      this.matches = [];
      return;
    }

    this.matches = this.buildMatches(query, history, conversationManager);
  }

  /**
   * Shared match builder for search() and revealCurrentMatch() — scans the
   * currently-rendered buffer for visible matches and every collapsed
   * block/folded group for hidden ones, without mutating any collapse
   * state. Kept separate from search() so revealCurrentMatch can rebuild the
   * match list after an expansion without resetting currentMatch back to 0.
   */
  private buildMatches(query: string, history: InfiniteBuffer, conversationManager?: ConversationManager | null): SearchMatch[] {
    const lowerQuery = query.toLowerCase();
    const hiddenMatches: SearchMatch[] = [];

    if (conversationManager) {
      const registry = conversationManager.getBlockRegistry();

      for (const block of registry) {
        if (!conversationManager.isCollapsed(block.blockIndex)) continue;

        if (block.type === 'assistant_turn' && block.groupMemberIndexes) {
          // The header's own synthetic summary rarely matches, but count it
          // honestly too — expanding the whole group is the only way to even
          // attempt to reveal a header-corpus hit, since there is no single
          // member to isolate it to.
          const headerHits = countOccurrences(block.rawContent.toLowerCase(), lowerQuery);
          const allKeys = [block.collapseKey, ...block.groupMemberIndexes.map((idx) => `msg_${idx}`)];
          for (let i = 0; i < headerHits; i++) {
            hiddenMatches.push({
              line: block.startLine, col: 0, length: query.length,
              collapseKeys: allKeys, primaryKey: block.collapseKey,
            });
          }

          if (block.groupMemberIndexes.length > 0) {
            // Read in ONE snapshot pass: getMessageSnapshot() clones the
            // whole message array and search() runs on every keystroke, so a
            // per-member read would stall typing outright.
            const snapshot = conversationManager.getMessageSnapshot();
            for (const memberIdx of block.groupMemberIndexes) {
              const content = snapshot[memberIdx]?.content;
              if (typeof content !== 'string') continue;
              const memberKey = `msg_${memberIdx}`;
              const memberHits = countOccurrences(content.toLowerCase(), lowerQuery);
              for (let i = 0; i < memberHits; i++) {
                hiddenMatches.push({
                  line: block.startLine, col: 0, length: query.length,
                  // Revealing a member-specific hit only needs the group
                  // header (to unfold the group at all) and that member's own
                  // key — not its siblings, which stay exactly as they were.
                  collapseKeys: [block.collapseKey, memberKey], primaryKey: memberKey,
                });
              }
            }
          }
        } else {
          const hits = countOccurrences(block.rawContent.toLowerCase(), lowerQuery);
          for (let i = 0; i < hits; i++) {
            hiddenMatches.push({
              line: block.startLine, col: 0, length: query.length,
              collapseKeys: [block.collapseKey], primaryKey: block.collapseKey,
            });
          }
        }
      }
    }

    const visibleMatches: SearchMatch[] = [];
    const lines = history.getAllLines();
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const text = line.map(c => c.char).join('').toLowerCase();
      let col = 0;
      while (col <= text.length - lowerQuery.length) {
        const idx = text.indexOf(lowerQuery, col);
        if (idx === -1) break;
        visibleMatches.push({ line: lineIdx, col: idx, length: query.length });
        col = idx + 1;
      }
    }

    // Stable sort (V8/JSC have guaranteed stable Array#sort) puts each
    // block's hidden hits in the same relative order they were generated
    // in — self-corpus first, then members in order — right where that
    // block's header line falls among the visible matches.
    return [...visibleMatches, ...hiddenMatches].sort((a, b) => a.line - b.line || a.col - b.col);
  }

  /**
   * Reveal the current match if it lives inside collapsed content: expands
   * exactly the block (and, for a folded tool-result group member, its
   * containing group) needed to make the hit a real navigable line, marks
   * those keys as search-owned so close() can restore them, and rebuilds
   * the match list against the now-expanded buffer.
   *
   * `currentMatch` is repointed at the first now-visible match inside the
   * revealed block's new line range, rather than reset to 0 — expansion
   * only changes how many lines that ONE block renders as, so every match
   * belonging to earlier blocks keeps its relative position.
   *
   * No-op when the current match is already visible, or when no
   * conversationManager was supplied (nothing to expand against).
   */
  revealCurrentMatch(history: InfiniteBuffer, conversationManager?: ConversationManager | null): void {
    const match = this.matches[this.currentMatch];
    if (!match || !match.collapseKeys || match.collapseKeys.length === 0) return;
    if (!conversationManager) return;

    for (const key of match.collapseKeys) {
      conversationManager.setCollapsed(key, false);
      conversationManager.searchExpansion.markSearchExpanded(key);
    }
    // Flush so the registry read below reflects the newly-expanded content.
    conversationManager.getDisplayBlocks();

    const primaryKey = match.primaryKey ?? match.collapseKeys[match.collapseKeys.length - 1];
    const revealedBlock = conversationManager.getBlockRegistry().find((b) => b.collapseKey === primaryKey);

    this.matches = this.buildMatches(this.query, history, conversationManager);

    if (revealedBlock) {
      const idx = this.matches.findIndex((m) =>
        !m.collapseKeys
        && m.line >= revealedBlock.startLine
        && m.line < revealedBlock.startLine + revealedBlock.lineCount,
      );
      if (idx >= 0) {
        this.currentMatch = idx;
        return;
      }
    }
    // Fallback: keep the pointer in range rather than throwing if the exact
    // target couldn't be relocated.
    if (this.currentMatch >= this.matches.length) this.currentMatch = Math.max(0, this.matches.length - 1);
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

  /** Get the line number of the current match (for scroll). Returns -1 for a
   *  match that's still hidden inside collapsed content — revealCurrentMatch
   *  must run first to give it a real line. */
  getCurrentMatchLine(): number {
    if (this.matches.length === 0) return -1;
    const match = this.matches[this.currentMatch];
    if (!match) return -1;
    if (match.collapseKeys && match.collapseKeys.length > 0) return -1;
    return match.line;
  }

  /** Get matches on a given line. Hidden (still-collapsed) matches are
   *  excluded — they have no real line to render a highlight on yet. */
  getMatchesOnLine(lineIdx: number): SearchMatch[] {
    return this.matches.filter(m => m.line === lineIdx && !m.collapseKeys);
  }

  /** Is the current match on the given line at the given col? */
  isCurrentMatch(lineIdx: number, col: number): boolean {
    if (this.matches.length === 0) return false;
    const m = this.matches[this.currentMatch];
    return m !== undefined && !m.collapseKeys && m.line === lineIdx && m.col === col;
  }
}
