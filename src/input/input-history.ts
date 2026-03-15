import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.ts';

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
export class InputHistory {
  private entries: string[] = [];
  private position = -1;  // -1 = not browsing
  private draft = '';     // Saves current input when entering history
  private maxEntries = 500;
  private historyPath: string;
  private persist: boolean;

  constructor(persistPath?: string, persist = true) {
    this.persist = persist;
    const newDefault = join(homedir(), '.goodvibes', 'tui', 'input-history.json');
    const oldDefault = join(homedir(), '.config', 'goodvibes', 'input-history.json');
    // Auto-migrate: copy old path to new path if old exists and new doesn't
    if (existsSync(oldDefault) && !existsSync(newDefault)) {
      mkdirSync(dirname(newDefault), { recursive: true });
      try {
        copyFileSync(oldDefault, newDefault);
      } catch (_err) {
        // Non-fatal: proceed with new path regardless
      }
    }
    this.historyPath = persistPath ?? newDefault;
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
  add(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Dedup: skip if same as most recent entry
    if (this.entries.length > 0 && this.entries[0] === trimmed) {
      this.resetPosition();
      return;
    }

    this.entries.unshift(trimmed);
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
      if (!this.entries[next].includes('\n')) {
        this.position = next;
        return this.entries[this.position];
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
      if (!this.entries[prev].includes('\n')) {
        this.position = prev;
        return this.entries[this.position];
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
   * Save history to disk.
   */
  save(): void {
    try {
      mkdirSync(dirname(this.historyPath), { recursive: true });
      writeFileSync(this.historyPath, JSON.stringify(this.entries), 'utf-8');
    } catch (err) {
      logger.debug('InputHistory save failed (non-fatal)', { error: String(err) });
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
          this.entries = (parsed as unknown[]).filter((e): e is string => typeof e === 'string').slice(0, this.maxEntries);
        }
      }
    } catch (err) {
      logger.debug('InputHistory load failed (non-fatal, using empty history)', { error: String(err) });
      this.entries = [];
    }
  }
}
