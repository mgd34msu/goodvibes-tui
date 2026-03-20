// ---------------------------------------------------------------------------
// FileExplorerPanel — collapsible project tree view
// ---------------------------------------------------------------------------

import { readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DEPTH = 5;

/** Directories / files to skip (gitignore-style). */
const SKIP_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt', '.output',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  'coverage', '.nyc_output',
  '.DS_Store', 'Thumbs.db',
]);

const SKIP_PATTERNS: RegExp[] = [
  /^\..*\.sw[px]$/, // vim swap files
];

// ---------------------------------------------------------------------------
// File-type icons (single-char safe for TUI columns)
// ---------------------------------------------------------------------------
const EXT_ICONS: Record<string, string> = {
  ts: 'T', tsx: 'T', js: 'J', jsx: 'J',
  json: 'J', jsonc: 'J',
  md: 'M', mdx: 'M',
  css: 'S', scss: 'S', sass: 'S',
  html: 'H', htm: 'H',
  py: 'P', rb: 'R', go: 'G', rs: 'R',
  sh: '$', bash: '$', zsh: '$',
  yaml: 'Y', yml: 'Y', toml: 'C',
  lock: 'L', log: 'L',
};

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_ICONS[ext] ?? 'f';
}

// ---------------------------------------------------------------------------
// Tree node
// ---------------------------------------------------------------------------

interface TreeNode {
  path: string;       // absolute path
  name: string;       // display name
  isDir: boolean;
  depth: number;
  size: number;       // bytes (0 for dirs)
  expanded: boolean;
  children: TreeNode[];
  /** Whether children have been loaded. */
  loaded: boolean;
}

