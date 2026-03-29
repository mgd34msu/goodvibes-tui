import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import { GitService } from '../git/service.ts';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitFileEntry {
  path: string;
  staged: boolean;
}

interface CommitEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

interface GitData {
  branch: string;
  ahead: number;
  behind: number;
  stagedFiles: GitFileEntry[];
  unstagedFiles: GitFileEntry[];
  recentCommits: CommitEntry[];
}

type ViewItem =
  | { kind: 'header' }
  | { kind: 'section'; label: string }
  | { kind: 'file'; entry: GitFileEntry }
  | { kind: 'commit'; entry: CommitEntry }
  | { kind: 'empty'; label: string }
  | { kind: 'diff-line'; text: string; diffType: 'add' | 'remove' | 'meta' | 'neutral' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum number of diff lines kept visible when clamping scroll offset. */
const MIN_VISIBLE_DIFF_LINES = 5;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
  branch: '#00d7ff',
  clean: '#5fd700',
  dirty: '#ffaf00',
  ahead: '#5fd700',
  behind: '#ff5f5f',
  sectionHeader: '244',
  staged: '#5fd700',
  unstaged: '#ff5f5f',
  commit: '250',
  commitHash: '238',
  commitAuthor: '244',
  selected: '#1c1c1c',
  selectedFg: '#ffffff',
  diffAdd: '#5fd700',
  diffRemove: '#ff5f5f',
  diffMeta: '#5f87ff',
  diffNeutral: '250',
} as const;

// ---------------------------------------------------------------------------
// GitPanel
// ---------------------------------------------------------------------------

export class GitPanel extends BasePanel {
  private data: GitData = {
    branch: '…',
    ahead: 0,
    behind: 0,
    stagedFiles: [],
    unstagedFiles: [],
    recentCommits: [],
  };

  /** Flattened list of navigable rows (for arrow-key movement). */
  private items: ViewItem[] = [];

  /** Selected row index within `items`. */
  private selectedIndex = 0;

  /** When truthy, shows the diff for the selected file. */
  private expandedDiff: string[] | null = null;

  /** Scroll offset for both main view and diff view. */
  private scrollOffset = 0;

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private loading = true;
  private error: string | null = null;

