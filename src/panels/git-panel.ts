import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  buildEmptyState,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  buildStyledPanelLine,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
} from './polish.ts';

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

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  branch: '#00d7ff',
  sectionHeader: '244',
  commit: '250',
  commitHash: '238',
  commitAuthor: '244',
  selected: '#1c1c1c',
  selectedFg: '#ffffff',
  diffMeta: '#5f87ff',
  diffNeutral: '250',
});

// ---------------------------------------------------------------------------
// GitPanel
// ---------------------------------------------------------------------------

export class GitPanel extends BasePanel {
  private readonly workingDirectory: string;
  private data: GitData = {
    branch: '...',
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

  private refreshTimerId: ReturnType<typeof setInterval> | null = null;
  private loading = true;
  private error: string | null = null;

  constructor(workingDirectory: string) {
    super('git', 'Git', 'G', 'development');
    this.workingDirectory = workingDirectory;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    void this.refresh();
    this.refreshTimerId = this.registerTimer(setInterval(() => {
      void this.refresh();
    }, 5_000));
  }

  override onDeactivate(): void {
    if (this.refreshTimerId !== null) {
      this.clearTimer(this.refreshTimerId);
      this.refreshTimerId = null;
    }
  }

  override onDestroy(): void {
    this.onDeactivate();
    super.onDestroy();
  }

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  private async refresh(isRetry = false): Promise<void> {
    try {
      const git = new GitService(this.workingDirectory);
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
      const msg = summarizeError(err);
      // If the failure is because this directory isn't a git repo, auto-initialise
      // and retry once so the panel becomes functional immediately.
      if (/not a git\b/i.test(msg)) {
        const cwd = this.workingDirectory;
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

    // I3: withLoading guarantees spinner is cleared even if diffFile throws
    try {
      const raw = await this.withLoading('Loading diff…', async () => {
        const git = new GitService(this.workingDirectory);
        return git.diffFile(item.entry.path, item.entry.staged);
      });
      this.expandedDiff = raw ? raw.split('\n') : ['(no diff available)'];
      this.scrollOffset = 0;
      this.markDirty();
    } catch (err) {
      this.expandedDiff = [`Error: ${summarizeError(err)}`];
      this.scrollOffset = 0;
      this.markDirty();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    if (this.loading) {
      return this.renderMessage(width, height, 'Loading git status...', C.branch);
    }
    if (this.error) {
      return this.renderMessage(width, height, `Git error: ${this.error}`, C.bad);
    }
    // I3: spinner during openDiff() async fetch
    if (this.loadingState === 'loading') {
      return this.renderMessage(width, height, 'Loading diff...', C.branch);
    }
    if (this.expandedDiff !== null) {
      return this.renderDiff(width, height);
    }
    return this.renderList(width, height);
  }

  // -- Helpers -----------------------------------------------------------------

  private renderMessage(width: number, height: number, msg: string, fg: string): Line[] {
    const lines: Line[] = [buildStyledPanelLine(width, [{ text: msg, fg }])];
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

    const branchIcon = ' git: ';
    x = this.paintText(line, branchIcon, x, width, C.sectionHeader);
    x = this.paintText(line, this.data.branch, x, width, C.branch, { bold: true });

    if (this.data.ahead > 0) {
      x = this.paintText(line, ` +${this.data.ahead}`, x, width, C.good);
    }
    if (this.data.behind > 0) {
      x = this.paintText(line, ` -${this.data.behind}`, x, width, C.bad);
    }

    const isDirty = this.data.stagedFiles.length > 0 || this.data.unstagedFiles.length > 0;
    const statusText = isDirty ? ' * dirty' : ' y clean';
    const statusFg = isDirty ? C.warn : C.good;
    this.paintText(line, statusText, x, width, statusFg);

    return line;
  }

  private renderSectionHeader(label: string, width: number): Line {
    return buildStyledPanelLine(width, [{ text: `-- ${label} `, fg: C.sectionHeader, dim: true }]);
  }

  private renderFileRow(entry: GitFileEntry, selected: boolean, width: number): Line {
    const line = createEmptyLine(width);
    const fg = entry.staged ? C.good : C.bad;
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
    const msgPart = entry.message.length > 60 ? `${entry.message.slice(0, 57)}...` : entry.message;

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
          rows.push(buildStyledPanelLine(width, [{ text: item.label, fg: C.sectionHeader, dim: true }]));
          break;
        }
      }
    }

    const selectedRowIndex = this.getRowIndexForItem(this.selectedIndex);
    if (selectedRowIndex >= 0) {
      const isDirty = this.data.stagedFiles.length > 0 || this.data.unstagedFiles.length > 0;
      const selectedItem = this.items[this.selectedIndex];
      const selectedLines: Line[] = [];
      if (selectedItem?.kind === 'file') {
        selectedLines.push(buildPanelLine(width, [
          [' File ', DEFAULT_PANEL_PALETTE.label],
          [selectedItem.entry.path, DEFAULT_PANEL_PALETTE.value],
          ['   State ', DEFAULT_PANEL_PALETTE.label],
          [selectedItem.entry.staged ? 'staged' : 'unstaged', selectedItem.entry.staged ? DEFAULT_PANEL_PALETTE.good : DEFAULT_PANEL_PALETTE.warn],
        ]));
      } else if (selectedItem?.kind === 'commit') {
        selectedLines.push(buildPanelLine(width, [
          [' Commit ', DEFAULT_PANEL_PALETTE.label],
          [selectedItem.entry.hash, DEFAULT_PANEL_PALETTE.info],
          ['   Author ', DEFAULT_PANEL_PALETTE.label],
          [selectedItem.entry.author, DEFAULT_PANEL_PALETTE.value],
        ]));
        selectedLines.push(buildPanelLine(width, [
          [' Message ', DEFAULT_PANEL_PALETTE.label],
          [selectedItem.entry.message, DEFAULT_PANEL_PALETTE.value],
        ]));
      }

      const summarySection = {
        title: 'Summary',
        lines: [
          buildPanelLine(width, [
            [' Branch ', DEFAULT_PANEL_PALETTE.label],
            [this.data.branch, DEFAULT_PANEL_PALETTE.info],
            ['   Ahead ', DEFAULT_PANEL_PALETTE.label],
            [String(this.data.ahead), this.data.ahead > 0 ? DEFAULT_PANEL_PALETTE.good : DEFAULT_PANEL_PALETTE.dim],
            ['   Behind ', DEFAULT_PANEL_PALETTE.label],
            [String(this.data.behind), this.data.behind > 0 ? DEFAULT_PANEL_PALETTE.bad : DEFAULT_PANEL_PALETTE.dim],
            ['   Status ', DEFAULT_PANEL_PALETTE.label],
            [isDirty ? 'dirty' : 'clean', isDirty ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.good],
          ]),
        ],
      } as const;
      const selectedSection = { title: 'Selected', lines: selectedLines } as const;
      const workspaceSection = resolveScrollablePanelSection(width, height, {
        intro: 'Review branch status, staged and unstaged files, and recent commits. Open a file row to inspect its diff.',
        footerLines: [
          buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter', DEFAULT_PANEL_PALETTE.info], [' diff', DEFAULT_PANEL_PALETTE.dim], ['   r', DEFAULT_PANEL_PALETTE.info], [' refresh', DEFAULT_PANEL_PALETTE.dim]]),
        ],
        palette: DEFAULT_PANEL_PALETTE,
        beforeSections: [summarySection],
        section: {
          title: 'Workspace',
          scrollableLines: rows,
          selectedIndex: selectedRowIndex,
          scrollOffset: this.scrollOffset,
          minRows: 8,
        },
        afterSections: [selectedSection],
      });
      this.scrollOffset = workspaceSection.scrollOffset;

      return buildPanelWorkspace(width, height, {
        title: ' Git',
        intro: 'Review branch status, staged and unstaged files, and recent commits. Open a file row to inspect its diff.',
        sections: [
          summarySection,
          workspaceSection.section.lines.length > 0 ? workspaceSection.section : { title: 'Workspace', lines: buildEmptyState(width, ' No git rows', 'This repository has no files or commits to display yet.', [], DEFAULT_PANEL_PALETTE) },
          selectedSection,
        ],
        footerLines: [
          buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter', DEFAULT_PANEL_PALETTE.info], [' diff', DEFAULT_PANEL_PALETTE.dim], ['   r', DEFAULT_PANEL_PALETTE.info], [' refresh', DEFAULT_PANEL_PALETTE.dim]]),
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }
    return buildPanelWorkspace(width, height, {
      title: ' Git',
      intro: 'Review branch status, staged and unstaged files, and recent commits. Open a file row to inspect its diff.',
      sections: [
        {
          lines: buildEmptyState(width, ' No git rows', 'This repository has no files or commits to display yet.', [], DEFAULT_PANEL_PALETTE),
        },
      ],
      palette: DEFAULT_PANEL_PALETTE,
    });
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
    const item = this.items[this.selectedIndex];
    const title =
      item?.kind === 'file' ? `Diff: ${item.entry.path}` : 'Diff';
    const diffLines = this.expandedDiff ?? [];
    const renderedLines = diffLines.map((rawLine) => {
      const dLine = createEmptyLine(width);
      let fg: string;
      if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
        fg = C.good;
      } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
        fg = C.bad;
      } else if (rawLine.startsWith('@@') || rawLine.startsWith('diff') || rawLine.startsWith('index')) {
        fg = C.diffMeta;
      } else {
        fg = C.diffNeutral;
      }
      this.paintText(dLine, rawLine, 0, width, fg);
      return dLine;
    });
    const footerLines = [
      buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' scroll', DEFAULT_PANEL_PALETTE.dim], ['   Esc/q', DEFAULT_PANEL_PALETTE.info], [' close', DEFAULT_PANEL_PALETTE.dim]]),
    ];
    const diffSection = resolveScrollablePanelSection(width, height, {
      palette: DEFAULT_PANEL_PALETTE,
      footerLines,
      section: {
        title: 'Patch',
        scrollableLines: renderedLines,
        scrollOffset: this.scrollOffset,
        minRows: 1,
      },
    });
    this.scrollOffset = diffSection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ` ${title}`,
      sections: [diffSection.section],
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }
}