// ---------------------------------------------------------------------------
// Colour palette
// ---------------------------------------------------------------------------
const CLR_DIR      = '#00ffff'; // cyan — directories
const CLR_FILE     = '#e0e0e0'; // near-white — files
const CLR_SIZE     = '244';     // dim grey — sizes
const CLR_CURSOR   = '#1a2a3a'; // cursor background
const CLR_CURSOR_FG = '#ffffff';
const CLR_SEARCH_BG = '#2a1a3a';
const CLR_SEARCH_FG = '#ff79c6';
const CLR_TOGGLE   = '244';     // ▶/▼ toggle arrows
const CLR_ICON     = '244';     // file type icon

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldSkip(name: string): boolean {
  if (SKIP_NAMES.has(name)) return true;
  for (const re of SKIP_PATTERNS) if (re.test(name)) return true;
  return false;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/**
 * Write a string into a Line starting at `col`, applying a flat style.
 * Returns the column after the last written character.
 */
function writeStr(
  line: Line,
  text: string,
  col: number,
  width: number,
  style: Parameters<typeof createStyledCell>[1] = {},
): number {
  for (const ch of text) {
    if (col >= width) break;
    line[col++] = createStyledCell(ch, style);
  }
  return col;
}

// ---------------------------------------------------------------------------
// FileExplorerPanel
// ---------------------------------------------------------------------------

export class FileExplorerPanel extends BasePanel {
  // --- tree state ---
  private root: TreeNode | null = null;
  private flat: TreeNode[] = []; // visible flattened list
  private rootPath: string;
  private cacheValid: boolean = false;

  // --- navigation ---
  private cursor: number = 0;
  private scrollTop: number = 0;

  // --- search ---
  private searchMode: boolean = false;
  private searchQuery: string = '';

  constructor(rootPath?: string) {
    super('explorer', 'Explorer', 'E', 'development');
    this.rootPath = rootPath ?? process.cwd();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  override onActivate(): void {
    super.onActivate();
    if (!this.cacheValid) this._buildTree();
  }

  override onDestroy(): void {
    this.root = null;
    this.flat = [];
    this.cacheValid = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Force a full tree refresh from disk. */
  refresh(): void {
    this.cacheValid = false;
    this._buildTree();
    this.markDirty();
  }

  /** Currently focused node (or null). */
  getFocusedNode(): TreeNode | null {
    return this.flat[this.cursor] ?? null;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  handleInput(key: string): boolean {
    if (this.searchMode) return this._handleSearchInput(key);

    switch (key) {
      case 'up':    case 'k': this._moveCursor(-1); return true;
      case 'down':  case 'j': this._moveCursor(1);  return true;
      case 'pageup':          this._moveCursorPage(-1); return true;
      case 'pagedown':        this._moveCursorPage(1);  return true;
      case 'home': case 'g':  this._setCursor(0);   return true;
      case 'end':  case 'G':  this._setCursor(this.flat.length - 1); return true;
      case 'return': case 'enter': this._activateNode(); return true;
      case 'right': this._expandNode(); return true;
      case 'left':  this._collapseNode(); return true;
      case '/':     this._enterSearch(); return true;
      case 'r':     this.refresh(); return true;
      default:      return false;
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(width: number, height: number): Line[] {
    if (!this.cacheValid) this._buildTree();
    this.needsRender = false;

    const lines: Line[] = [];

    // ── Header row ───────────────────────────────────────────────────────────
    const headerLine = createEmptyLine(width);
    const headerLabel = this.searchMode
      ? `/ ${this.searchQuery}█`
      : ` Explorer  ${relative(process.cwd(), this.rootPath) || '.'}  [r]efresh`;
    writeStr(headerLine, headerLabel.slice(0, width), 0, width,
      this.searchMode
        ? { fg: CLR_SEARCH_FG, bg: CLR_SEARCH_BG, bold: true }
        : { fg: '#888888', dim: true });
    lines.push(headerLine);

    const viewHeight = height - 1; // reserve 1 row for header
    if (viewHeight <= 0) return lines;

    // ── Adjust scroll ────────────────────────────────────────────────────────
    this._clampScroll(viewHeight);

    const visible = this.flat.slice(this.scrollTop, this.scrollTop + viewHeight);

    for (let i = 0; i < viewHeight; i++) {
      const node = visible[i];
      const line = createEmptyLine(width);

      if (!node) {
        lines.push(line);
        continue;
      }

      const absoluteIdx = this.scrollTop + i;
      const isCursor = absoluteIdx === this.cursor;
      const baseBg = isCursor ? CLR_CURSOR : '';
      const baseFg = isCursor ? CLR_CURSOR_FG : (node.isDir ? CLR_DIR : CLR_FILE);

      let col = 0;

      // indent (2 spaces per depth level)
      const indent = '  '.repeat(node.depth);
      col = writeStr(line, indent, col, width, { fg: baseFg, bg: baseBg });

      if (node.isDir) {
        // toggle arrow
        const arrow = node.expanded ? '▼ ' : '▶ ';
        col = writeStr(line, arrow, col, width, { fg: CLR_TOGGLE, bg: baseBg, bold: isCursor });
      } else {
        // file type icon
        const icon = fileIcon(node.name) + ' ';
        col = writeStr(line, icon, col, width, { fg: CLR_ICON, bg: baseBg, dim: !isCursor });
      }

      // name
      col = writeStr(line, node.name, col, width, {
        fg: baseFg,
        bg: baseBg,
        bold: node.isDir || isCursor,
      });

      // file size (right-aligned, only for files)
      if (!node.isDir && node.size > 0) {
        const sizeStr = ` ${formatSize(node.size)}`;
        const sizeStart = Math.max(col + 1, width - sizeStr.length);
        if (sizeStart + sizeStr.length <= width) {
          writeStr(line, sizeStr, sizeStart, width, { fg: CLR_SIZE, bg: baseBg, dim: true });
        }
      }

      lines.push(line);
    }

    return lines;
  }

  // ── Private: tree building ─────────────────────────────────────────────────

  private _buildTree(): void {
    this.root = this._scanDir(this.rootPath, 0);
    this._rebuildFlat();
    this.cacheValid = true;
    this.markDirty();
  }

  private _scanDir(dirPath: string, depth: number): TreeNode {
    const name = basename(dirPath);
    const node: TreeNode = {
      path: dirPath,
      name,
      isDir: true,
      depth,
      size: 0,
      expanded: depth === 0, // root starts expanded
      children: [],
      loaded: false,
    };

    if (depth >= MAX_DEPTH) return node;

    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return node;
    }

    node.loaded = true;

    // Sort: dirs first, then files, alphabetically within each group
    const sorted = entries
      .filter(e => !shouldSkip(e))
      .sort((a, b) => {
        let aIsDir = false;
        let bIsDir = false;
        try { aIsDir = statSync(join(dirPath, a)).isDirectory(); } catch { /* ignore */ }
        try { bIsDir = statSync(join(dirPath, b)).isDirectory(); } catch { /* ignore */ }
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.localeCompare(b);
      });

    for (const entry of sorted) {
      const fullPath = join(dirPath, entry);
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }

      if (stat.isDirectory()) {
        node.children.push(this._scanDir(fullPath, depth + 1));
      } else {
        node.children.push({
          path: fullPath,
          name: entry,
          isDir: false,
          depth: depth + 1,
          size: stat.size,
          expanded: false,
          children: [],
          loaded: true,
        });
      }
    }

    return node;
  }

  /**
   * Flatten the tree into a visible list based on expansion state
   * and the current search query.
   */
  private _rebuildFlat(): void {
    const q = this.searchQuery.trim().toLowerCase();

    if (q) {
      // In search mode: show all matching nodes (any depth), ignoring expand state
      const results: TreeNode[] = [];
      this._collectMatching(this.root, q, results);
      this.flat = results;
    } else {
      const rows: TreeNode[] = [];
      if (this.root) this._flatten(this.root, rows, /* skipSelf */ true);
      this.flat = rows;
    }

    // Clamp cursor
    if (this.cursor >= this.flat.length) {
      this.cursor = Math.max(0, this.flat.length - 1);
    }
  }

  private _flatten(node: TreeNode, out: TreeNode[], skipSelf: boolean): void {
    if (!skipSelf) out.push(node);
    if ((skipSelf || node.expanded) && node.children.length > 0) {
      for (const child of node.children) {
        this._flatten(child, out, false);
      }
    }
  }

  private _collectMatching(node: TreeNode | null, q: string, out: TreeNode[]): void {
    if (!node) return;
    if (node.name.toLowerCase().includes(q)) out.push(node);
    for (const child of node.children) this._collectMatching(child, q, out);
  }

  // ── Private: navigation ───────────────────────────────────────────────────

  private _moveCursor(delta: number): void {
    this._setCursor(this.cursor + delta);
  }

  private _moveCursorPage(direction: 1 | -1, pageSize = 10): void {
    this._setCursor(this.cursor + direction * pageSize);
  }

  private _setCursor(idx: number): void {
    this.cursor = Math.max(0, Math.min(idx, this.flat.length - 1));
    this.markDirty();
  }

  private _clampScroll(viewHeight: number): void {
    if (this.cursor < this.scrollTop) {
      this.scrollTop = this.cursor;
    } else if (this.cursor >= this.scrollTop + viewHeight) {
      this.scrollTop = this.cursor - viewHeight + 1;
    }
    this.scrollTop = Math.max(0, this.scrollTop);
  }

  private _activateNode(): void {
    const node = this.flat[this.cursor];
    if (!node) return;
    if (node.isDir) {
      node.expanded = !node.expanded;
      this._rebuildFlat();
      this.markDirty();
    }
    // For files: callers can read getFocusedNode() after the input returns true
  }

  private _expandNode(): void {
    const node = this.flat[this.cursor];
    if (!node || !node.isDir || node.expanded) return;
    node.expanded = true;
    this._rebuildFlat();
    this.markDirty();
  }

  private _collapseNode(): void {
    const node = this.flat[this.cursor];
    if (!node) return;
    if (node.isDir && node.expanded) {
      node.expanded = false;
      this._rebuildFlat();
      this.markDirty();
    } else if (!node.isDir || !node.expanded) {
      // Jump to parent dir
      const parent = this._findParent(node);
      if (parent) {
        const idx = this.flat.indexOf(parent);
        if (idx >= 0) this._setCursor(idx);
      }
    }
  }

  private _findParent(node: TreeNode): TreeNode | null {
    return this._findParentIn(this.root, node);
  }

  private _findParentIn(candidate: TreeNode | null, target: TreeNode): TreeNode | null {
    if (!candidate) return null;
    for (const child of candidate.children) {
      if (child === target) return candidate;
      const found = this._findParentIn(child, target);
      if (found) return found;
    }
    return null;
  }

  // ── Private: search ───────────────────────────────────────────────────────

  private _enterSearch(): void {
    this.searchMode = true;
    this.searchQuery = '';
    this._rebuildFlat();
    this.markDirty();
  }

  private _handleSearchInput(key: string): boolean {
    if (key === 'escape') {
      this.searchMode = false;
      this.searchQuery = '';
      this._rebuildFlat();
      this.markDirty();
      return true;
    }
    if (key === 'return' || key === 'enter') {
      // Confirm search, stay in results, exit search-input mode
      this.searchMode = false;
      this.markDirty();
      return true;
    }
    if (key === 'delete' || key === 'backspace') {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this._rebuildFlat();
      this.markDirty();
      return true;
    }
    // Printable single characters
    if (key.length === 1) {
      this.searchQuery += key;
      this._rebuildFlat();
      this.markDirty();
      return true;
    }
    // Navigation still works during search
    if (key === 'up' || key === 'k') { this._moveCursor(-1); return true; }
    if (key === 'down' || key === 'j') { this._moveCursor(1); return true; }
    return false;
  }
}
