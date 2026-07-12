import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import { truncateDisplay, getDisplayWidth } from '../utils/terminal-width.ts';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { UI_TONES, DIFF_TONES } from '../renderer/ui-primitives.ts';
import {
  buildEmptyState,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  buildSearchInputLine,
  resolveScrollablePanelSection,
  buildSelectablePanelLine,
  buildStyledPanelLine,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
} from './polish.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import {
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';

// Types

interface GitFileEntry {
  path: string;
  staged: boolean;
  /** True when this file was touched during the current session (best-effort). */
  sessionChanged?: boolean;
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
  | { kind: 'empty'; label: string };

/** Subject carried by the panel's single ConfirmState — either a repo init or a commit. */
type GitConfirmSubject =
  | { kind: 'init' }
  | { kind: 'commit'; message: string };

// Constants

/** Minimum number of diff lines kept visible when clamping scroll offset. */
const MIN_VISIBLE_DIFF_LINES = 5;

// Colors

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  branch: '#00d7ff',
  sectionHeader: '244',
  commit: '250',
  commitHash: '238',
  commitAuthor: '244',
  selected: '#1c1c1c',
  selectedFg: '#ffffff',
  diffMeta: DIFF_TONES.hunk, // shared diff-hunk token, was a local literal
  diffNeutral: '250',
  // Reuses the existing workflow accent token rather than adding a new hex
  // literal (architecture gate ratchets the raw-hex-literal count).
  sessionChanged: UI_TONES.accent.workflow,
});

// GitPanel

export class GitPanel extends BasePanel {
  private readonly workingDirectory: string;
  private readonly git: GitService;
  private readonly getChangedFiles?: () => readonly string[];

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

  /** When truthy, shows the diff for the selected file or commit. */
  private expandedDiff: string[] | null = null;

  /** Scroll offset for both main view and diff view. */
  private scrollOffset = 0;

  private refreshTimerId: ReturnType<typeof setInterval> | null = null;
  private loading = true;
  private error: string | null = null;

  /** True when the last refresh failed because `workingDirectory` isn't a git repo. */
  private notGitRepo = false;

  /** Single pending confirm — either "init this repo" or "commit with this message". */
  private confirm: ConfirmState<GitConfirmSubject> | null = null;

  /** Non-null while composing a commit message; null means the compose UI is closed. */
  private commitMessage: string | null = null;

  constructor(
    workingDirectory: string,
    private readonly requestRender: () => void = () => {},
    getChangedFiles?: () => readonly string[],
  ) {
    super('git', 'Git', 'G', 'development');
    this.workingDirectory = workingDirectory;
    // I2: reuse a single GitService instance across the panel's lifetime instead
    // of constructing a new one for every refresh/diff/stage/commit call.
    this.git = new GitService(workingDirectory);
    this.getChangedFiles = getChangedFiles;
  }

  private _markDirtyAndRender(): void {
    this.markDirty();
    this.requestRender();
  }

  // Lifecycle

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

  // Data fetching

