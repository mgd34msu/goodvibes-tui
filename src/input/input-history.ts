import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/**
 * InputHistory — Persisted command history with arrow-key navigation.
 *
 * Navigation model:
 *   position = -1   : not browsing (at the live draft)
 *   position = 0    : most recent entry
 *   position = N-1  : oldest visible entry
 *
 * Up arrow goes to older entries (position increases).
 * Down arrow goes to newer entries (position decreases), then back to draft.
 */
export interface HistorySearchMatch {
  entry: string;
  matchStart: number;
  matchLength: number;
}

export class HistorySearch {
  active = false;
  query = '';
  matches: HistorySearchMatch[] = [];
  matchIndex = 0;
  savedDraft = '';

  constructor(private getEntries: () => readonly string[]) {}

  open(draft: string): void {
    this.active = true;
    this.savedDraft = draft;
    this.query = '';
    this.matches = [];
    this.matchIndex = 0;
  }

  search(query: string): void {
    this.query = query;
    const q = query.toLowerCase();
    this.matches = [];
    if (!q) return;
    for (const entry of this.getEntries()) {
      const idx = entry.toLowerCase().indexOf(q);
      if (idx >= 0) {
        this.matches.push({ entry, matchStart: idx, matchLength: q.length });
      }
    }
    this.matchIndex = 0;
  }

  appendChar(ch: string): void {
    this.search(this.query + ch);
  }

  deleteChar(): void {
    if (this.query.length > 0) {
      this.search(this.query.slice(0, -1));
    }
  }

  /** Move to next older match (higher index). */
  stepOlder(): void {
    if (this.matches.length > 0 && this.matchIndex < this.matches.length - 1) {
      this.matchIndex++;
    }
  }

  /** Move to next newer match (lower index). */
  stepNewer(): void {
    if (this.matchIndex > 0) {
      this.matchIndex--;
    }
  }

  get currentMatch(): HistorySearchMatch | null {
    return this.matches[this.matchIndex] ?? null;
  }

  accept(): string {
    const match = this.currentMatch;
    this.close();
    return match?.entry ?? '';
  }

  cancel(): string {
    const draft = this.savedDraft;
    this.close();
    return draft;
  }

  private close(): void {
    this.active = false;
    this.query = '';
    this.matches = [];
    this.matchIndex = 0;
    this.savedDraft = '';
  }
}

export interface InputHistoryOptions {
  readonly historyPath?: string;
  readonly userRoot?: string;
  readonly homeDirectory?: string;
  readonly persist?: boolean;
}

type StoredInputHistoryEntry = string | {
  readonly text: string;
  readonly recallText?: string;
};

function resolveHistoryPath(options?: InputHistoryOptions): string {
  if (options?.historyPath) {
    return options.historyPath;
  }
  const userRoot = options?.userRoot ?? options?.homeDirectory;
  if (!userRoot) {
    throw new Error('InputHistory requires historyPath or an explicit userRoot/homeDirectory.');
  }
  return join(userRoot, '.goodvibes', 'tui', 'input-history.json');
}

export class InputHistory {
  private entries: StoredInputHistoryEntry[] = [];
  private position = -1;  // -1 = not browsing
  private draft = '';     // Saves current input when entering history
  private maxEntries = 500;
  private historyPath: string;
  private persist: boolean;

  constructor(options: InputHistoryOptions) {
    this.persist = options.persist ?? true;
    this.historyPath = resolveHistoryPath(options);
    if (this.persist) {
      this.load();
    }
  }

  /**
   * Add a new entry. Called on submit.
   * - Ignores empty/whitespace-only strings.
   * - Deduplicates consecutive identical entries.
   * - Resets browsing position.
   */
  add(text: string, options: { readonly recallText?: string } = {}): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const recallText = options.recallText?.trim();
    const entry: StoredInputHistoryEntry = recallText && recallText !== trimmed
      ? { text: trimmed, recallText }
      : trimmed;

