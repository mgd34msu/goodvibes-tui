/**
 * changes-modal.ts, the Changes modal (/changes, /diff, /git diff, /review,
 * ctrl+p "changes"). Replaces the Git, Diff and Review panes.
 *
 * Two modes:
 *   - workspace: the repository's changes from git (this session's files, not
 *     staged, staged, or everything vs HEAD; v cycles), recent commits under
 *     the file list. Hunks can be staged, commented on for the model, reverted
 *     and opened in the editor; files marked reviewed; staged work committed.
 *   - preview: a diff handed in by something else (a fleet candidate, a rewind
 *     checkpoint, a workstream attempt), read-only, optionally carrying a
 *     question with two buttons (pick it? restore it?).
 *
 * Esc peels one level: an open comment or commit message, then the modal.
 * Esc on a preview question answers "no".
 */

import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from './surface-modal-host.ts';
import type { SurfaceLayer, KitHint } from '../renderer/surface-kit.ts';
import type { KitRow } from '../renderer/surface-kit-list.ts';
import { formatSemanticDiffSummary, type SemanticDiff } from '../renderer/semantic-diff.ts';
import { renderChangesModal, type ChangesFootLine, type ChangesModalView, type ChangesQuestion } from '../renderer/changes-modal.ts';
import { activeTokens } from '../renderer/theme.ts';
import { changeTotals, hunkPatch, parseChanges, type ChangeFile, type ChangeHunk } from './changes-model.ts';
import {
  applyHunkToIndex, commitStaged, initRepo, isGitRepo, loadCommitDiff, loadDiff, loadRecentCommits, loadRepoSummary,
  loadSemanticDiff, setFileStaged, CHANGES_SOURCES, CHANGES_SOURCE_LABELS, type ChangesSource, type CommitEntry, type RepoSummary,
} from './changes-git.ts';
import { buildSteerMessage, type HunkComment, type ReviewHunk } from '../panels/diff-review-model.ts';
import { isTextBackspace } from './delete-key-policy.ts';
import type { ConfirmOptions } from './confirm-dialog.ts';

export interface ChangesDeps {
  readonly workingDirectory: string;
  /** Files this session edited (the session change tracker). */
  readonly getSessionFiles: () => readonly string[];
  readonly requestRender: () => void;
  /** Send text to the model as the next user turn (review comments). */
  readonly submitInput?: (text: string) => void;
  readonly openInEditor?: (path: string, line?: number) => void;
  /** Revert one hunk in the working tree (checkpoint-backed, asks first). Resolves to a status line. */
  readonly revertHunk?: (hunk: ReviewHunk) => Promise<string>;
  readonly confirm?: (options: ConfirmOptions) => Promise<boolean>;
}

export interface ChangesQuestionSpec {
  readonly text: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly tone?: 'danger' | 'warning' | 'primary';
}

interface PendingQuestion extends ChangesQuestionSpec {
  chosen: 0 | 1;
  readonly answer: (confirmed: boolean) => void;
}

type Item = { readonly kind: 'file'; readonly index: number } | { readonly kind: 'commit'; readonly index: number };

function commentKey(hunk: ReviewHunk): string {
  return `${hunk.filePath}:${hunk.header}`;
}

export class ChangesModal implements SurfaceModal {
  readonly name = 'changes';
  readonly mode: 'workspace' | 'preview';
  source: ChangesSource = 'session';
  files: ChangeFile[] = [];
  commits: CommitEntry[] = [];
  label = '';
  summary: RepoSummary | null = null;
  selected = 0;
  hunkIndex = 0;
  scrollDelta = 0;
  loading = false;
  error: string | null = null;
  notRepo = false;
  status: { text: string; tone: ChangesFootLine['tone'] } | null = null;
  composing: string | null = null;
  commitDraft: string | null = null;
  readonly reviewed = new Set<string>();
  readonly comments = new Map<string, { hunk: ReviewHunk; text: string; sent: boolean }>();
  private readonly semantic = new Map<string, SemanticDiff | null | undefined>();
  private readonly commitFiles = new Map<string, ChangeFile[] | string>();
  private previewTitle = '';
  private previewNote: string | null = null;
  private question: PendingQuestion | null = null;
  private loadSeq = 0;