  private async refresh(): Promise<void> {
    try {
      const [statusResult, branchResult, logEntries] = await Promise.all([
        this.git.status(),
        this.git.branch(),
        this.git.log(10),
      ]);

      const changed = this.getChangedFiles ? new Set(this.getChangedFiles()) : null;
      const markChanged = (path: string): boolean | undefined => (changed ? changed.has(path) : undefined);

      // Classify from the raw per-file porcelain columns (index/working_dir), not simple-git's
      // modified/staged arrays: those double-count a staged-with-no-further-edits file (index 'M',
      // working_dir ' ') as both staged AND unstaged, landing 's'/'u' on a phantom row.
      const stagedFiles: GitFileEntry[] = [];
      const unstagedFiles: GitFileEntry[] = [];
      for (const f of statusResult.files) {
        const sessionChanged = markChanged(f.path);
        if (f.index === '?' && f.working_dir === '?') {
          unstagedFiles.push({ path: f.path, staged: false, sessionChanged }); // untracked
          continue;
        }
        if (f.index !== ' ') stagedFiles.push({ path: f.path, staged: true, sessionChanged });
        if (f.working_dir !== ' ') unstagedFiles.push({ path: f.path, staged: false, sessionChanged });
      }

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
      this.notGitRepo = false;
      this.rebuildItems();
      // Do not clear expandedDiff during auto-refresh — only clear on explicit user action
      this._markDirtyAndRender();
    } catch (err) {
      const msg = summarizeError(err);
      if (/not a git\b/i.test(msg)) {
        // I4: no more auto `git init` side effect — surface the state and let
        // the user explicitly confirm initialisation with 'i'.
        this.notGitRepo = true;
        this.error = 'Not a git repository here. Press i to initialize one (explicit confirm).';
      } else {
        this.notGitRepo = false;
        this.error = msg;
      }
      this.loading = false;
      logger.debug('GitPanel: refresh failed', { error: this.error });
      this._markDirtyAndRender();
    }
  }

  /** Push a labeled section (with count) plus its rows, or an empty-row placeholder. */
  private pushSection<T>(items: ViewItem[], label: string, entries: readonly T[], emptyLabel: string, toItem: (entry: T) => ViewItem): void {
    items.push({ kind: 'section', label: `${label} (${entries.length})` });
    if (entries.length === 0) items.push({ kind: 'empty', label: emptyLabel });
    else for (const entry of entries) items.push(toItem(entry));
  }

  /** Rebuild the flat navigable item list from current data. */
  private rebuildItems(): void {
    const items: ViewItem[] = [{ kind: 'header' }];
    this.pushSection(items, 'Staged', this.data.stagedFiles, '  (no staged files)', (entry) => ({ kind: 'file', entry }));
    this.pushSection(items, 'Unstaged', this.data.unstagedFiles, '  (no unstaged files)', (entry) => ({ kind: 'file', entry }));
    this.pushSection(items, 'Recent Commits', this.data.recentCommits, '  (no commits)', (entry) => ({ kind: 'commit', entry }));
    this.items = items;

    // Keep selection in bounds and off header/section/empty filler rows (I5).
    if (this.selectedIndex >= this.items.length) {
      this.selectedIndex = Math.max(0, this.items.length - 1);
    }
    if (!this.isSelectable(this.items.at(this.selectedIndex))) {
      const firstSelectable = this.items.findIndex((it) => this.isSelectable(it));
      if (firstSelectable >= 0) this.selectedIndex = firstSelectable;
    }
  }

  /** True for rows the cursor is allowed to rest on (file or commit rows). */
  private isSelectable(item: ViewItem | undefined): boolean {
    return item?.kind === 'file' || item?.kind === 'commit';
  }

  /** Move the selection to the next/previous selectable row, skipping filler rows. */
  private moveSelection(direction: 1 | -1): void {
    let idx = this.selectedIndex;
    for (let i = 0; i < this.items.length; i++) {
      idx += direction;
      if (idx < 0 || idx >= this.items.length) return;
      if (this.isSelectable(this.items[idx])) {
        this.selectedIndex = idx;
        this.markDirty();
        return;
      }
    }
  }

  // Input handling

  /** Commit-message entry wants every char of a burst delivered one at a time — see Panel.isCapturingTextBurst. */
  isCapturingTextBurst(): boolean {
    return this.commitMessage !== null;
  }

  handleInput(key: string): boolean {
    // Confirm (init repo / commit) takes priority over everything else.
    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      const subject = this.confirm!.subject;
      this.confirm = null;
      if (subject.kind === 'init') {
        void this.performInit();
      } else {
        void this.performCommit(subject.message);
      }
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    if (this.commitMessage !== null) {
      return this.handleCommitMessageInput(key);
    }

    if (this.expandedDiff !== null) {
      return this.handleDiffInput(key);
    }
    return this.handleListInput(key);
  }

