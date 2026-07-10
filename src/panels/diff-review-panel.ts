// ---------------------------------------------------------------------------
// DiffReviewPanel — comment-on-hunk review loop.
//
// Shows the current session's file changes per-file and hunk-boundaried, lets
// the user select a hunk, attach a comment, and submit that comment to the
// session as a steering message carrying structured context (file path, new-file
// line range, and a short patch excerpt) so the model knows exactly what the
// comment targets.
//
// Data source (labelled honestly in the panel): `git diff <base> -- <files>`,
// where <files> is the set the SDK SessionChangeTracker recorded this session.
// That is CURRENT working-tree content vs the base ref — not a turn-start
// snapshot. The panel never presents a stale diff as current.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';
import { BasePanel } from './base-panel.ts';
import { DIFF_TONES, UI_TONES } from '../renderer/ui-primitives.ts';
import {
  buildEmptyState,
  buildPanelWorkspace,
  buildStyledPanelLine,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
} from './polish.ts';
import { isPanelSearchBackspace, isPanelSearchCancel, isPanelSearchCommit, isPanelSearchPrintable } from './search-focus.ts';
import { appendSteerText } from './fleet-tabs.ts';
import {
  parseReviewDiff,
  flattenHunks,
  hunkLineRange,
  buildSteerMessage,
  type ReviewFile,
  type ReviewHunk,
  type HunkComment,
} from './diff-review-model.ts';

const COLOR = extendPalette(DEFAULT_PANEL_PALETTE, {
  addition: DIFF_TONES.add,
  deletion: DIFF_TONES.del,
  hunk: DIFF_TONES.hunk,
} as const);

/** A comment attached to a hunk plus whether it has already been steered to the session. */
interface CommentState {
  comment: string;
  submitted: boolean;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? p;
}

export class DiffReviewPanel extends BasePanel {
  public override isTransient = true;

  private readonly workingDirectory: string;
  private readonly getChangedFiles: (() => string[]) | undefined;
  private files: ReviewFile[] = [];
  private hunks: ReviewHunk[] = [];
  private cursor = 0;
  private scrollOffset = 0;
  /** Comments keyed by `${fileIndex}:${hunkIndex}`. */
  private comments = new Map<string, CommentState>();
  private composing = false;
  private draft = '';
  private submitSteer: ((text: string) => void) | null = null;
  private sourceLabel = 'working tree vs HEAD (files edited this session)';
  private status: string | null = null;
  /** True once a load has completed (so the empty state can distinguish "no changes" from "not loaded"). */
  private loaded = false;

  constructor(
    workingDirectory: string,
    private readonly requestRender: () => void = () => {},
    getChangedFiles?: () => string[],
  ) {
    super('review', 'Review', 'R', 'development');
    this.workingDirectory = workingDirectory;
    this.getChangedFiles = getChangedFiles;
  }

  // -------------------------------------------------------------------------
  // Public API — driven by the /review command
  // -------------------------------------------------------------------------

  /** Wire the steering submit path (the /review command passes ctx.submitInput). */
  setSubmit(fn: (text: string) => void): void {
    this.submitSteer = fn;
  }

  private keyFor(hunk: ReviewHunk): string {
    return `${hunk.fileIndex}:${hunk.hunkIndex}`;
  }

  private currentHunk(): ReviewHunk | null {
    return this.hunks[this.cursor] ?? null;
  }

  /** Adopt a parsed review set with an explicit provenance label. */
  loadReview(files: ReviewFile[], sourceLabel: string): void {
    this.files = files;
    this.hunks = flattenHunks(files);
    this.cursor = 0;
    this.scrollOffset = 0;
    this.comments.clear();
    this.composing = false;
    this.draft = '';
    this.sourceLabel = sourceLabel;
    this.loaded = true;
    this.markDirty();
  }

