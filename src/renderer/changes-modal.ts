/**
 * renderChangesModal, files, a tinted diff and review actions (replaces the
 * Git, Diff and Review panes).
 *
 *   ✦ Changes  main · 2 files · +45 −1 · this session                      esc
 *
 *   ✦ files                      2     ◈ 2 semantic changes  ~ fn withRetry  + const backoff
 *     src/net/retry.ts       +3 −1
 *   ✓ test/retry.test.ts       +42     ┌ element panel ──────────────────────────────┐
 *                                         ⋯ line 9                        hunk 1 of 2
 *   ✦ recent commits                      9    try {
 *     a41c09e init                       13 -    await sleep(opts.baseDelayMs);
 *                                        13 +    if (i === opts.attempts - 1) break;
 *
 *   ] [ next / prev hunk   space stage hunk   c comment   m mark reviewed   o open in editor
 *
 * Changed rows keep their syntax colors; the change shows as a background tint
 * across the row and a separate tint on the line-number gutter (the theme's
 * diff tokens, pushed further from the panel fill when a theme's tint sits too
 * close to it; see diff-tint.ts). Long lines wrap under their own gutter. The semantic summary
 * (tree-sitter) leads the pane. A preview (a fleet candidate, a rewind or an
 * attempt) can carry a question with its two buttons on the first body row.
 */

