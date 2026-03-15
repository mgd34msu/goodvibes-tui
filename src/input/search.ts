import type { InfiniteBuffer } from '../core/history.ts';

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
  public query = '';
  public matches: SearchMatch[] = [];
  public currentMatch = 0;

  /** Open search mode. */
  open(): void {
    this.active = true;
    this.query = '';
    this.matches = [];
    this.currentMatch = 0;
  }

  /** Close search mode. */
  close(): void {
    this.active = false;
  }

  /** Update query and find matches in the history buffer. */
  search(query: string, history: InfiniteBuffer): void {
    this.query = query;
    this.matches = [];
    this.currentMatch = 0;

    if (query.length === 0) return;

    const lowerQuery = query.toLowerCase();
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

  /** Jump to next match. */
  nextMatch(): void {
    if (this.matches.length === 0) return;
    this.currentMatch = (this.currentMatch + 1) % this.matches.length;
  }

  /** Jump to previous match. */
  prevMatch(): void {
    if (this.matches.length === 0) return;
    this.currentMatch = (this.currentMatch - 1 + this.matches.length) % this.matches.length;
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