  constructor() {
    super('git', 'Git', 'G', 'development');
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    void this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, 5_000);
  }

  override onDeactivate(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  override onDestroy(): void {
    this.onDeactivate();
  }

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  private async refresh(isRetry = false): Promise<void> {
    try {
      const git = GitService.getInstance();
      const [statusResult, branchResult, logEntries] = await Promise.all([
        git.status(),
        git.branch(),
        git.log(10),
      ]);

      const stagedFiles: GitFileEntry[] = [
        ...statusResult.staged.map((p) => ({ path: p, staged: true })),
        ...statusResult.created.map((p) => ({ path: p, staged: true })),
      ];

      const unstagedFiles: GitFileEntry[] = [
        ...statusResult.modified.map((p) => ({ path: p, staged: false })),
        ...statusResult.deleted.map((p) => ({ path: p, staged: false })),
        ...statusResult.not_added.map((p) => ({ path: p, staged: false })),
        ...statusResult.conflicted.map((p) => ({ path: p, staged: false })),
      ];

      this.data = {
        branch: branchResult.current || 'HEAD',
        ahead: statusResult.ahead ?? 0,
        behind: statusResult.behind ?? 0,
        stagedFiles,
        unstagedFiles,
        recentCommits: logEntries.map((e) => ({
          hash: e.hash.slice(0, 7),
          message: e.message,
          author: e.author,
          date: e.date,
        })),
      };

      this.loading = false;
      this.error = null;
      this.rebuildItems();
      // Do not clear expandedDiff during auto-refresh — only clear on explicit user action
      this.markDirty();
    } catch (err) {
      const msg = String(err);
      // If the failure is because this directory isn't a git repo, auto-initialise
      // and retry once so the panel becomes functional immediately.
      if (/not a git\b/i.test(msg)) {
        const cwd = process.cwd();
        const initResult = GitService.initRepo(cwd);
        if (initResult.success) {
          logger.debug('GitPanel: auto-initialised git repo', { cwd });
          if (!isRetry) {
            // Retry refresh now that the repo exists (once only)
            void this.refresh(true);
            return;
          }
          this.error = 'Not a git repository. Auto-init succeeded but refresh failed.';
        } else {
          this.error = `Not a git repository. Auto-init failed: ${initResult.error ?? 'unknown error'}`;
        }
      } else {
        this.error = msg;
      }
      this.loading = false;
      logger.debug('GitPanel: refresh failed', { error: this.error });
      this.markDirty();
    }
  }

  /** Rebuild the flat navigable item list from current data. */
  private rebuildItems(): void {
    const items: ViewItem[] = [];

    // Branch / status header row
    items.push({ kind: 'header' });

    // Staged files
    items.push({ kind: 'section', label: `Staged (${this.data.stagedFiles.length})` });
    if (this.data.stagedFiles.length === 0) {
      items.push({ kind: 'empty', label: '  (no staged files)' });
    } else {
      for (const entry of this.data.stagedFiles) {
        items.push({ kind: 'file', entry });
      }
    }

    // Unstaged files
    items.push({ kind: 'section', label: `Unstaged (${this.data.unstagedFiles.length})` });
    if (this.data.unstagedFiles.length === 0) {
      items.push({ kind: 'empty', label: '  (no unstaged files)' });
    } else {
      for (const entry of this.data.unstagedFiles) {
        items.push({ kind: 'file', entry });
      }
    }

    // Recent commits
    items.push({ kind: 'section', label: `Recent Commits (${this.data.recentCommits.length})` });
    if (this.data.recentCommits.length === 0) {
      items.push({ kind: 'empty', label: '  (no commits)' });
    } else {
      for (const entry of this.data.recentCommits) {
        items.push({ kind: 'commit', entry });
      }
    }

    this.items = items;

    // Keep selection in bounds
    if (this.selectedIndex >= this.items.length) {
      this.selectedIndex = Math.max(0, this.items.length - 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------------------

  handleInput(key: string): boolean {
    if (this.expandedDiff !== null) {
      return this.handleDiffInput(key);
    }
    return this.handleListInput(key);
  }

  private handleListInput(key: string): boolean {
    switch (key) {
      case 'up':
      case 'k': {
        if (this.selectedIndex > 0) {
          this.selectedIndex--;
          this.markDirty();
        }
        return true;
      }
      case 'down':
      case 'j': {
        if (this.selectedIndex < this.items.length - 1) {
          this.selectedIndex++;
          this.markDirty();
        }
        return true;
      }
      case 'return': {
        void this.openDiff();
        return true;
      }
      case 'r': {
        void this.refresh();
        return true;
      }
      default:
        return false;
    }
  }

  private handleDiffInput(key: string): boolean {
    switch (key) {
      case 'up':
      case 'k': {
        if (this.scrollOffset > 0) {
          this.scrollOffset--;
          this.markDirty();
        }
        return true;
      }
      case 'down':
      case 'j': {
        const diffLen = this.expandedDiff?.length ?? 0;
        this.scrollOffset = Math.min(this.scrollOffset + 1, Math.max(0, diffLen - MIN_VISIBLE_DIFF_LINES));
        this.markDirty();
        return true;
      }
      case 'escape':
      case 'q': {
        this.expandedDiff = null;
        this.scrollOffset = 0;
        this.markDirty();
        return true;
      }
      default:
        return false;
    }
  }

  private async openDiff(): Promise<void> {
    const item = this.items[this.selectedIndex];
    if (!item || item.kind !== 'file') return;

    try {
      const git = GitService.getInstance();
      const raw = await git.diffFile(item.entry.path, item.entry.staged);
      this.expandedDiff = raw ? raw.split('\n') : ['(no diff available)'];
      this.scrollOffset = 0;
      this.markDirty();
    } catch (err) {
      this.expandedDiff = [`Error: ${String(err)}`];
      this.scrollOffset = 0;
      this.markDirty();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    if (this.loading) {
      return this.renderMessage(width, height, 'Loading git status…', C.branch);
    }
    if (this.error) {
      return this.renderMessage(width, height, `Git error: ${this.error}`, C.unstaged);
    }
    if (this.expandedDiff !== null) {
      return this.renderDiff(width, height);
    }
    return this.renderList(width, height);
  }

  // -- Helpers -----------------------------------------------------------------

  private renderMessage(width: number, height: number, msg: string, fg: string): Line[] {
    const lines: Line[] = [];
    const line = createEmptyLine(width);
    let x = 0;
    for (const ch of msg) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg });
    }
    lines.push(line);
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines;
  }

  /** Paint a single text string into a new Line at x=startX. */
  private paintText(
    line: Line,
    text: string,
    startX: number,
    width: number,
    fg: string,
    opts: { bold?: boolean; dim?: boolean } = {},
  ): number {
    let x = startX;
    for (const ch of text) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg, bold: opts.bold, dim: opts.dim });
    }
    return x;
  }

  private renderBranchLine(width: number): Line {
    const line = createEmptyLine(width);
    let x = 0;

    const branchIcon = ' ⎇ ';
    x = this.paintText(line, branchIcon, x, width, C.sectionHeader);
    x = this.paintText(line, this.data.branch, x, width, C.branch, { bold: true });

    if (this.data.ahead > 0) {
      x = this.paintText(line, ` ↑${this.data.ahead}`, x, width, C.ahead);
    }
    if (this.data.behind > 0) {
      x = this.paintText(line, ` ↓${this.data.behind}`, x, width, C.behind);
    }

    const isDirty = this.data.stagedFiles.length > 0 || this.data.unstagedFiles.length > 0;
    const statusText = isDirty ? ' ● dirty' : ' ✓ clean';
    const statusFg = isDirty ? C.dirty : C.clean;
    this.paintText(line, statusText, x, width, statusFg);

    return line;
  }

  private renderSectionHeader(label: string, width: number): Line {
    const line = createEmptyLine(width);
    const text = `── ${label} `;
    this.paintText(line, text, 0, width, C.sectionHeader, { dim: true });
    return line;
  }

  private renderFileRow(entry: GitFileEntry, selected: boolean, width: number): Line {
    const line = createEmptyLine(width);
    const fg = entry.staged ? C.staged : C.unstaged;
    const prefix = '  ';
    const label = `${prefix}${entry.path}`;

    if (selected) {
      // Fill background highlight
      for (let i = 0; i < width; i++) {
        line[i] = createStyledCell(' ', { bg: C.selected, fg: C.selectedFg });
      }
      let x = 0;
      for (const ch of label) {
        if (x >= width) break;
        line[x++] = createStyledCell(ch, { fg, bg: C.selected, bold: true });
      }
    } else {
      this.paintText(line, label, 0, width, fg);
    }
    return line;
  }

  private renderCommitRow(entry: CommitEntry, selected: boolean, width: number): Line {
    const line = createEmptyLine(width);
    const hashPart = `  ${entry.hash} `;
    const msgPart = entry.message.length > 60 ? `${entry.message.slice(0, 57)}…` : entry.message;

    if (selected) {
      for (let i = 0; i < width; i++) {
        line[i] = createStyledCell(' ', { bg: C.selected, fg: C.selectedFg });
      }
      let x = 0;
      for (const ch of hashPart) {
        if (x >= width) break;
        line[x++] = createStyledCell(ch, { fg: C.commitHash, bg: C.selected });
      }
      for (const ch of msgPart) {
        if (x >= width) break;
        line[x++] = createStyledCell(ch, { fg: C.selectedFg, bg: C.selected });
      }
    } else {
      let x = this.paintText(line, hashPart, 0, width, C.commitHash);
      this.paintText(line, msgPart, x, width, C.commit);
    }
    return line;
  }

  private renderList(width: number, height: number): Line[] {
    const lines: Line[] = [];

    // Build all renderable rows
    const rows: Line[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const selected = i === this.selectedIndex;
      if (!item) continue;

      switch (item.kind) {
        case 'header':
          rows.push(this.renderBranchLine(width));
          rows.push(createEmptyLine(width)); // spacer
          break;
        case 'section':
          rows.push(this.renderSectionHeader(item.label, width));
          break;
        case 'file':
          rows.push(this.renderFileRow(item.entry, selected, width));
          break;
        case 'commit':
          rows.push(this.renderCommitRow(item.entry, selected, width));
          break;
        case 'empty': {
          const emptyLine = createEmptyLine(width);
          this.paintText(emptyLine, item.label, 0, width, C.sectionHeader, { dim: true });
          rows.push(emptyLine);
          break;
        }
      }
    }

    // Auto-scroll to keep selected row visible
    const selectedRowIndex = this.getRowIndexForItem(this.selectedIndex);
    if (selectedRowIndex >= 0) {
      if (selectedRowIndex < this.scrollOffset) {
        this.scrollOffset = selectedRowIndex;
      } else if (selectedRowIndex >= this.scrollOffset + height - 1) {
        this.scrollOffset = selectedRowIndex - height + 2;
      }
    }
    if (this.scrollOffset < 0) this.scrollOffset = 0;

    // Slice visible rows
    const visible = rows.slice(this.scrollOffset, this.scrollOffset + height);
    lines.push(...visible);

    // Footer hint
    if (lines.length > 0) {
      const hintLine = createEmptyLine(width);
      const hint = ' ↑↓ navigate  Enter diff  r refresh  Esc close diff';
      this.paintText(hintLine, hint, 0, width, C.sectionHeader, { dim: true });
      // Replace the last line with the hint when we have room
      if (lines.length < height) {
        while (lines.length < height - 1) lines.push(createEmptyLine(width));
        lines.push(hintLine);
      }
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines;
  }

  /**
   * Map an item index in `this.items` to the row index in the rendered row list.
   * Header items expand to 2 rows (branch + spacer).
   */
  private getRowIndexForItem(itemIndex: number): number {
    let row = 0;
    for (let i = 0; i < itemIndex && i < this.items.length; i++) {
      const it = this.items[i];
      if (it?.kind === 'header') {
        row += 2;
      } else {
        row += 1;
      }
    }
    return row;
  }

  private renderDiff(width: number, height: number): Line[] {
    const lines: Line[] = [];

    // Title bar
    const item = this.items[this.selectedIndex];
    const title =
      item?.kind === 'file' ? `Diff: ${item.entry.path}` : 'Diff';
    const titleLine = createEmptyLine(width);
    this.paintText(titleLine, ` ${title}`, 0, width, C.branch, { bold: true });
    lines.push(titleLine);

    // Diff content (scrollable)
    const diffLines = this.expandedDiff ?? [];
    const contentHeight = height - 2; // title + hint
    const clampedOffset = Math.min(
      this.scrollOffset,
      Math.max(0, diffLines.length - contentHeight),
    );
    this.scrollOffset = clampedOffset;

    const visible = diffLines.slice(clampedOffset, clampedOffset + contentHeight);
    for (const rawLine of visible) {
      const dLine = createEmptyLine(width);
      let fg: string;
      if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
        fg = C.diffAdd;
      } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
        fg = C.diffRemove;
      } else if (rawLine.startsWith('@@') || rawLine.startsWith('diff') || rawLine.startsWith('index')) {
        fg = C.diffMeta;
      } else {
        fg = C.diffNeutral;
      }
      this.paintText(dLine, rawLine, 0, width, fg);
      lines.push(dLine);
    }

    while (lines.length < height - 1) lines.push(createEmptyLine(width));

    // Hint line
    const hintLine = createEmptyLine(width);
    this.paintText(hintLine, ' ↑↓ scroll  Esc/q close', 0, width, C.sectionHeader, { dim: true });
    lines.push(hintLine);

    return lines;
  }
}
