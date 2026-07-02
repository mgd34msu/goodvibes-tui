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
  buildKeyboardHints,
  buildPanelLine,
  buildSearchInputLine,
  buildTreeRow,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
} from './polish.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  dirColor: '#00ffff',   // cyan — directories
  fileColor: '#e0e0e0',  // near-white — files
  sizeColor: '244',      // dim grey — sizes
  cursorBg: '#1a2a3a',   // cursor background
});

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

  // --- git status decorations ---
  // Reuse one GitService instance across refreshes (I2 pattern, git-panel.ts).
  private readonly git: GitService;
  /** absolute file path -> single-char status code (git-panel.ts:146-151 classification). */
  private gitStatus: Map<string, { code: string; tone: 'good' | 'warn' | 'bad' | 'dim' }> = new Map();

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
    this.git = new GitService(this.workingDirectory);
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
      case 'd':     return this.getFocusedFilePath() !== null;
      default:      return false;
    }
  }

  handleScroll(deltaRows: number): boolean {
    const rows = Math.trunc(deltaRows);
    if (this.flat.length === 0 || rows === 0) return false;
    const previous = this.cursor;
    this._setCursor(this.cursor + rows);
    return this.cursor !== previous;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(width: number, height: number): Line[] {
    this.needsRender = false;
    const searchLine = this.searchMode
      ? `/ ${this.searchQuery}_`
      : this.searchQuery
        ? `Filter: ${this.searchQuery}  (/ or up at top to edit)`
        : `Root: ${relative(this.workingDirectory, this.rootPath) || '.'}  (/ or up at top to search)`;

    // Context-aware hints: only surface keys that act in the current mode.
    const hintsLine = this.searchMode
      ? buildKeyboardHints(width, [
          { keys: 'type', label: 'filter' },
          { keys: '↑/↓', label: 'move' },
          { keys: 'Enter', label: 'keep results' },
          { keys: 'Esc', label: 'clear' },
        ], C)
      : buildKeyboardHints(width, [
          { keys: '↑/↓', label: 'navigate' },
          { keys: 'Enter/→', label: 'expand' },
          { keys: '←', label: 'collapse' },
          { keys: '/', label: 'search' },
          { keys: 'r', label: 'refresh' },
          { keys: 'd', label: 'diff' },
        ], C);

    if (this.flat.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Explorer',
        intro: 'Browse the project tree, expand directories, and search for paths.',
        sections: [
          {
            lines: buildEmptyState(width, ' No files found', this.searchQuery ? 'No files or directories match the current search.' : 'This root did not produce any visible files after the explorer filters were applied.', this.searchQuery ? [{ command: 'Esc', summary: 'clear the filter to show the full tree again' }] : [{ command: 'r', summary: 'rescan this root from disk' }], C),
          },
        ],
        footerLines: [
          buildSearchInputLine(width, '', searchLine, DEFAULT_PANEL_PALETTE, {
            active: this.searchMode,
            valueColor: this.searchMode ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim,
          }),
          hintsLine,
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
        hintsLine,
      ],
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summarySection],
      section: {
        title: 'Tree',
        scrollableLines: this.flat.map((node, absoluteIdx) => {
          const isCursor = absoluteIdx === this.cursor;
          return buildTreeRow(width, {
            depth: node.depth,
            label: node.name,
            icon: node.isDir ? undefined : fileIcon(node.name),
            expandable: node.isDir,
            expanded: node.expanded,
            labelColor: node.isDir ? C.dirColor : C.fileColor,
            metadata: this._buildRowMetadata(node),
          }, C, { selected: isCursor, selectedBg: C.cursorBg });
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
        hintsLine,
      ],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  // ── Private: tree building ─────────────────────────────────────────────────

  /**
   * Build (or rebuild) the tree root and load ONLY its immediate children.
   * Deeper directories stay unloaded (`loaded: false`, empty `children`)
   * until the user actually expands them via _expandNode()/_activateNode() \u2014
   * this replaces the old eager depth-5 recursive scan, which walked (and
   * silently truncated at a hardcoded depth cutoff) the entire visible tree
   * up front and blocked opening the panel on large repos.
   */
  private _buildTreeAsync(): Promise<void> {
    const p = (async () => {
      try {
        await this.withLoading('Scanning directory\u2026', async () => {
          const root: TreeNode = {
            path: this.rootPath,
            name: basename(this.rootPath) || this.rootPath,
            isDir: true,
            depth: 0,
            size: 0,
            expanded: true,
            children: [],
            loaded: false,
          };
          await this._loadChildren(root);
          this.root = root;
          this._rebuildFlat();
          this.cacheValid = true;
        });
        // Best-effort \u2014 a missing/failed git status just means no decorations.
        await this._loadGitStatus();
      } catch (err) {
        this.setError(summarizeError(err));
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

  /**
   * Read one directory's immediate entries and populate `node.children` with
   * fully-resolved file nodes and unloaded directory stubs. Idempotent and
   * safe to call on an already-loaded node (no-ops).
   */
  private async _loadChildren(node: TreeNode): Promise<void> {
    if (node.loaded || !node.isDir) return;

    let entries: string[];
    try {
      entries = await fsPromises.readdir(node.path);
    } catch {
      node.loaded = true;
      return;
    }

    const filtered = entries.filter(e => !shouldSkip(e));
    const statResults = await Promise.all(
      filtered.map(async (e) => {
        try {
          const s = await fsPromises.stat(join(node.path, e));
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

    const children: TreeNode[] = [];
    for (const entry of sorted) {
      if (entry.stat === null) continue;
      const fullPath = join(node.path, entry.name);
      children.push(entry.isDir
        ? {
            path: fullPath,
            name: entry.name,
            isDir: true,
            depth: node.depth + 1,
            size: 0,
            expanded: false,
            children: [],
            loaded: false,
          }
        : {
            path: fullPath,
            name: entry.name,
            isDir: false,
            depth: node.depth + 1,
            size: entry.size,
            expanded: false,
            children: [],
            loaded: true,
          });
    }
    node.children = children;
    node.loaded = true;
  }

  /**
   * Fetch git status for the working directory and index it by absolute
   * path for O(1) lookup from the tree renderer. Classification mirrors
   * git-panel's staged/unstaged split from the raw porcelain index/
   * working_dir columns (git-panel.ts:146-151), collapsed to a single
   * decoration badge per file: working-tree changes take priority over
   * staged-only changes, since that's the state most relevant while
   * browsing the tree.
   */
  private async _loadGitStatus(): Promise<void> {
    try {
      const status = await this.git.status();
      const next = new Map<string, { code: string; tone: 'good' | 'warn' | 'bad' | 'dim' }>();
      for (const f of status.files) {
        const fullPath = join(this.workingDirectory, f.path);
        if (f.index === '?' && f.working_dir === '?') {
          next.set(fullPath, { code: '?', tone: 'dim' }); // untracked
          continue;
        }
        const code = f.working_dir !== ' ' ? f.working_dir : f.index;
        if (!code || code === ' ') continue;
        const tone = code === 'D' ? 'bad' : code === 'A' ? 'good' : 'warn';
        next.set(fullPath, { code, tone });
      }
      this.gitStatus = next;
    } catch {
      // Not a git repo (or git unavailable) \u2014 decorations are optional.
      this.gitStatus = new Map();
    }
  }

  /** Right-aligned row metadata: git status badge (files only) + file size. */
  private _buildRowMetadata(node: TreeNode): Array<{ text: string; fg: string }> | undefined {
    if (node.isDir) return undefined;
    const meta: Array<{ text: string; fg: string }> = [];
    const status = this.gitStatus.get(node.path);
    if (status) {
      const fg = status.tone === 'good' ? DEFAULT_PANEL_PALETTE.good
        : status.tone === 'bad' ? DEFAULT_PANEL_PALETTE.bad
        : status.tone === 'warn' ? DEFAULT_PANEL_PALETTE.warn
        : DEFAULT_PANEL_PALETTE.dim;
      meta.push({ text: status.code, fg });
    }
    if (node.size > 0) meta.push({ text: formatSize(node.size), fg: C.sizeColor });
    return meta.length > 0 ? meta : undefined;
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

  private _activateNode(): void {
    const node = this.flat[this.cursor];
    if (!node) return;
    if (node.isDir) {
      node.expanded = !node.expanded;
      this._rebuildFlat();
      this.markDirty();
      if (node.expanded) this._loadNodeChildrenAndRefresh(node);
    }
    // For files: callers can read getFocusedNode() after the input returns true
  }

  private _expandNode(): void {
    const node = this.flat[this.cursor];
    if (!node || !node.isDir || node.expanded) return;
    node.expanded = true;
    this._rebuildFlat();
    this.markDirty();
    this._loadNodeChildrenAndRefresh(node);
  }

  /**
   * Lazily populate a directory's children (if not already loaded) and
   * refresh the flattened view once they arrive, without blocking the
   * expand keystroke itself.
   */
  private _loadNodeChildrenAndRefresh(node: TreeNode): void {
    if (node.loaded) return;
    void this._loadChildren(node).then(() => {
      this._rebuildFlat();
      this.markDirty();
    });
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
    // Re-entering search (e.g. pressing '/' again, or 'up' at the top of the
    // list) must EDIT the existing query, not silently clear it — the bug
    // this fixes unconditionally reset searchQuery to '' on every entry,
    // discarding whatever filter was already active.
    this.searchMode = true;
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
