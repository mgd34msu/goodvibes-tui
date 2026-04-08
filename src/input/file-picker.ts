import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { getWorkingDirectory } from '../config/index.ts';

/**
 * FilePickerModal - Fuzzy file finder triggered by @ in the input area.
 * Walks the project directory, fuzzy-matches against the query,
 * and lets the user select a file to insert its path.
 */
export class FilePickerModal {
  public active = false;
  public query = '';
  public searchFocused = true;
  public results: string[] = [];
  public selectedIndex = 0;
  /** Position in the prompt where @ was typed — used to replace @query with the selected path */
  public insertPos = 0;
  /** When true, selected file inserts as !@path (inject mode) instead of @path */
  public injectMode = false;

  public allFiles: string[] = [];
  private filesCached = false;
  

  private onUpdate: (() => void) | null = null;

  /** Set a callback to trigger re-render when file list loads. */
  setOnUpdate(fn: () => void): void {
    this.onUpdate = fn;
  }

  /** Activate the file picker at the given prompt position. */
  open(insertPos: number, injectMode = false): void {
    this.active = true;
    this.query = '';
    this.searchFocused = true;
    this.selectedIndex = 0;
    this.insertPos = insertPos;
    this.injectMode = injectMode;

    if (this.filesCached) {
      this.updateResults();
    } else {
      // Show "Loading..." immediately, load files in background
      this.results = [];
      this.loadFiles().then(() => {
        if (this.active) {
          this.updateResults();
          this.onUpdate?.();
        }
      });
    }
  }

  /** Close the file picker without selecting. */
  close(): void {
    this.active = false;
    this.query = '';
    this.searchFocused = true;
    this.results = [];
    this.selectedIndex = 0;
    this.injectMode = false;
  }

  /** Update the search query and re-filter results. */
  setQuery(q: string): void {
    this.query = q;
    this.selectedIndex = 0;
    this.updateResults();
  }

  canFocusSearch(): boolean {
    return true;
  }

  focusSearch(): void {
    this.searchFocused = true;
  }

  blurSearch(): void {
    this.searchFocused = false;
  }

  /** Move selection up. */
  moveUp(): void {
    if (this.selectedIndex > 0) this.selectedIndex--;
  }

  /** Move selection down. */
  moveDown(): void {
    if (this.selectedIndex < this.results.length - 1) this.selectedIndex++;
  }

  /** Get the currently selected file path, or null if none. */
  getSelected(): string | null {
    if (this.results.length === 0) return null;
    return this.results[this.selectedIndex] ?? null;
  }

  /** Fuzzy match: does the query match the candidate? */
  private fuzzyMatch(query: string, candidate: string): { match: boolean; score: number } {
    if (query.length === 0) return { match: true, score: 0 };
    const lowerQuery = query.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();

    // Substring match (highest priority)
    const subIdx = lowerCandidate.indexOf(lowerQuery);
    if (subIdx !== -1) {
      // Bonus for matching at start of filename (after last /)
      const lastSlash = lowerCandidate.lastIndexOf('/');
      const filenameStart = lastSlash + 1;
      const isFilenameMatch = subIdx >= filenameStart;
      return { match: true, score: isFilenameMatch ? 100 - subIdx : 50 - subIdx };
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

  private updateResults(): void {
    if (this.query.length === 0) {
      this.results = this.allFiles;
      return;
    }

    const scored = this.allFiles
      .map(f => ({ file: f, ...this.fuzzyMatch(this.query, f) }))
      .filter(r => r.match)
      .sort((a, b) => b.score - a.score)
      ;

    this.results = scored.map(r => r.file);
    if (this.selectedIndex >= this.results.length) {
      this.selectedIndex = Math.max(0, this.results.length - 1);
    }
  }

  private async loadFiles(): Promise<void> {
    const root = getWorkingDirectory();
    const files: string[] = [];
    await this.walkDir(root, files, 0);
    this.allFiles = files.sort();
    this.filesCached = true;
  }

  private async walkDir(dir: string, files: string[], depth: number): Promise<void> {
    if (depth > 8) return; // Limit depth
    if (files.length > 5000) return; // Limit total files

    let entries: import('node:fs').Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as import('node:fs').Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip hidden dirs, node_modules, dist, .git
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(getWorkingDirectory(), fullPath);

      if (entry.isDirectory()) {
        files.push(relPath + '/');
        await this.walkDir(fullPath, files, depth + 1);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }

  /** Invalidate the file cache (e.g., after file operations). */
  invalidateCache(): void {
    this.filesCached = false;
    this.allFiles = [];
  }
}