    // Dedup: skip if same as most recent entry
    if (this.entries.length > 0 && this.sameEntry(this.entries[0]!, entry)) {
      this.resetPosition();
      return;
    }

    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }

    this.resetPosition();

    if (this.persist) {
      this.save();
    }
  }

  /**
   * Navigate up (older entry).
   * On first call, saves currentInput as draft.
   * Returns the entry to display, or null if at boundary.
   * Only single-line entries are returned (multiline stored but skipped).
   */
  up(currentInput: string): string | null {
    if (this.entries.length === 0) return null;

    // Save draft on first navigation
    if (this.position === -1) {
      this.draft = currentInput;
    }

    // Try to advance to an older single-line entry
    let next = this.position + 1;
    while (next < this.entries.length) {
      const entry = this.entries[next]!;
      if (!this.getDisplayText(entry).includes('\n')) {
        this.position = next;
        return this.getRecallText(this.entries[this.position]!);
      }
      next++;
    }

    // At oldest boundary
    return null;
  }

  /**
   * Navigate down (newer entry).
   * Returns newer entry, or draft when reaching the end.
   * Returns null if not currently browsing.
   */
  down(): string | null {
    if (this.position === -1) return null;

    // Try to find a newer single-line entry
    let prev = this.position - 1;
    while (prev >= 0) {
      const entry = this.entries[prev]!;
      if (!this.getDisplayText(entry).includes('\n')) {
        this.position = prev;
        return this.getRecallText(this.entries[this.position]!);
      }
      prev--;
    }

    // Back to draft
    this.position = -1;
    return this.draft;
  }

  /**
   * Reset browsing position. Called when user types new text.
   */
  resetPosition(): void {
    this.position = -1;
    this.draft = '';
  }

  /**
   * Whether currently browsing history.
   */
  get isBrowsing(): boolean {
    return this.position !== -1;
  }

  /**
   * Return entries as readonly for use by HistorySearch.
   */
  getEntries(): readonly string[] {
    return this.entries.map((entry) => this.getRecallText(entry));
  }

  /**
   * Save history to disk.
   */
  save(): void {
    try {
      mkdirSync(dirname(this.historyPath), { recursive: true });
      writeFileSync(this.historyPath, JSON.stringify(this.entries), 'utf-8');
    } catch (err) {
      logger.debug('InputHistory save failed (non-fatal)', { error: summarizeError(err) });
    }
  }

  /**
   * Load history from disk.
   */
  load(): void {
    try {
      if (existsSync(this.historyPath)) {
        const raw = readFileSync(this.historyPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          this.entries = (parsed as unknown[])
            .map((entry) => this.normalizeStoredEntry(entry))
            .filter((entry): entry is StoredInputHistoryEntry => entry !== null)
            .slice(0, this.maxEntries);
        }
      }
    } catch (err) {
      logger.debug('InputHistory load failed (non-fatal, using empty history)', { error: summarizeError(err) });
      this.entries = [];
    }
  }

  private getDisplayText(entry: StoredInputHistoryEntry): string {
    return typeof entry === 'string' ? entry : entry.text;
  }

  private getRecallText(entry: StoredInputHistoryEntry): string {
    return typeof entry === 'string' ? entry : entry.recallText ?? entry.text;
  }

  private sameEntry(a: StoredInputHistoryEntry, b: StoredInputHistoryEntry): boolean {
    return this.getDisplayText(a) === this.getDisplayText(b)
      && this.getRecallText(a) === this.getRecallText(b);
  }

  private normalizeStoredEntry(entry: unknown): StoredInputHistoryEntry | null {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== 'string') return null;
    const text = record.text.trim();
    if (!text) return null;
    if (typeof record.recallText === 'string' && record.recallText.trim() && record.recallText.trim() !== text) {
      return { text, recallText: record.recallText.trim() };
    }
    return text;
  }
}