import { activeDiffTones, activeTokens } from './theme.ts';
import { beginModal, finishModal, clipText, scrollCountText, wrapLines, type KitHint, type ModalFrame, type SurfaceCanvas, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { button, buttonWidth, panel, type KitPanel } from './surface-kit-parts.ts';
import { drawTextBlock, splitPanes } from './surface-kit-extra.ts';
import { highlightCodeLines, syntaxHighlightGeneration, syntaxHighlightMisses } from './code-block.ts';
import type { SemanticDiff } from './semantic-diff.ts';
import { diffRowTints } from './diff-tint.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { languageForPath, type ChangeFile, type ChangeHunk, type ChangeLine } from '../input/changes-model.ts';

/** A question asked over a preview (pick this candidate? restore this checkpoint?). */
export interface ChangesQuestion {
  readonly text: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly tone: 'danger' | 'warning' | 'primary';
  /** 0 = cancel (left), 1 = confirm (right). */
  readonly chosen: 0 | 1;
}

/** One line of text under the diff (a comment, a status, the comment being typed). */
export interface ChangesFootLine {
  readonly text: string;
  readonly tone: 'muted' | 'faint' | 'text' | 'error' | 'success';
  /** Draw a cursor after the text (an input being typed). */
  readonly cursor?: boolean;
}

/** What the renderer reads from the modal. */
export interface ChangesModalView {
  readonly title: string;
  readonly crumbs: readonly string[];
  readonly sub: string;
  /** The left list: files, then recent commits (built by the modal, selection included). */
  readonly listRows: readonly KitRow[];
  /** Files shown in the diff pane (one file, or every file of a commit or preview). */
  readonly diffFiles: readonly ChangeFile[];
  /** Draw a path row above each file's hunks (more than one file in the pane). */
  readonly fileHeaders: boolean;
  /** The selected hunk, counted across diffFiles. */
  readonly hunkIndex: number;
  /** Lines scrolled from the selected hunk's first row (pgup / pgdn). */
  readonly scrollDelta: number;
  /** The semantic summary for the shown file: undefined while loading, null when there is none. */
  readonly semantic: SemanticDiff | null | undefined;
  /** Shown instead of a diff (a preview that is text, an empty state, an error). */
  readonly message: string | null;
  readonly foot: readonly ChangesFootLine[];
  readonly hints: readonly KitHint[];
  readonly question: ChangesQuestion | null;
  /** Owner for remembered list scroll positions. */
  readonly scrollOwner: object;
}

/** Width of the line-number gutter inside a diff panel. */
const DIFF_GUTTER = 5;
const GUTTER = DIFF_GUTTER;

/** One drawn row of a diff: a file header, a hunk separator, or a (wrapped) code line. */
export type DiffRow =
  | { readonly kind: 'file'; readonly text: string }
  | { readonly kind: 'sep'; readonly hunk: number; readonly text: string }
  | { readonly kind: 'line'; readonly hunk: number; readonly line: ChangeLine; readonly first: boolean; readonly text: string; readonly tokens: ReadonlyArray<{ text: string; fg: string; bold?: boolean; italic?: boolean }> | null };

/** Syntax tokens per hunk, remembered until the theme changes. */
/** A hunk's tokens; `generation` is set when they were the regex placeholder (a parse was on its way). */
const tokenMemo = new WeakMap<ChangeHunk, { theme: object; lines: ReturnType<typeof highlightCodeLines>; generation: number | undefined }>();

function hunkTokens(file: ChangeFile, hunk: ChangeHunk): ReturnType<typeof highlightCodeLines> {
  const theme = activeTokens();
  const memo = tokenMemo.get(hunk);
  // Placeholder tokens are kept only until the hunk's parse lands.
  if (memo && memo.theme === theme && (memo.generation === undefined || memo.generation === syntaxHighlightGeneration())) return memo.lines;
  const missesBefore = syntaxHighlightMisses();
  const lines = highlightCodeLines(hunk.lines.map((line) => line.text), languageForPath(file.path));
  tokenMemo.set(hunk, { theme, lines, generation: syntaxHighlightMisses() !== missesBefore ? syntaxHighlightGeneration() : undefined });
  return lines;
}

/** Split syntax tokens into rows of at most `width` cells. */
function wrapTokens(tokens: ReadonlyArray<{ text: string; fg: string; bold?: boolean; italic?: boolean }>, width: number): Array<Array<{ text: string; fg: string; bold?: boolean; italic?: boolean }>> {
  const rows: Array<Array<{ text: string; fg: string; bold?: boolean; italic?: boolean }>> = [[]];
  let used = 0;
  for (const token of tokens) {
    let piece = '';
    for (const ch of token.text.replace(/\t/g, '  ')) {
      const w = getDisplayWidth(ch);
      if (w <= 0) continue;
      if (used + w > width) {
        if (piece) rows[rows.length - 1]!.push({ ...token, text: piece });
        rows.push([]);
        piece = '';
        used = 0;
      }
      piece += ch;
      used += w;
    }
    if (piece) rows[rows.length - 1]!.push({ ...token, text: piece });
  }
  return rows;
}

function buildRows(view: ChangesModalView, codeWidth: number): { rows: DiffRow[]; hunkStarts: number[] } {
  return buildDiffRows(view.diffFiles, codeWidth, view.fileHeaders);
}

/**
 * The rows a diff draws as, code wrapped to `codeWidth` under its own gutter.
 * Shared with the conversation work tree, which draws an opened edit with the
 * same rows (lane-graph/paint.ts).
 */
export function buildDiffRows(diffFiles: readonly ChangeFile[], codeWidth: number, fileHeaders: boolean): { rows: DiffRow[]; hunkStarts: number[] } {
  const rows: DiffRow[] = [];
  const hunkStarts: number[] = [];
  let hunkNo = 0;
  const total = diffFiles.reduce((n, f) => n + f.hunks.length, 0);
  for (const file of diffFiles) {
    if (fileHeaders) rows.push({ kind: 'file', text: `${file.path}  +${file.added} −${file.removed}` });
    if (file.headerOnly) {
      const why = file.note ?? (file.headerLines.some((l) => l.startsWith('Binary')) ? 'binary file, no line changes to show' : 'no line changes (mode or rename only)');
      rows.push({ kind: 'file', text: why });
      continue;
    }
    for (const hunk of file.hunks) {
      hunkStarts.push(rows.length);
      rows.push({ kind: 'sep', hunk: hunkNo, text: `⋯ line ${hunk.review.newStart}` + (total > 1 ? `  ·  hunk ${hunkNo + 1} of ${total}` : '') });
      const tokens = hunkTokens(file, hunk);
      hunk.lines.forEach((line, i) => {
        if (line.kind === 'note') {
          rows.push({ kind: 'line', hunk: hunkNo, line, first: true, text: line.text, tokens: null });
          return;
        }
        const wrapped = wrapTokens(tokens[i] ?? [{ text: line.text, fg: activeTokens().text }], codeWidth);
        wrapped.forEach((part, k) => rows.push({ kind: 'line', hunk: hunkNo, line, first: k === 0, text: '', tokens: part }));
      });
      hunkNo++;
    }
  }
  return { rows, hunkStarts };
}

/**
 * Draw one diff row inside panel `p`: the change tint across the row, a
 * separate tint on the line-number gutter, the number, the sign and the
 * syntax-colored code. `lineNumbers: false` leaves the numbers out (a diff
 * whose line numbers are not known).
 */
export function drawDiffRow(canvas: SurfaceCanvas, p: KitPanel, y: number, row: DiffRow, selectedHunk: number, options: { readonly lineNumbers?: boolean } = {}): void {
  const t = activeTokens();
  if (row.kind === 'file') {
    canvas.put(p.l, y, clipText(row.text, p.r - p.l + 1), { fg: t.text, bold: true, bg: p.bg });
    return;
  }
  const tones = activeDiffTones();
  if (row.kind === 'sep') {
    const on = row.hunk === selectedHunk;
    canvas.put(p.l, y, clipText(row.text, p.r - p.l + 1), { fg: on ? t.brand : tones.hunk, bold: on, bg: p.bg });
    return;
  }
  const line = row.line;
  const gutterEnd = p.l + GUTTER - 1;
  if (line.kind === 'add' || line.kind === 'del') {
    const tints = diffRowTints(p.bg);
    canvas.tint(p.x, y, p.w, line.kind === 'add' ? tints.addedRow : tints.removedRow);
    canvas.tint(p.x, y, gutterEnd - p.x + 2, line.kind === 'add' ? tints.addedGutter : tints.removedGutter);
  }
  if (line.kind === 'note') {
    canvas.put(p.l + GUTTER + 3, y, clipText(row.text, p.r - p.l - GUTTER - 2), { fg: t.textFaint });
    return;
  }
  if (row.first) {
    const n = line.kind === 'del' ? line.oldNo : line.newNo;
    if (n !== null && options.lineNumbers !== false) canvas.right(gutterEnd, y, String(n).slice(-GUTTER), { fg: t.diffLineNumber });
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    canvas.put(gutterEnd + 2, y, sign, { fg: line.kind === 'add' ? tones.add : line.kind === 'del' ? tones.del : t.textFaint });
  }
  let x = gutterEnd + 4;
  for (const token of row.tokens ?? []) x = canvas.put(x, y, token.text, { fg: token.fg, bold: token.bold, italic: token.italic });
}

/** The ◈ summary's chips ("~ fn withRetry", "+ import x"), colored by kind. */
export function semanticChips(diff: SemanticDiff): Array<{ text: string; fg: string }> {
  const t = activeTokens();
  const chips: Array<{ text: string; fg: string }> = [];
  for (const s of diff.symbols) {
    const glyph = s.kind === 'added' ? '+' : s.kind === 'removed' ? '-' : '~';
    chips.push({ text: `${glyph} ${s.symbolKind === 'function' ? 'fn' : s.symbolKind} ${s.name}`, fg: s.kind === 'added' ? t.success : s.kind === 'removed' ? t.error : t.warning });
  }
  for (const i of diff.imports) {
    const glyph = i.kind === 'added' ? '+' : i.kind === 'removed' ? '-' : '~';
    chips.push({ text: `${glyph} import ${i.specifier}`, fg: i.kind === 'added' ? t.success : i.kind === 'removed' ? t.error : t.warning });
  }
  return chips;
}

/** The ◈ summary row(s); returns the row after them. */
function drawSemantic(f: ModalFrame, view: ChangesModalView, x: number, xr: number, y: number): number {
  const t = activeTokens();
  const { canvas } = f;
  if (view.semantic === undefined) {
    canvas.put(x, y, clipText('◈ reading the structure of this file…', xr - x + 1), { fg: t.textFaint });
    return y + 2;
  }
  if (view.semantic === null || view.semantic.totalChanges === 0) return y;
  canvas.put(x, y, '◈', { fg: t.brandEnd });
  const head = `${view.semantic.totalChanges} semantic change${view.semantic.totalChanges === 1 ? '' : 's'}`;
  let cx = canvas.put(x + 2, y, clipText(head, xr - x - 1), { fg: t.text, bold: true }) + 2;
  let yy = y;
  const chips = semanticChips(view.semantic);
  chips.forEach((chip, k) => {
    const w = getDisplayWidth(chip.text);
    const rest = chips.length - k;
    if (cx + w > xr) {
      // Wrap chips onto one more row, then fold the rest into a count.
      if (yy > y) return;
      yy++;
      cx = x + 2;
    }
    if (yy > y && cx + w > xr - 8 && rest > 1) {
      canvas.put(cx, yy, `+${rest} more`, { fg: t.textFaint });
      cx = xr + 1;
      return;
    }
    if (cx + w > xr) return;
    cx = canvas.put(cx, yy, chip.text, { fg: chip.fg }) + 2;
  });
  return yy + 2;
}

function drawQuestion(f: ModalFrame, q: ChangesQuestion, y: number): number {
  const t = activeTokens();
  const width = f.r - f.l + 1;
  const buttonsW = buttonWidth(q.cancelLabel) + 2 + buttonWidth(q.confirmLabel);
  const textW = width >= 70 ? width - buttonsW - 3 : width;
  const lines = wrapLines(q.text, textW);
  lines.forEach((line, k) => f.canvas.put(f.l, y + k, line, { fg: t.text, bold: k === 0 }));
  const by = width >= 70 ? y : y + lines.length;
  let bx = f.r - buttonsW + 1;
  bx = button(f.canvas, bx, by, q.cancelLabel, q.chosen === 0) + 2;
  button(f.canvas, bx, by, q.confirmLabel, q.chosen === 1, q.tone);
  return Math.max(y + lines.length, by + 1) + 1;
}

function drawDiffPane(f: ModalFrame, view: ChangesModalView, x: number, xr: number, top: number, bottom: number): void {
  const t = activeTokens();
  const { canvas } = f;
  let y = top;
  if (view.message !== null) {
    drawTextBlock(canvas, x, y, xr - x + 1, view.message.split('\n').map((text) => ({ text, style: { fg: t.textMuted } })), bottom);
    return;
  }
  y = drawSemantic(f, view, x, xr, y);
  // Foot lines under the diff (comment, status), each wrapped in full.
  const footRows = view.foot.reduce((n, line) => n + wrapLines(line.text, xr - x + 1).length, 0);
  const panelBottom = bottom - (footRows > 0 ? footRows + 1 : 0);
  if (panelBottom - y + 1 >= 3) {
    const p = panel(canvas, x - 2, y, xr - x + 5, panelBottom - y + 1);
    const codeWidth = Math.max(8, p.r - (p.l + GUTTER + 3) + 1);
    const { rows, hunkStarts } = buildRows(view, codeWidth);
    const capacity = p.bottom - p.top + 1;
    const anchor = hunkStarts[Math.max(0, Math.min(view.hunkIndex, hunkStarts.length - 1))] ?? 0;
    const start = Math.max(0, Math.min(anchor + view.scrollDelta, Math.max(0, rows.length - capacity)));
    for (let k = 0; k < capacity && start + k < rows.length; k++) drawDiffRow(canvas, p, p.top + k, rows[start + k]!, view.hunkIndex);
    const hidden = scrollCountText(start, Math.max(0, rows.length - start - capacity)).replace(/more/g, 'lines');
    if (hidden) f.hintRight = hidden;
  }
  let fy = panelBottom + 2;
  for (const line of view.foot) {
    const fg = line.tone === 'error' ? t.error : line.tone === 'success' ? t.success : line.tone === 'faint' ? t.textFaint : line.tone === 'text' ? t.text : t.textMuted;
    const wrapped = wrapLines(line.text, xr - x + 1);
    wrapped.forEach((part, k) => {
      if (fy > bottom) return;
      const end = canvas.put(x, fy, part, { fg });
      if (line.cursor && k === wrapped.length - 1) canvas.put(end, fy, '▏', { fg: t.brand });
      fy++;
    });
  }
}

export function renderChangesModal(view: ChangesModalView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const f = beginModal(screenWidth, screenHeight, {
    title: view.title,
    crumbs: view.crumbs,
    sub: view.sub,
    hints: view.hints,
    cap: view.question ? (view.question.tone === 'danger' ? 'danger' : 'warning') : 'brand',
  });
  let top = f.top;
  if (view.question) top = drawQuestion(f, view.question, top);
  if (view.listRows.length === 0) {
    drawDiffPane(f, view, f.l, f.r, top, f.bottom);
    return finishModal(f);
  }
  const split = splitPanes(f.l, f.r, top, f.bottom, 0.3, 4);
  drawList(f.canvas, { rows: view.listRows, top: split.top, bottom: split.bottom, x0: split.x0, x1: split.x1, scrollKey: { owner: view.scrollOwner, name: 'files' } });
  const paneX = split.stacked ? f.l : split.panelX + 2;
  const paneTop = split.stacked ? split.panelY : split.top;
  drawDiffPane(f, view, paneX, f.r, paneTop, f.bottom);
  return finishModal(f);
}