  /**
   * Load the session's changed files as a git diff against `ref` (default HEAD)
   * and parse it into per-file hunks. Honest source: current working-tree
   * content vs the base ref, restricted to files this session edited.
   */
  async loadSessionReview(ref = 'HEAD'): Promise<void> {
    if (!GitService.isGitRepo(this.workingDirectory)) {
      this.status = 'Not a git repository — no working-tree diff to review.';
      this.loaded = true;
      this.markDirty();
      return;
    }
    const files = (this.getChangedFiles?.() ?? []).filter(Boolean);
    const args = ['diff', ref, '--', ...files];
    const wholeRepo = files.length === 0;
    const proc = Bun.spawn(['git', ...(wholeRepo ? ['diff', ref] : args)], { stdout: 'pipe', stderr: 'pipe', cwd: this.workingDirectory });
    const [raw, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      this.status = `git diff failed: ${errText.trim() || 'unknown error'}`;
      this.loaded = true;
      this.markDirty();
      return;
    }
    const label = wholeRepo
      ? `working tree vs ${ref} (no session-tracked files; showing whole working tree)`
      : `working tree vs ${ref} (${files.length} file${files.length === 1 ? '' : 's'} edited this session)`;
    this.loadReview(parseReviewDiff(raw), label);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    if (this.composing) return this.handleComposerInput(key);
    switch (key) {
      case 'up': case 'k': this.moveCursor(-1); return true;
      case 'down': case 'j': this.moveCursor(1); return true;
      case 'tab': this.jumpFile(1); return true;
      case '\x1b[Z': case 'shift-tab': case 'backtab': this.jumpFile(-1); return true;
      case 'pageup': this.moveCursor(-5); return true;
      case 'pagedown': this.moveCursor(5); return true;
      case 'c': this.openComposer(); return true;
      case 'x': this.clearComment(); return true;
      case 'a': this.submitAll(); return true;
      case 'enter': case 'return': this.submitCurrent(); return true;
      default: return false;
    }
  }

  private handleComposerInput(key: string): boolean {
    if (isPanelSearchCancel(key)) {
      this.composing = false;
      this.draft = '';
      this.status = 'Comment cancelled.';
      this.markDirty();
      return true;
    }
    if (isPanelSearchCommit(key)) {
      const hunk = this.currentHunk();
      const text = this.draft.trim();
      if (hunk && text.length > 0) {
        this.comments.set(this.keyFor(hunk), { comment: text, submitted: false });
        this.status = 'Comment attached. Press Enter to send it, or a to send all.';
      } else {
        this.status = 'Empty comment discarded.';
      }
      this.composing = false;
      this.draft = '';
      this.markDirty();
      return true;
    }
    if (isPanelSearchBackspace(key)) {
      this.draft = this.draft.slice(0, -1);
      this.markDirty();
      return true;
    }
    if (key.length === 1 && (isPanelSearchPrintable(key) || key === '\r' || key === '\n')) {
      this.draft = appendSteerText(this.draft, key);
      this.markDirty();
      return true;
    }
    return true; // swallow other keys while composing
  }

  private moveCursor(delta: number): void {
    if (this.hunks.length === 0) return;
    this.cursor = Math.max(0, Math.min(this.hunks.length - 1, this.cursor + delta));
    this.markDirty();
  }

  private jumpFile(direction: number): void {
    const cur = this.currentHunk();
    if (!cur) return;
    const targetFile = cur.fileIndex + direction;
    const idx = this.hunks.findIndex((h) => h.fileIndex === targetFile);
    if (idx >= 0) {
      this.cursor = idx;
      this.markDirty();
    }
  }

  private openComposer(): void {
    const hunk = this.currentHunk();
    if (!hunk) return;
    this.composing = true;
    this.draft = this.comments.get(this.keyFor(hunk))?.comment ?? '';
    this.status = null;
    this.markDirty();
  }

  private clearComment(): void {
    const hunk = this.currentHunk();
    if (!hunk) return;
    if (this.comments.delete(this.keyFor(hunk))) {
      this.status = 'Comment removed.';
      this.markDirty();
    }
  }

  private steer(items: HunkComment[]): boolean {
    if (!this.submitSteer) {
      this.status = 'No session is wired to receive steering here.';
      this.markDirty();
      return false;
    }
    if (items.length === 0) {
      this.status = 'No comment to send. Press c to write one.';
      this.markDirty();
      return false;
    }
    this.submitSteer(buildSteerMessage(items, this.sourceLabel));
    for (const { hunk } of items) {
      const state = this.comments.get(this.keyFor(hunk));
      if (state) state.submitted = true;
    }
    this.status = items.length === 1
      ? 'Comment sent to the session as a steering message.'
      : `${items.length} comments sent to the session as one steering message.`;
    this.markDirty();
    this.requestRender();
    return true;
  }

  private submitCurrent(): void {
    const hunk = this.currentHunk();
    if (!hunk) return;
    const state = this.comments.get(this.keyFor(hunk));
    if (!state || state.comment.length === 0) {
      this.status = 'This hunk has no comment yet. Press c to write one.';
      this.markDirty();
      return;
    }
    this.steer([{ hunk, comment: state.comment }]);
  }