  constructor(private readonly deps: ChangesDeps, mode: 'workspace' | 'preview' = 'workspace') {
    this.mode = mode;
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  /** Load (or reload) the workspace diff for a source. */
  async reload(source: ChangesSource = this.source): Promise<void> {
    this.source = source;
    const seq = ++this.loadSeq;
    const cwd = this.deps.workingDirectory;
    this.notRepo = !isGitRepo(cwd);
    if (this.notRepo) {
      this.files = [];
      this.commits = [];
      this.error = null;
      this.deps.requestRender();
      return;
    }
    this.loading = true;
    this.deps.requestRender();
    const [diff, summary, commits] = await Promise.all([
      loadDiff(cwd, source, this.deps.getSessionFiles()),
      loadRepoSummary(cwd),
      loadRecentCommits(cwd, 10),
    ]);
    if (seq !== this.loadSeq) return;
    const previousPath = this.currentFile()?.path;
    this.loading = false;
    this.error = diff.error;
    this.label = diff.label;
    this.files = diff.error ? [] : parseChanges(diff.raw);
    this.summary = summary;
    this.commits = commits;
    this.semantic.clear();
    const keep = previousPath ? this.files.findIndex((f) => f.path === previousPath) : -1;
    this.selected = keep >= 0 ? keep : Math.min(this.selected, Math.max(0, this.files.length - 1));
    this.hunkIndex = Math.min(this.hunkIndex, Math.max(0, this.diffHunks().length - 1));
    this.scrollDelta = 0;
    this.ensureSemantic();
    this.deps.requestRender();
  }

  /** Show a diff handed in by something else (preview mode). */
  loadPreview(title: string, diff: string | null, note: string | null): void {
    this.previewTitle = title;
    this.previewNote = note;
    this.files = diff ? parseChanges(diff) : [];
    if (this.files.length === 1 && this.files[0]!.path === 'unknown') this.files = [{ ...this.files[0]!, path: title }];
    this.selected = 0;
    this.hunkIndex = 0;
    this.scrollDelta = 0;
  }

  /** Ask a question over this preview; resolves when answered (Esc or closing answers no). */
  ask(spec: ChangesQuestionSpec): Promise<boolean> {
    this.question?.answer(false);
    return new Promise((resolve) => {
      this.question = { ...spec, chosen: spec.tone === 'danger' || spec.tone === 'warning' ? 0 : 1, answer: resolve };
      this.deps.requestRender();
    });
  }

  private ensureSemantic(): void {
    const file = this.currentFile();
    if (!file || this.mode !== 'workspace' || this.semantic.has(file.path) || file.headerOnly) return;
    this.semantic.set(file.path, undefined);
    void loadSemanticDiff(this.deps.workingDirectory, file.path, 'HEAD').then((result) => {
      this.semantic.set(file.path, result);
      this.deps.requestRender();
    });
  }

  private ensureCommit(commit: CommitEntry): void {
    if (this.commitFiles.has(commit.hash)) return;
    this.commitFiles.set(commit.hash, []);
    void loadCommitDiff(this.deps.workingDirectory, commit.hash).then((result) => {
      this.commitFiles.set(commit.hash, result.error ?? parseChanges(result.raw));
      this.deps.requestRender();
    });
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  private items(): Item[] {
    const items: Item[] = this.files.map((_, index) => ({ kind: 'file', index }));
    if (this.mode === 'workspace') this.commits.forEach((_, index) => items.push({ kind: 'commit', index }));
    return items;
  }

  private currentItem(): Item | null {
    return this.items()[this.selected] ?? null;
  }

  currentFile(): ChangeFile | null {
    const item = this.currentItem();
    return item?.kind === 'file' ? this.files[item.index] ?? null : null;
  }

  private currentCommit(): CommitEntry | null {
    const item = this.currentItem();
    return item?.kind === 'commit' ? this.commits[item.index] ?? null : null;
  }

  /** The files the diff pane shows. */
  diffFiles(): ChangeFile[] {
    const commit = this.currentCommit();
    if (commit) {
      const loaded = this.commitFiles.get(commit.hash);
      return Array.isArray(loaded) ? loaded : [];
    }
    const file = this.currentFile();
    return file ? [file] : [];
  }

  private diffHunks(): Array<{ file: ChangeFile; hunk: ChangeHunk }> {
    return this.diffFiles().flatMap((file) => file.hunks.map((hunk) => ({ file, hunk })));
  }

  currentHunk(): { file: ChangeFile; hunk: ChangeHunk } | null {
    return this.diffHunks()[this.hunkIndex] ?? null;
  }

  private select(index: number): void {
    const count = this.items().length;
    if (count === 0) return;
    this.selected = Math.max(0, Math.min(count - 1, index));
    this.hunkIndex = 0;
    this.scrollDelta = 0;
    const commit = this.currentCommit();
    if (commit) this.ensureCommit(commit);
    else this.ensureSemantic();
  }

  /** ] and [: the next or previous hunk, moving to the next or previous file at the ends. */
  stepHunk(direction: 1 | -1): void {
    const hunks = this.diffHunks();
    const next = this.hunkIndex + direction;
    this.scrollDelta = 0;
    if (next >= 0 && next < hunks.length) {
      this.hunkIndex = next;
      return;
    }
    const item = this.currentItem();
    if (item?.kind !== 'file') return;
    for (let i = item.index + direction; i >= 0 && i < this.files.length; i += direction) {
      if (this.files[i]!.hunks.length === 0) continue;
      this.select(i);
      this.hunkIndex = direction === 1 ? 0 : Math.max(0, this.files[i]!.hunks.length - 1);
      return;
    }
    this.status = { text: direction === 1 ? 'That was the last hunk.' : 'That was the first hunk.', tone: 'faint' };
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private note(text: string, tone: ChangesFootLine['tone'] = 'muted'): void {
    this.status = { text, tone };
    this.deps.requestRender();
  }

  /** Space: stage the selected hunk (unstage it in the staged view). */
  async stageHunk(): Promise<void> {
    const current = this.currentHunk();
    if (!current || this.mode !== 'workspace' || this.currentCommit()) return;
    const reverse = this.source === 'staged';
    const error = await applyHunkToIndex(this.deps.workingDirectory, hunkPatch(current.file, current.hunk), reverse);
    if (error) {
      this.note(`${reverse ? 'Unstage' : 'Stage'} failed: ${error}`, 'error');
      return;
    }
    const range = `${current.file.path}:${current.hunk.review.newStart}`;
    await this.reload();
    this.note(reverse ? `Unstaged the hunk at ${range}.` : `Staged the hunk at ${range}.`, 'success');
  }

  /** S: stage the selected file (unstage it in the staged view). */
  async stageFile(): Promise<void> {
    const file = this.currentFile();
    if (!file || this.mode !== 'workspace') return;
    const stage = this.source !== 'staged';
    const error = await setFileStaged(this.deps.workingDirectory, file.path, stage);
    if (error) {
      this.note(`${stage ? 'Stage' : 'Unstage'} failed: ${error}`, 'error');
      return;
    }
    await this.reload();
    this.note(stage ? `Staged ${file.path}.` : `Unstaged ${file.path}.`, 'success');
  }

  toggleReviewed(): void {
    const file = this.currentFile();
    if (!file) return;
    if (this.reviewed.has(file.path)) this.reviewed.delete(file.path);
    else this.reviewed.add(file.path);
    this.status = { text: this.reviewed.has(file.path) ? `Marked ${file.path} reviewed.` : `${file.path} is no longer marked reviewed.`, tone: 'muted' };
  }

  private openEditor(): void {
    const current = this.currentHunk();
    const file = current?.file ?? this.currentFile();
    if (!file) return;
    if (!this.deps.openInEditor) {
      this.status = { text: 'Opening an editor is not available here.', tone: 'error' };
      return;
    }
    this.deps.openInEditor(file.path, current?.hunk.review.newStart);
  }

  private async revert(): Promise<void> {
    const current = this.currentHunk();
    if (!current || this.mode !== 'workspace' || this.currentCommit()) return;
    if (this.source === 'staged') {
      this.note('Revert works on the working tree; switch the view with v first.', 'faint');
      return;
    }
    if (!this.deps.revertHunk) {
      this.note('Hunk revert is not available in this session.', 'error');
      return;
    }
    const message = await this.deps.revertHunk(current.hunk.review);
    await this.reload();
    this.note(message);
  }

  /** Send every attached comment that has not been sent (closes the modal first). */
  private sendComments(host: SurfaceModalHost): void {
    const pending: HunkComment[] = [...this.comments.values()].filter((c) => !c.sent).map((c) => ({ hunk: c.hunk, comment: c.text }));
    if (pending.length === 0) {
      this.status = { text: 'No comments to send. Press c on a hunk to write one.', tone: 'faint' };
      return;
    }
    if (!this.deps.submitInput) {
      this.status = { text: 'No session is wired to receive comments here.', tone: 'error' };
      return;
    }
    for (const c of this.comments.values()) c.sent = true;
    // Each commented file's semantic summary (when it was read) rides along,
    // so the model sees which functions and imports the change touched.
    const semanticByFile = new Map<string, string>();
    for (const { hunk } of pending) {
      const diff = this.semantic.get(hunk.filePath);
      const summary = diff ? formatSemanticDiffSummary(diff) : '';
      if (summary) semanticByFile.set(hunk.filePath, summary);
    }
    // A turn must never start while a modal owns the keyboard: close first.
    host.close(this, 'done');
    this.deps.submitInput(buildSteerMessage(pending, this.label || CHANGES_SOURCE_LABELS[this.source], semanticByFile));
  }

  private async commit(message: string): Promise<void> {
    const ok = this.deps.confirm
      ? await this.deps.confirm({ title: 'Commit staged changes?', body: message, confirmLabel: 'Commit', tone: 'primary' })
      : true;
    if (!ok) {
      this.note('Commit cancelled.', 'faint');
      return;
    }
    const result = await commitStaged(this.deps.workingDirectory, message);
    if (result.error) {
      this.note(`Commit failed: ${result.error}`, 'error');
      return;
    }
    await this.reload();
    this.note(`Committed ${result.hash.slice(0, 7)}: ${message}`, 'success');
  }

  private async initialize(): Promise<void> {
    const ok = this.deps.confirm
      ? await this.deps.confirm({ title: 'Initialize a git repository?', body: this.deps.workingDirectory, confirmLabel: 'Initialize', tone: 'warning' })
      : false;
    if (!ok) return;
    const error = initRepo(this.deps.workingDirectory);
    if (error) this.note(`git init failed: ${error}`, 'error');
    await this.reload();
  }

  // ── Keys ───────────────────────────────────────────────────────────────────

  escape(): boolean {
    if (this.composing !== null) { this.composing = null; return true; }
    if (this.commitDraft !== null) { this.commitDraft = null; return true; }
    return false;
  }

  onClose(_reason: SurfaceModalCloseReason): void {
    if (this.question) {
      const q = this.question;
      this.question = null;
      q.answer(false);
    }
  }

  private answer(host: SurfaceModalHost, confirmed: boolean): void {
    const q = this.question;
    if (!q) return;
    this.question = null;
    host.close(this, 'done');
    q.answer(confirmed);
  }

  private handleTextEntry(token: InputToken, draft: string, commit: (text: string) => void, cancel: () => void): string {
    if (token.type === 'text') return draft + [...token.value].map((ch) => (ch === '\n' || ch === '\r' ? ' ' : ch)).filter((ch) => ch >= ' ').join('');
    if (token.type !== 'key') return draft;
    const key = token.logicalName ?? '';
    if (key === 'enter') { commit(draft); return draft; }
    if (isTextBackspace(key)) return draft.slice(0, -1);
    if (key === 'escape') cancel();
    return draft;
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    if (this.question) {
      if (token.type === 'text') {
        if (token.value.toLowerCase() === 'y') this.answer(host, true);
        else if (token.value.toLowerCase() === 'n') this.answer(host, false);
        else this.handleNav(token);
        return;
      }
      const key = token.type === 'key' ? token.logicalName ?? '' : '';
      if (key === 'left' || key === 'right' || key === 'tab') { this.question.chosen = this.question.chosen === 0 ? 1 : 0; return; }
      if (key === 'enter') { this.answer(host, this.question.chosen === 1); return; }
      this.handleNav(token);
      return;
    }
    if (this.composing !== null) {
      this.composing = this.handleTextEntry(token, this.composing, (text) => {
        const current = this.currentHunk();
        const trimmed = text.trim();
        if (current && trimmed) {
          this.comments.set(commentKey(current.hunk.review), { hunk: current.hunk.review, text: trimmed, sent: false });
          this.status = { text: 'Comment attached. ⏎ sends every attached comment to the model.', tone: 'muted' };
        }
        this.composing = null;
      }, () => { this.composing = null; });
      return;
    }
    if (this.commitDraft !== null) {
      this.commitDraft = this.handleTextEntry(token, this.commitDraft, (text) => {
        const message = text.trim();
        this.commitDraft = null;
        if (message) void this.commit(message);
      }, () => { this.commitDraft = null; });
      return;
    }
    if (token.type === 'text') {
      this.handleLetter(token.value);
      return;
    }
    if (token.type === 'key' && token.logicalName === 'enter') {
      if (this.mode === 'workspace') this.sendComments(host);
      return;
    }
    if (token.type === 'key' && token.logicalName === 'space') {
      this.handleLetter(' ');
      return;
    }
    this.handleNav(token);
  }

  private handleNav(token: InputToken): void {
    if (token.type === 'text') {
      if (token.value === ']') this.stepHunk(1);
      else if (token.value === '[') this.stepHunk(-1);
      else if (token.value === 'j') this.select(this.selected + 1);
      else if (token.value === 'k') this.select(this.selected - 1);
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    const visible = 12;
    if (key === 'up') this.select(this.selected - 1);
    else if (key === 'down') this.select(this.selected + 1);
    else if (key === 'pagedown') this.scrollDelta += visible;
    else if (key === 'pageup') this.scrollDelta -= visible;
    else if (key === 'home') this.select(0);
    else if (key === 'end') this.select(this.items().length - 1);
    this.clampScroll();
  }

  private clampScroll(): void {
    const lines = this.diffFiles().reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length + 1, 0), 0);
    this.scrollDelta = Math.max(-lines, Math.min(lines, this.scrollDelta));
  }

  private handleLetter(ch: string): void {
    if (ch === ']' || ch === '[' || ch === 'j' || ch === 'k') { this.handleNav({ type: 'text', value: ch }); return; }
    if (this.mode !== 'workspace') return;
    if (this.notRepo) {
      if (ch === 'i') void this.initialize();
      return;
    }
    switch (ch) {
      case ' ': void this.stageHunk(); break;
      case 'S': void this.stageFile(); break;
      case 'c':
        if (this.currentHunk() && !this.currentCommit()) this.composing = this.comments.get(commentKey(this.currentHunk()!.hunk.review))?.text ?? '';
        break;
      case 'm': this.toggleReviewed(); break;
      case 'o': this.openEditor(); break;
      case 'x': void this.revert(); break;
      case 'v': {
        const next = CHANGES_SOURCES[(CHANGES_SOURCES.indexOf(this.source) + 1) % CHANGES_SOURCES.length]!;
        this.selected = 0;
        this.hunkIndex = 0;
        void this.reload(next);
        break;
      }
      case 'r': void this.reload(); break;
      case 'C':
        if ((this.summary?.staged ?? 0) === 0) this.status = { text: 'Nothing is staged to commit. Stage hunks with space or files with S.', tone: 'faint' };
        else this.commitDraft = '';
        break;
      default: break;
    }
  }

  // ── View ───────────────────────────────────────────────────────────────────

  private listRows(): KitRow[] {
    const t = activeTokens();
    const rows: KitRow[] = [];
    const item = this.currentItem();
    if (this.files.length > 0) {
      rows.push({ header: 'Files', headerRight: String(this.files.length) });
      this.files.forEach((file, index) => rows.push({
        label: file.path,
        right: file.removed > 0 ? `+${file.added} −${file.removed}` : `+${file.added}`,
        mark: this.reviewed.has(file.path) ? '✓' : undefined,
        markFg: t.success,
        selected: item?.kind === 'file' && item.index === index,
      }));
    }
    if (this.mode === 'workspace' && this.commits.length > 0) {
      rows.push({ header: 'Recent commits' });
      this.commits.forEach((commit, index) => rows.push({
        spans: [{ text: commit.hash.slice(0, 7), fg: t.textFaint }, { text: ` ${commit.message}` }],
        selected: item?.kind === 'commit' && item.index === index,
      }));
    }
    return rows;
  }

  private sub(): string {
    if (this.mode === 'preview') {
      const totals = changeTotals(this.files);
      return this.files.length > 0 ? `${this.files.length} file${this.files.length === 1 ? '' : 's'} · +${totals.added} −${totals.removed}` : '';
    }
    const totals = changeTotals(this.files);
    const parts: string[] = [];
    if (this.summary) parts.push(this.summary.branch);
    parts.push(`${this.files.length} file${this.files.length === 1 ? '' : 's'}`, `+${totals.added} −${totals.removed}`, CHANGES_SOURCE_LABELS[this.source]);
    return parts.join(' · ');
  }

  private message(): string | null {
    if (this.mode === 'preview') {
      if (this.previewNote && this.files.length === 0) return this.previewNote;
      return this.files.length === 0 ? 'Nothing to show for this preview.' : null;
    }
    if (this.notRepo) return 'Not a git repository here, so there are no changes to show.\nPress i to initialize one (it asks first).';
    if (this.loading && this.files.length === 0 && this.commits.length === 0) return 'Loading changes…';
    if (this.error) return `git could not produce the diff: ${this.error}`;
    const commit = this.currentCommit();
    if (commit) {
      const loaded = this.commitFiles.get(commit.hash);
      if (typeof loaded === 'string') return `git could not show ${commit.hash.slice(0, 7)}: ${loaded}`;
      if (!loaded || loaded.length === 0) return `Loading ${commit.hash.slice(0, 7)} ${commit.message}…`;
      return null;
    }
    if (this.files.length === 0) return `No changes (${this.label || CHANGES_SOURCE_LABELS[this.source]}). Press v to switch between this session, not staged, staged and everything vs HEAD.`;
    return null;
  }

  private foot(): ChangesFootLine[] {
    const lines: ChangesFootLine[] = [];
    if (this.previewNote && this.files.length > 0) lines.push({ text: this.previewNote, tone: 'muted' });
    const current = this.currentHunk();
    if (this.composing !== null) lines.push({ text: `comment: ${this.composing}`, tone: 'text', cursor: true });
    else if (this.commitDraft !== null) lines.push({ text: `commit message: ${this.commitDraft}`, tone: 'text', cursor: true });
    else if (current) {
      const comment = this.comments.get(commentKey(current.hunk.review));
      if (comment) lines.push({ text: `${comment.sent ? 'sent' : 'comment'}: ${comment.text}`, tone: comment.sent ? 'success' : 'text' });
    }
    if (this.status) lines.push({ text: this.status.text, tone: this.status.tone });
    return lines;
  }

  private hints(): KitHint[] {
    if (this.question) return [['⏎', 'choose'], ['y', this.question.confirmLabel.toLowerCase()], ['n', 'cancel'], [']', 'next hunk'], ['↑↓', 'files']];
    if (this.composing !== null) return [['⏎', 'attach comment'], ['esc', 'cancel']];
    if (this.commitDraft !== null) return [['⏎', 'commit'], ['esc', 'cancel']];
    if (this.mode === 'preview') return [['] [', 'next / prev hunk'], ['↑↓', 'files'], ['pgdn', 'scroll']];
    if (this.notRepo) return [['i', 'initialize a repository']];
    const pending = [...this.comments.values()].filter((c) => !c.sent).length;
    const hints: KitHint[] = [
      ['] [', 'next / prev hunk'],
      ['space', this.source === 'staged' ? 'unstage hunk' : 'stage hunk'],
      ['c', 'comment'],
      ['m', 'mark reviewed'],
      ['o', 'open in editor'],
      ['x', 'revert hunk'],
      ['S', this.source === 'staged' ? 'unstage file' : 'stage file'],
      ['C', 'commit'],
      ['v', 'view'],
    ];
    if (pending > 0) hints.push(['⏎', `send ${pending} comment${pending === 1 ? '' : 's'}`]);
    return hints;
  }

  private view(): ChangesModalView {
    const q = this.question;
    const question: ChangesQuestion | null = q
      ? { text: q.text, confirmLabel: q.confirmLabel, cancelLabel: q.cancelLabel ?? 'Cancel', tone: q.tone ?? 'primary', chosen: q.chosen }
      : null;
    const file = this.currentFile();
    const commit = this.currentCommit();
    return {
      title: 'Changes',
      crumbs: this.mode === 'preview' && this.previewTitle ? [this.previewTitle] : commit ? [commit.hash.slice(0, 7)] : [],
      sub: this.sub(),
      listRows: this.mode === 'preview' && this.files.length <= 1 ? [] : this.listRows(),
      diffFiles: this.diffFiles(),
      fileHeaders: this.diffFiles().length > 1,
      hunkIndex: this.hunkIndex,
      scrollDelta: this.scrollDelta,
      semantic: this.mode === 'workspace' && file && !commit && this.semantic.has(file.path) ? this.semantic.get(file.path) : null,
      message: this.message(),
      foot: this.foot(),
      hints: this.hints(),
      question,
      scrollOwner: this,
    };
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderChangesModal(this.view(), screenWidth, screenHeight);
  }
}
