import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { logger } from '../utils/logger.ts';

/**
 * BookmarkEntry - Metadata for a saved bookmark.
 */
export interface BookmarkEntry {
  /** Stable collapse key identifying the block (e.g. 'msg_3_code_1'). */
  key: string;
  /** Human-readable label (block type + short excerpt). */
  label: string;
  /** Timestamp when bookmarked. */
  timestamp: number;
}

/**
 * BookmarkManager - Tracks bookmarked blocks and saves block content to disk.
 *
 * Bookmarks are stored in memory for the session. Saved block content is
 * written to ~/.goodvibes/tui/bookmarks/<timestamp>-<label>.txt.
 */
export class BookmarkManager {
  private bookmarks = new Map<string, BookmarkEntry>();
  private saveDir: string;

  constructor(baseDir: string) {
    this.saveDir = baseDir;
  }

  /**
   * toggle - Toggle bookmark state for a block key.
   * Returns the new state: true = bookmarked, false = removed.
   */
  public toggle(key: string, label?: string): boolean {
    if (this.bookmarks.has(key)) {
      this.bookmarks.delete(key);
      return false;
    } else {
      this.bookmarks.set(key, {
        key,
        label: label ?? key,
        timestamp: Date.now(),
      });
      return true;
    }
  }

  /**
   * isBookmarked - Check if a block key is bookmarked.
   */
  public isBookmarked(key: string): boolean {
    return this.bookmarks.has(key);
  }

  /**
   * list - Return all current bookmarks sorted by timestamp.
   */
  public list(): BookmarkEntry[] {
    return Array.from(this.bookmarks.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * clear - Remove all bookmarks.
   */
  public clear(): void {
    this.bookmarks.clear();
  }

  /**
   * saveToFile - Write block content to a file in the bookmarks directory.
   * Returns the file path on success, or throws on failure.
   */
  public saveToFile(content: string, label: string): string {
    mkdirSync(this.saveDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sanitizedLabel = label
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'block';
    const filename = `${timestamp}-${sanitizedLabel}.txt`;
    const filePath = join(this.saveDir, filename);
    writeFileSync(filePath, content, 'utf-8');
    logger.debug('BookmarkManager: saved block content', { filePath });
    return filePath;
  }

  /**
   * listSavedFiles - List all previously saved block content files.
   */
  public listSavedFiles(): string[] {
    if (!existsSync(this.saveDir)) return [];
    try {
      return readdirSync(this.saveDir)
        .filter(f => f.endsWith('.txt'))
        .map(f => join(this.saveDir, f))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * loadSavedFile - Read a previously saved block content file by name.
   */
  public loadSavedFile(name: string): string | null {
    const sanitized = name.endsWith('.txt') ? name : `${name}.txt`;
    const resolved = resolve(join(this.saveDir, sanitized));
    if (!resolved.startsWith(resolve(this.saveDir) + '/') && resolved !== resolve(this.saveDir)) {
      throw new Error('Invalid bookmark name');
    }
    const filePath = resolved;
    if (!existsSync(filePath)) return null;
    try {
      return readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
}