  private submitAll(): void {
    const items: HunkComment[] = [];
    for (const hunk of this.hunks) {
      const state = this.comments.get(this.keyFor(hunk));
      if (state && !state.submitted && state.comment.length > 0) items.push({ hunk, comment: state.comment });
    }
    this.steer(items);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  private hunkRow(hunk: ReviewHunk, isCursor: boolean, width: number): Line {
    const state = this.comments.get(this.keyFor(hunk));
    const marker = !state ? '   ' : state.submitted ? '[✓]' : '[c]';
    const range = hunkLineRange(hunk);
    const label = `${marker} ${basename(hunk.filePath)}:${range.start}-${range.end}  +${hunk.added} -${hunk.removed}`;
    return buildStyledPanelLine(width, [{
      text: truncateDisplay(`${isCursor ? '▸ ' : '  '}${label}`, width),
      fg: state?.submitted ? COLOR.addition : isCursor ? COLOR.value : COLOR.dim,
      bg: isCursor ? UI_TONES.bg.selected : undefined,
      bold: isCursor,
    }]);
  }

  private detailLines(hunk: ReviewHunk, width: number): Line[] {
    const lines: Line[] = [];
    lines.push(buildStyledPanelLine(width, [{ text: truncateDisplay(` ${hunk.filePath}`, width), fg: COLOR.value, bold: true }]));
    lines.push(buildStyledPanelLine(width, [{ text: truncateDisplay(` ${hunk.header}`, width), fg: COLOR.hunk }]));
    for (const raw of hunk.bodyLines.slice(0, 8)) {
      const fg = raw.startsWith('+') ? COLOR.addition : raw.startsWith('-') ? COLOR.deletion : COLOR.dim;
      lines.push(buildStyledPanelLine(width, [{ text: truncateDisplay(` ${raw}`, width), fg }]));
    }
    const state = this.comments.get(this.keyFor(hunk));
    if (this.composing) {
      lines.push(buildStyledPanelLine(width, [{ text: truncateDisplay(` comment> ${this.draft}_`, width), fg: COLOR.value, bold: true }]));
    } else if (state) {
      const tag = state.submitted ? '(sent)' : '(unsent)';
      lines.push(buildStyledPanelLine(width, [{ text: truncateDisplay(` comment ${tag}: ${state.comment}`, width), fg: state.submitted ? COLOR.addition : COLOR.value }]));
    }
    return lines;
  }

  private footer(width: number): Line {
    const hints = this.composing
      ? ' Enter attach  Esc cancel'
      : ' ↑/↓ hunk  Tab file  c comment  Enter send  a send all  x clear';
    const text = this.status ? `${hints}  •  ${this.status}` : hints;
    return buildStyledPanelLine(width, [{ text: truncateDisplay(text, width), fg: COLOR.dim, bg: COLOR.sectionBg }], { fillBg: COLOR.sectionBg });
  }

  render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
      if (height <= 0 || width <= 0) return [];
      if (this.hunks.length === 0) {
        const detail = this.loaded
          ? (this.status ?? 'No changes to review. Files edited this session appear here as hunks.')
          : 'Loading session changes…';
        return buildPanelWorkspace(width, height, {
          title: 'Review',
          palette: COLOR,
          sections: [{ title: 'Review', lines: buildEmptyState(width, ' Nothing to review yet.', detail, [{ command: '/review', summary: 'load this session\'s file changes as commentable hunks' }], COLOR) }],
        });
      }

      const hunk = this.currentHunk();
      const listLines = this.hunks.map((h, i) => this.hunkRow(h, i === this.cursor, width));
      const section = resolveScrollablePanelSection(width, height, {
        palette: COLOR,
        footerLines: [this.footer(width)],
        beforeSections: [{ title: `Selected hunk (${this.sourceLabel})`, lines: hunk ? this.detailLines(hunk, width) : [] }],
        section: { title: `Hunks (${this.cursor + 1}/${this.hunks.length})`, scrollableLines: listLines, scrollOffset: this.scrollOffset, selectedIndex: this.cursor, minRows: 1 },
      });
      this.scrollOffset = section.scrollOffset;

      return buildPanelWorkspace(width, height, {
        title: 'Review',
        palette: COLOR,
        footerLines: [this.footer(width)],
        sections: [
          { title: `Selected hunk (${this.sourceLabel})`, lines: hunk ? this.detailLines(hunk, width) : [createEmptyLine(width)] },
          { title: section.section.title, lines: section.section.lines },
        ],
      });
    });
  }
}
