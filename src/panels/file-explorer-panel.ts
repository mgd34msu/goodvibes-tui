// ---------------------------------------------------------------------------
// FileExplorerPanel — collapsible project tree view
// ---------------------------------------------------------------------------

import { promises as fsPromises } from 'node:fs';
import { join, relative, basename } from 'node:path';
import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildSearchInputLine,
  buildSelectablePanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';

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

// ---------------------------------------------------------------------------
// FileExplorerPanel
// ---------------------------------------------------------------------------

export class FileExplorerPanel extends BasePanel {
  // --- tree state ---
  private root: TreeNode | null = null;
  private flat: TreeNode[] = []; // visible flattened list
  private rootPath: string;
  private readonly workingDirectory: string;
  private cacheValid: boolean = false;
  private readyPromise: Promise<void> | null = null;

  // --- navigation ---
  private cursor: number = 0;
  private scrollTop: number = 0;

  // --- search ---
  private searchMode: boolean = false;
  private searchQuery: string = '';

  constructor(rootPath: string | undefined, workingDirectory: string) {
    super('explorer', 'Explorer', 'E', 'development');
    this.workingDirectory = workingDirectory;
    this.rootPath = rootPath ?? workingDirectory;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  override onActivate(): void {
    super.onActivate();
    if (!this.cacheValid) {
      void this._buildTreeAsync();
    }
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
    void this._buildTreeAsync();
  }

  /** Currently focused node (or null). */
  getFocusedNode(): TreeNode | null {
    return this.flat[this.cursor] ?? null;
  }

  getFocusedFilePath(): string | null {
    const node = this.getFocusedNode();
    return node && !node.isDir ? node.path : null;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  handleInput(key: string): boolean {
    if (this.searchMode) return this._handleSearchInput(key);

    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.cursor, itemCount: this.flat.length });
    if (transition === 'focus-search') {
      this._enterSearch();
      return true;
    }

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
    this.needsRender = false;
    const searchLine = this.searchMode
      ? `/ ${this.searchQuery}_`
      : this.searchQuery
        ? `Filter: ${this.searchQuery}  (/ or up at top to edit)`
        : `Root: ${relative(this.workingDirectory, this.rootPath) || '.'}  (/ or up at top to search)`;

    if (this.flat.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Explorer',
        intro: 'Browse the project tree, expand directories, and search for paths.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' No files found',
              this.searchQuery
                ? 'No files or directories match the current search.'
                : 'This root did not produce any visible files after the explorer filters were applied.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        footerLines: [
          buildSearchInputLine(width, '', searchLine, DEFAULT_PANEL_PALETTE, {
            active: this.searchMode,
            valueColor: this.searchMode ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim,
          }),
          buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter/Right', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim], ['   Left', DEFAULT_PANEL_PALETTE.info], [' collapse', DEFAULT_PANEL_PALETTE.dim], ['   /', DEFAULT_PANEL_PALETTE.info], [' search', DEFAULT_PANEL_PALETTE.dim], ['   r', DEFAULT_PANEL_PALETTE.info], [' refresh', DEFAULT_PANEL_PALETTE.dim]]),
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const summarySection = {
      title: 'Summary',
      lines: [
        buildPanelLine(width, [
          [' Visible ', DEFAULT_PANEL_PALETTE.label],
          [String(this.flat.length), DEFAULT_PANEL_PALETTE.value],
          ['   Search ', DEFAULT_PANEL_PALETTE.label],
          [this.searchQuery || 'none', this.searchQuery ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim],
        ]),
      ],
    } as const;
    const selected = this.flat[this.cursor];
    const selectedSection = {
      title: 'Selected',
      lines: selected
        ? [
            buildPanelLine(width, [
              [' Name ', DEFAULT_PANEL_PALETTE.label],
              [selected.name, DEFAULT_PANEL_PALETTE.value],
              ['   Type ', DEFAULT_PANEL_PALETTE.label],
              [selected.isDir ? 'directory' : 'file', selected.isDir ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.value],
            ]),
            buildPanelLine(width, [
              [' Path ', DEFAULT_PANEL_PALETTE.label],
              [selected.path, DEFAULT_PANEL_PALETTE.dim],
            ]),
          ]
        : [],
    } as const;
    const treeSection = resolveScrollablePanelSection(width, height, {
      intro: 'Browse the project tree, expand directories, and search for paths.',
      footerLines: [
        buildSearchInputLine(width, '', searchLine, DEFAULT_PANEL_PALETTE, {
          active: this.searchMode,
          valueColor: this.searchMode ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim,
        }),
        buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter/Right', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim], ['   Left', DEFAULT_PANEL_PALETTE.info], [' collapse', DEFAULT_PANEL_PALETTE.dim], ['   /', DEFAULT_PANEL_PALETTE.info], [' search', DEFAULT_PANEL_PALETTE.dim], ['   r', DEFAULT_PANEL_PALETTE.info], [' refresh', DEFAULT_PANEL_PALETTE.dim]]),
      ],
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summarySection],
      section: {
        title: 'Tree',
        scrollableLines: this.flat.map((node, absoluteIdx) => {
          const isCursor = absoluteIdx === this.cursor;
          const baseBg = isCursor ? CLR_CURSOR : '';
          const baseFg = isCursor ? CLR_CURSOR_FG : (node.isDir ? CLR_DIR : CLR_FILE);
          const indent = '  '.repeat(node.depth);
          const segments = [
            { text: indent, fg: baseFg },
            node.isDir
              ? { text: node.expanded ? '▾ ' : '▸ ', fg: CLR_TOGGLE, bold: isCursor }
              : { text: `${fileIcon(node.name)} `, fg: CLR_ICON, dim: !isCursor },
            { text: node.name, fg: baseFg, bold: node.isDir || isCursor },
          ];
          if (!node.isDir && node.size > 0) {
            const sizeStr = ` ${formatSize(node.size)}`;
            const contentWidth = getDisplayWidth(indent) + 2 + getDisplayWidth(node.name);
            const gap = Math.max(1, width - contentWidth - getDisplayWidth(sizeStr));
            segments.push({ text: ' '.repeat(gap), fg: baseFg });
            segments.push({ text: sizeStr, fg: CLR_SIZE, dim: true });
          }
          return buildSelectablePanelLine(width, segments, { selected: isCursor, selectedBg: baseBg, fillFg: baseFg });
        }),
        selectedIndex: this.cursor,
        scrollOffset: this.scrollTop,
        minRows: 8,
      },
      afterSections: [selectedSection],
    });
    this.scrollTop = treeSection.scrollOffset;
    return buildPanelWorkspace(width, height, {
      title: ' Explorer',
      intro: 'Browse the project tree, expand directories, and search for paths.',
      sections: [
        summarySection,
        treeSection.section,
        selectedSection,
      ],
      footerLines: [
        buildSearchInputLine(width, '', searchLine, DEFAULT_PANEL_PALETTE, {
          active: this.searchMode,
          valueColor: this.searchMode ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim,
        }),
        buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter/Right', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim], ['   Left', DEFAULT_PANEL_PALETTE.info], [' collapse', DEFAULT_PANEL_PALETTE.dim], ['   /', DEFAULT_PANEL_PALETTE.info], [' search', DEFAULT_PANEL_PALETTE.dim], ['   r', DEFAULT_PANEL_PALETTE.info], [' refresh', DEFAULT_PANEL_PALETTE.dim]]),
      ],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  // ── Private: tree building ─────────────────────────────────────────────────

  private _buildTreeAsync(): Promise<void> {
    const p = (async () => {
      try {
        await this.withLoading('Scanning directory\u2026', async () => {
          this.root = await this._scanDirAsync(this.rootPath, 0);
          this._rebuildFlat();
          this.cacheValid = true;
        });
      } catch (err) {
        this.setError(err instanceof Error ? err.message : String(err));
      }
      this.markDirty();
    })();
    this.readyPromise = p;
    return p;
  }

  /** Resolves when the current tree build has settled. */
  public awaitReady(): Promise<void> {
    return this.readyPromise ?? Promise.resolve();
  }

  private async _scanDirAsync(dirPath: string, depth: number): Promise<TreeNode> {
    const name = basename(dirPath);
    const node: TreeNode = {
      path: dirPath,
      name,
      isDir: true,
      depth,
      size: 0,
      expanded: depth === 0,
      children: [],
      loaded: false,
    };

    if (depth >= MAX_DEPTH) return node;

    let entries: string[];
    try {
      entries = await fsPromises.readdir(dirPath);
    } catch {
      return node;
    }

    node.loaded = true;

    // Sort: dirs first, then files, alphabetically within each group
    const filtered = entries.filter(e => !shouldSkip(e));
    const statResults = await Promise.all(
      filtered.map(async (e) => {
        try {
          const s = await fsPromises.stat(join(dirPath, e));
          return { name: e, isDir: s.isDirectory(), size: s.size, stat: s };
        } catch {
          return { name: e, isDir: false, size: 0, stat: null };
        }
      }),
    );

    const sorted = statResults.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted) {
      if (entry.stat === null) continue;
      const fullPath = join(dirPath, entry.name);
      if (entry.isDir) {
        node.children.push(await this._scanDirAsync(fullPath, depth + 1));
      } else {
        node.children.push({
          path: fullPath,
          name: entry.name,
          isDir: false,
          depth: depth + 1,
          size: entry.size,
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
    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.cursor, itemCount: this.flat.length });
    if (transition === 'focus-list') {
      this.searchMode = false;
      this.cursor = 0;
      this.scrollTop = 0;
      this.markDirty();
      return true;
    }
    if (isPanelSearchCancel(key)) {
      this.searchMode = false;
      this.searchQuery = '';
      this._rebuildFlat();
      this.markDirty();
      return true;
    }
    if (isPanelSearchCommit(key)) {
      // Confirm search, stay in results, exit search-input mode
      this.searchMode = false;
      this.markDirty();
      return true;
    }
    if (isPanelSearchBackspace(key)) {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this._rebuildFlat();
      this.markDirty();
      return true;
    }
    // Printable single characters
    if (isPanelSearchPrintable(key)) {
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