  private handleListInput(key: string): boolean {
    switch (key) {
      case 'up':
      case 'k': {
        this.moveSelection(-1);
        return true;
      }
      case 'down':
      case 'j': {
        this.moveSelection(1);
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
      case 's': {
        void this.setStaged(true);
        return true;
      }
      case 'u': {
        void this.setStaged(false);
        return true;
      }
      case 'c': {
        this.commitMessage = '';
        this.markDirty();
        return true;
      }
      case 'i': {
        // Only meaningful when no repo is loaded — otherwise leave the key
        // unconsumed instead of absorbing it as a silent no-op.
        if (!this.notGitRepo) return false;
        this.confirm = { subject: { kind: 'init' }, label: this.workingDirectory, verb: 'Init' };
        this.markDirty();
        return true;
      }
      default:
        return false;
    }
  }

  private handleCommitMessageInput(key: string): boolean {
    if (isPanelSearchCancel(key)) {
      this.commitMessage = null;
      this.markDirty();
      return true;
    }
    if (isPanelSearchCommit(key)) {
      const message = (this.commitMessage ?? '').trim();
      if (!message) return true; // absorb — require a non-empty message before confirming
      this.confirm = { subject: { kind: 'commit', message }, label: message, verb: 'Commit' };
      this.commitMessage = null;
      this.markDirty();
      return true;
    }
    if (isPanelSearchBackspace(key)) {
      this.commitMessage = (this.commitMessage ?? '').slice(0, -1);
      this.markDirty();
      return true;
    }
    if (isPanelSearchPrintable(key)) {
      this.commitMessage = (this.commitMessage ?? '') + key;
      this.markDirty();
      return true;
    }
    return true; // absorb every other key while composing
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

  /** Commit the given lines as the new expanded diff and reset scroll/dirty state. */
  private finishDiff(lines: string[]): void {
    this.expandedDiff = lines;
    this.scrollOffset = 0;
    this.markDirty();
  }

  // I3: withLoading guarantees the spinner is cleared even if the fetch throws.
  private async openDiff(): Promise<void> {
    const item = this.items.at(this.selectedIndex);
    if (!item) return;

    if (item.kind === 'file') {
      try {
        const raw = await this.withLoading('Loading diff…', async () => this.git.diffFile(item.entry.path, item.entry.staged));
        this.finishDiff(raw ? raw.split('\n') : ['(no diff available)']);
      } catch (err) {
        this.finishDiff([`Error: ${summarizeError(err)}`]);
      }
      return;
    }

    if (item.kind === 'commit') {
      // Root commits have no parent (`<hash>^` is invalid) — the catch below
      // surfaces that instead of pretending a diff exists.
      const before = `${item.entry.hash}^`;
      const after = item.entry.hash;
      try {
        const [patch, stat] = await this.withLoading('Loading commit…', async () => Promise.all([
          this.git.diffBetween(before, after),
          this.git.diffStat(before, after),
        ]));
        const statLines = stat.split('\n').filter((l) => l.trim().length > 0);
        const patchLines = patch ? patch.split('\n') : [];
        this.finishDiff(statLines.length > 0 ? [...statLines, '', ...patchLines] : (patchLines.length > 0 ? patchLines : ['(no diff available)']));
      } catch (err) {
        this.finishDiff([`Error: ${summarizeError(err)}`]);
      }
    }
  }

  // -- Mutating actions: stage / unstage / commit / init ----------------------

  /** Stage (target=true) or unstage (target=false) the selected file row. */
  private async setStaged(target: boolean): Promise<void> {
    const item = this.items.at(this.selectedIndex);
    if (!item || item.kind !== 'file' || item.entry.staged === target) return;
    try {
      if (target) await this.git.add(item.entry.path);
      else await this.git.reset(item.entry.path);
      await this.refresh();
    } catch (err) {
      this.error = `${target ? 'Stage' : 'Unstage'} failed: ${summarizeError(err)}`;
      this._markDirtyAndRender();
    }
  }

  private async performCommit(message: string): Promise<void> {
    try {
      await this.withLoading('Committing…', async () => this.git.commit(message));
      await this.refresh();
    } catch (err) {
      this.error = `Commit failed: ${summarizeError(err)}`;
      this._markDirtyAndRender();
    }
  }

  private async performInit(): Promise<void> {
    const result = GitService.initRepo(this.workingDirectory);
    if (result.success) {
      logger.debug('GitPanel: repo initialised via explicit confirm', { cwd: this.workingDirectory });
      this.notGitRepo = false;
      this.error = null;
      await this.refresh();
    } else {
      this.error = `Git init failed: ${result.error ?? 'unknown error'}`;
      this._markDirtyAndRender();
    }
  }

  // Rendering

  override render(width: number, height: number): Line[] {
    if (this.confirm) {
      return buildPanelWorkspace(width, height, {
        title: ' Git',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }
    if (this.commitMessage !== null) {
      return this.renderCommitCompose(width, height);
    }
    if (this.loading) {
      return this.renderMessage(width, height, 'Loading git status...', C.branch);
    }
    if (this.error) {
      return this.renderMessage(width, height, this.error, this.notGitRepo ? C.warn : C.bad);
    }
    // I3: spinner during openDiff()/performCommit() async fetch
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

  private renderCommitCompose(width: number, height: number): Line[] {
    const inputLine = buildSearchInputLine(
      width,
      'Commit message: ',
      `${this.commitMessage ?? ''}_`,
      DEFAULT_PANEL_PALETTE,
      { active: true, bg: DEFAULT_PANEL_PALETTE.inputBg, valueColor: DEFAULT_PANEL_PALETTE.info },
    );
    const footerLines = [
      buildKeyboardHints(width, [{ keys: 'Enter', label: 'review & confirm' }, { keys: 'Esc', label: 'cancel' }], DEFAULT_PANEL_PALETTE),
    ];
    return buildPanelWorkspace(width, height, {
      title: ' Git — Commit',
      sections: [{ title: 'Message', lines: [inputLine] }],
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
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
    const isDirty = this.data.stagedFiles.length > 0 || this.data.unstagedFiles.length > 0;
    const segments: Array<{ text: string; fg: string; bold?: boolean }> = [
      { text: ' ⎇ ', fg: C.sectionHeader },
      { text: this.data.branch, fg: C.branch, bold: true },
    ];
    if (this.data.ahead > 0) segments.push({ text: ` ↑${this.data.ahead}`, fg: C.good });
    if (this.data.behind > 0) segments.push({ text: ` ↓${this.data.behind}`, fg: C.bad });
    if (this.data.ahead === 0 && this.data.behind === 0) {
      segments.push({ text: ' ≡ up to date', fg: C.dim });
    }
    segments.push({
      text: isDirty ? '  ● dirty' : '  ✓ clean',
      fg: isDirty ? C.warn : C.good,
      bold: true,
    });
    segments.push({ text: `  ${this.data.stagedFiles.length} staged`, fg: this.data.stagedFiles.length > 0 ? C.good : C.dim });
    segments.push({ text: ` · ${this.data.unstagedFiles.length} unstaged`, fg: this.data.unstagedFiles.length > 0 ? C.warn : C.dim });
    return buildStyledPanelLine(width, segments);
  }

  private renderSectionHeader(label: string, width: number): Line {
    return buildStyledPanelLine(width, [{ text: ` ◆ ${label}`, fg: C.sectionHeader, bold: true }]);
  }

  private renderFileRow(entry: GitFileEntry, selected: boolean, width: number): Line {
    const fg = entry.staged ? C.good : C.bad;
    // Single-char status marker: + staged (ready to commit), M modified/unstaged.
    const statusGlyph = entry.staged ? '+' : 'M';
    const sessionMarker = entry.sessionChanged ? '● ' : '  ';
    const path = truncateDisplay(entry.path, Math.max(0, width - 8));
    return buildSelectablePanelLine(width, [
      { text: ` ${statusGlyph} `, fg, bg: selected ? C.selected : undefined, bold: true },
      { text: sessionMarker, fg: selected ? C.selectedFg : C.sessionChanged, bg: selected ? C.selected : undefined },
      { text: path, fg: selected ? C.selectedFg : fg, bg: selected ? C.selected : undefined, bold: selected },
    ], { selected, selectedBg: C.selected, fillFg: selected ? C.selectedFg : '', leadingMarker: '▸' });
  }

  private renderCommitRow(entry: CommitEntry, selected: boolean, width: number): Line {
    const hashPart = ` ${entry.hash} `;
    const msgBudget = Math.max(0, width - getDisplayWidth(hashPart) - 3);
    const msgPart = truncateDisplay(entry.message, msgBudget);
    return buildSelectablePanelLine(width, [
      { text: hashPart, fg: selected ? C.selectedFg : C.commitHash, bg: selected ? C.selected : undefined },
      { text: msgPart, fg: selected ? C.selectedFg : C.commit, bg: selected ? C.selected : undefined, bold: selected },
    ], { selected, selectedBg: C.selected, fillFg: selected ? C.selectedFg : '', leadingMarker: '▸' });
  }

  private renderList(width: number, height: number): Line[] {
    const intro = 'Review branch status, staged and unstaged files, and recent commits. Open a file or commit row to inspect its diff.';
    const footerHints = [
      buildKeyboardHints(width, [
        { keys: '↑/↓', label: 'navigate' },
        { keys: 'Enter', label: 'open diff →' },
        { keys: 's/u', label: 'stage/unstage' },
        { keys: 'c', label: 'commit' },
        { keys: 'r', label: 'refresh' },
      ], DEFAULT_PANEL_PALETTE),
    ];
    const emptyStateLines = buildEmptyState(width, ' No git rows', 'This repository has no staged or unstaged changes and no commits to display yet.', [{ command: 'r', summary: 'refresh working-tree status in this panel, or stage changes to populate this view' }], DEFAULT_PANEL_PALETTE); // was '/git status' (chat-only, never touches this panel)
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
      const selectedItem = this.items.at(this.selectedIndex);
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
        intro,
        footerLines: footerHints,
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
        intro,
        sections: [
          summarySection,
          workspaceSection.section.lines.length > 0 ? workspaceSection.section : { title: 'Workspace', lines: emptyStateLines },
          selectedSection,
        ],
        footerLines: footerHints,
        palette: DEFAULT_PANEL_PALETTE,
      });
    }
    return buildPanelWorkspace(width, height, {
      title: ' Git',
      intro,
      sections: [{ lines: emptyStateLines }],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  /** Map an item index in `this.items` to its rendered row index (header items expand to 2 rows: branch + spacer). */
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
    const item = this.items.at(this.selectedIndex);
    const diffLines = this.expandedDiff ?? [];
    let added = 0;
    let removed = 0;
    for (const l of diffLines) {
      if (l.startsWith('+') && !l.startsWith('+++')) added++;
      else if (l.startsWith('-') && !l.startsWith('---')) removed++;
    }
    const title =
      item?.kind === 'file'
        ? `Diff: ${item.entry.path}  +${added} -${removed}`
        : item?.kind === 'commit'
          ? `Commit ${item.entry.hash}: ${item.entry.message}  +${added} -${removed}`
          : 'Diff';
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
      buildKeyboardHints(width, [{ keys: '↑/↓', label: 'scroll' }, { keys: 'Esc/q', label: 'back to files' }], DEFAULT_PANEL_PALETTE),
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
