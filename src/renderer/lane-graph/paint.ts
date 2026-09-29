/**
 * lane-graph/paint.ts, drawing the work tree's rows into transcript lines.
 *
 * Columns (screen width W, gutter starting at GUTTER_X):
 *   - the gutter from GUTTER_X, 2 columns per lane (layout.ts)
 *   - ▸ / ▾ two columns left of the text column when a bead has a body
 *   - name and key argument from the text column
 *   - the result summary right-aligned so it ends 9 columns left of the time
 *   - the time right-aligned so it ends at column W-4
 *
 * An opened body is a fill from the text column to W-4 with 2 columns of side
 * padding and a padding row above and below; the lanes keep running down the
 * gutter beside it. The focused row gets a fill from column 1 to W-2 and the
 * brand ┃ in column 0.
 */

import { createEmptyLine, createStyledCell, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { activeTokens } from '../theme.ts';
import { expandTabs, getDisplayWidth, truncateDisplay, wrapPreservingIndent } from '../../utils/terminal-width.ts';
import { SurfaceCanvas } from '../surface-kit.ts';
import { panel, type KitPanel } from '../surface-kit-parts.ts';
import { buildDiffRows, drawDiffRow, semanticChips, type DiffRow } from '../changes-modal.ts';
import { highlightCodeLines } from '../code-block.ts';
import { languageForPath, parseChanges } from '../../input/changes-model.ts';
import type { SemanticDiff } from '../semantic-diff.ts';
import { glyphText, type LaneGlyphs } from './glyphs.ts';
import type { GutterRow } from './layout.ts';
import type { BeadBody, BeadStatus, BeadSummary, BodyTone, ReadBodyFile, SummaryTone } from './bead.ts';

/** Column where every turn's gutter starts (one right of the ┃ bar column). */
const GUTTER_X = 3;
/** Columns between the end of the summary and the end of the time. */
const SUMMARY_GAP = 9;
/** Rows an output, list or text body shows before "… N more". */
const BODY_CAP = 12;
/** Rows a diff body shows before "… N more lines". */
const DIFF_CAP = 40;

export interface GraphPaint {
  readonly width: number;
  /** Columns from GUTTER_X to the turn's text column (layout.gutterWidth). */
  readonly gutterWidth: number;
  readonly glyphs: LaneGlyphs;
  /** Spinner frame for running beads. */
  readonly frame: number;
}

/** The turn's text column. */
export function textColumn(p: Pick<GraphPaint, 'gutterWidth'>): number {
  return GUTTER_X + p.gutterWidth;
}

/** Column the time's last character sits on. */
function timeEnd(width: number): number {
  return width - 4;
}

/** Added to every lane index while an agent view draws (its spine takes the agent's color). */
let laneColorBase = 0;

/** A lane's color: the theme's `lanes` tokens in rotation. */
export function laneColor(index: number): string {
  const lanes = activeTokens().lanes;
  if (lanes.length === 0) return activeTokens().brand;
  const at = index + laneColorBase;
  return lanes[((at % lanes.length) + lanes.length) % lanes.length]!;
}

/**
 * Draw with every lane shifted by `base`: an agent opened full screen draws
 * its own spine in the color its lane has in main, and its children in the
 * colors after it. Synchronous; the base is restored afterwards.
 */
export function withLaneColorBase<T>(base: number, draw: () => T): T {
  const previous = laneColorBase;
  laneColorBase = base;
  try {
    return draw();
  } finally {
    laneColorBase = previous;
  }
}

function summaryColor(tone: SummaryTone): string {
  const t = activeTokens();
  return tone === 'good' ? t.success : tone === 'warn' ? t.warning : tone === 'bad' ? t.error : t.textFaint;
}

function bodyColor(tone: BodyTone): string {
  const t = activeTokens();
  switch (tone) {
    case 'good': return t.success;
    case 'bad': return t.error;
    case 'warn': return t.warning;
    case 'muted': return t.textMuted;
    case 'faint': return t.textFaint;
    default: return t.text;
  }
}

interface TextStyle {
  readonly fg: string;
  readonly bold?: boolean;
  readonly strikethrough?: boolean;
  readonly bg?: string;
}

/** Row text in the active glyph set (plain ASCII for the ascii set). */
function tx(p: Pick<GraphPaint, 'glyphs'>, text: string): string {
  return glyphText(text, p.glyphs);
}

/** Write text from `x`, never past `endExclusive`; returns the column after it. */
function putText(line: Line, x: number, endExclusive: number, text: string, style: TextStyle): number {
  let col = x;
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (col + w > endExclusive || col + w > line.length) break;
    const prev = line[col]!;
    line[col] = createStyledCell(ch, { fg: style.fg, bg: style.bg ?? prev.bg, bold: style.bold ?? false, strikethrough: style.strikethrough ?? false });
    if (w > 1) line[col + 1] = createStyledCell('', { fg: style.fg, bg: style.bg ?? prev.bg });
    col += w;
  }
  return col;
}

/** Write text so its last column is `xr`; returns its first column. */
function putRight(line: Line, xr: number, text: string, style: TextStyle): number {
  const start = xr - getDisplayWidth(text) + 1;
  putText(line, start, xr + 1, text, style);
  return start;
}

/** The character a bead's status draws as, and its color. */
function beadMark(status: BeadStatus, glyphs: LaneGlyphs, lane: string, frame: number): { char: string; fg: string } {
  const t = activeTokens();
  switch (status) {
    case 'ok': return { char: glyphs.ok, fg: t.success };
    case 'warn': return { char: glyphs.warn, fg: t.warning };
    case 'err': return { char: glyphs.err, fg: t.error };
    case 'run': return { char: glyphs.run[frame % glyphs.run.length]!, fg: lane };
    case 'wait': return { char: glyphs.wait, fg: t.warning };
    case 'cancel': return { char: glyphs.cancel, fg: t.textFaint };
    case 'bg': return { char: glyphs.background, fg: t.success };
  }
}

/**
 * Draw a gutter row onto `line` from GUTTER_X. The bead cell (if any) draws
 * as `beadStatus`'s mark; lane lines keep their lane's color.
 */
export function paintGutter(line: Line, row: GutterRow, p: GraphPaint, beadStatus?: BeadStatus): void {
  for (let col = 0; col < row.length; col++) {
    const cell = row[col];
    const x = GUTTER_X + col;
    if (!cell || x >= line.length) continue;
    const lane = laneColor(cell.color);
    const bg = line[x]!.bg;
    if (cell.role === 'bead') {
      const mark = beadMark(beadStatus ?? 'ok', p.glyphs, lane, p.frame);
      line[x] = createStyledCell(mark.char, { fg: mark.fg, bg, bold: true });
      continue;
    }
    const isMark = cell.role === 'folded' || cell.role === 'turn';
    line[x] = createStyledCell(p.glyphs.role[cell.role], { fg: lane, bg, bold: isMark });
  }
}

/** The fill and ┃ of the focused row (and of every row of its opened body's frame). */
export function applyFocus(line: Line, width: number, glyphs: LaneGlyphs): void {
  const t = activeTokens();
  for (let x = 1; x <= width - 2 && x < line.length; x++) {
    const cell = line[x]!;
    if (cell.bg === '') line[x] = { ...cell, bg: t.backgroundPanel };
  }
  if (line.length > 0) line[0] = createStyledCell(glyphs.focus, { fg: t.brand, bold: true });
}

/** Right side of a row: the summary ending SUMMARY_GAP columns left of the time, and the time. Returns the column the left text must stop before. */
function paintRight(line: Line, p: GraphPaint, summary: BeadSummary | null, summaryMark: string | undefined, time: string | undefined, timeFg: string): number {
  const end = timeEnd(p.width);
  let limit = end + 1;
  if (time) limit = putRight(line, end, tx(p, time), { fg: timeFg }) - 2;
  if (summary) {
    const sumEnd = end - SUMMARY_GAP;
    const room = Math.max(0, sumEnd - textColumn(p) - 12);
    const text = tx(p, truncateDisplay(summaryMark ? `${summaryMark} ${summary.text}` : summary.text, Math.max(8, room), p.glyphs.ellipsis));
    limit = Math.min(limit, putRight(line, sumEnd, text, { fg: summaryColor(summary.tone) }) - 2);
  }
  return limit;
}

export interface BeadRowSpec {
  readonly status: BeadStatus;
  readonly name: string;
  readonly arg: string;
  readonly summary: BeadSummary | null;
  readonly time: string | undefined;
  /** The lane's color (running beads spin and count up in it). */
  readonly laneColor: string;
  readonly hasBody: boolean;
  readonly open: boolean;
  /** WRFC: the finding this row answers ("↳ jitter can overshoot"). */
  readonly answers?: string | undefined;
}

export function paintBeadRow(gutter: GutterRow, spec: BeadRowSpec, p: GraphPaint): Line {
  const t = activeTokens();
  const line = createEmptyLine(p.width);
  paintGutter(line, gutter, p, spec.status);
  const x = textColumn(p);
  if (spec.hasBody) putText(line, x - 2, x - 1, spec.open ? p.glyphs.opened : p.glyphs.closed, { fg: spec.open ? t.textMuted : t.textFaint });
  const limit = paintRight(line, p, spec.summary, undefined, spec.time, spec.status === 'run' ? spec.laneColor : t.textFaint);
  const cancelled = spec.status === 'cancel';
  const nameFg = spec.status === 'run' || spec.status === 'wait' ? t.text : spec.status === 'err' ? t.error : t.textMuted;
  let cx = putText(line, x, limit, tx(p, spec.name), { fg: nameFg, bold: spec.status === 'run', strikethrough: cancelled });
  if (spec.arg) {
    const room = limit - (cx + 1);
    const answers = spec.answers ? `   ${p.glyphs.answers} ${spec.answers}` : '';
    const argRoom = Math.max(0, room - Math.min(getDisplayWidth(answers), Math.floor(room / 2)));
    cx = putText(line, cx + 1, limit, tx(p, truncateDisplay(spec.arg, argRoom, p.glyphs.ellipsis)), { fg: cancelled ? t.textFaint : t.text, strikethrough: cancelled });
    if (answers) putText(line, cx, limit, tx(p, truncateDisplay(answers, Math.max(0, limit - cx), p.glyphs.ellipsis)), { fg: t.warning });
  }
  return line;
}

export interface LaneRowSpec {
  readonly name: string;
  readonly arg: string;
  readonly laneColor: string;
}

/** A lane opening (├─╮): the agent's name in its lane color, its task muted. */
export function paintSpawnRow(gutter: GutterRow, spec: LaneRowSpec, p: GraphPaint): Line {
  const line = createEmptyLine(p.width);
  paintGutter(line, gutter, p);
  const x = textColumn(p);
  const limit = timeEnd(p.width) + 1;
  const cx = putText(line, x, limit, tx(p, spec.name), { fg: spec.laneColor, bold: true });
  putText(line, cx + 1, limit, tx(p, truncateDisplay(spec.arg, Math.max(0, limit - cx - 1), p.glyphs.ellipsis)), { fg: activeTokens().textMuted });
  return line;
}

/** A lane merging back (├─╯) with its result line; amber with ! when it carries a failure. */
export function paintMergeRow(gutter: GutterRow, text: string, warn: boolean, p: GraphPaint): Line {
  const t = activeTokens();
  const line = createEmptyLine(p.width);
  paintGutter(line, gutter, p);
  const x = textColumn(p);
  const limit = timeEnd(p.width) + 1;
  if (warn) {
    putText(line, x, limit, p.glyphs.warn, { fg: t.warning, bold: true });
    putText(line, x + 2, limit, tx(p, truncateDisplay(text, Math.max(0, limit - x - 2), p.glyphs.ellipsis)), { fg: t.warning });
  } else {
    putText(line, x, limit, tx(p, truncateDisplay(text, Math.max(0, limit - x), p.glyphs.ellipsis)), { fg: t.textFaint });
  }
  return line;
}

export interface FoldedRowSpec extends LaneRowSpec {
  /** ✓ ! ✕ before the summary. */
  readonly outcome: 'ok' | 'warn' | 'err' | 'run';
  readonly summary: string;
  readonly time: string | undefined;
}

/** A finished lane folded to one ◉ bead on its parent's lane. */
export function paintFoldedRow(gutter: GutterRow, spec: FoldedRowSpec, p: GraphPaint): Line {
  const t = activeTokens();
  const line = createEmptyLine(p.width);
  paintGutter(line, gutter, p);
  const x = textColumn(p);
  const tone: SummaryTone = spec.outcome === 'ok' ? 'good' : spec.outcome === 'warn' ? 'warn' : spec.outcome === 'err' ? 'bad' : 'faint';
  const mark = spec.outcome === 'ok' ? p.glyphs.ok : spec.outcome === 'warn' ? p.glyphs.warn : spec.outcome === 'err' ? p.glyphs.err : p.glyphs.run[p.frame % p.glyphs.run.length]!;
  const limit = paintRight(line, p, { text: spec.summary, tone }, mark, spec.time, spec.outcome === 'run' ? spec.laneColor : t.textFaint);
  let cx = putText(line, x, limit, tx(p, spec.name), { fg: spec.laneColor, bold: true });
  cx = putText(line, cx + 1, Math.max(cx + 1, limit - 2), tx(p, truncateDisplay(spec.arg, Math.max(0, limit - cx - 3), p.glyphs.ellipsis)), { fg: t.textMuted });
  putText(line, cx + 1, limit, p.glyphs.closed, { fg: t.textMuted });
  return line;
}

/**
 * The turn header: "◆ model · 4 tools · 1 agent · 1.9s". Folded, the ◆ sits in
 * the gutter and a ▸ closes the row.
 */
export function paintHeadRow(gutter: GutterRow, text: string, folded: boolean, p: GraphPaint): Line {
  const t = activeTokens();
  const line = createEmptyLine(p.width);
  paintGutter(line, gutter, p);
  const x = textColumn(p);
  const limit = timeEnd(p.width) + 1;
  let cx = x;
  if (!folded) cx = putText(line, cx, limit, `${p.glyphs.role.turn} `, { fg: t.brand, bold: true });
  cx = putText(line, cx, limit - (folded ? 2 : 0), tx(p, truncateDisplay(text, Math.max(0, limit - cx - (folded ? 2 : 0)), p.glyphs.ellipsis)), { fg: t.textFaint });
  if (folded) putText(line, cx + 1, limit, p.glyphs.closed, { fg: t.textMuted });
  return line;
}

/**
 * Move an already-rendered transcript line `shift` columns right (prose rendered
 * at a narrower width so it starts at the text column) and draw `gutter` over
 * its left edge.
 */
export function shiftUnderGutter(source: Line, shift: number, gutter: GutterRow | null, p: GraphPaint): Line {
  const line = createEmptyLine(p.width);
  for (let i = 0; i < source.length; i++) {
    const target = i + shift;
    if (target >= p.width) break;
    line[target] = source[i]!;
  }
  if (gutter) paintGutter(line, gutter, p);
  return line;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export interface BodyPaintOptions {
  /** Show every row instead of the first BODY_CAP / DIFF_CAP. */
  readonly expanded: boolean;
  /** The semantic summary for a diff body: undefined while it is being read, null when there is none. */
  readonly semantic?: SemanticDiff | null | undefined;
}

/** The body fill's panel: from the text column to W-4, `h` rows. */
function bodyPanel(canvas: SurfaceCanvas, p: GraphPaint, h: number, bg: string): KitPanel {
  const x = textColumn(p);
  return panel(canvas, x, 0, timeEnd(p.width) - x + 1, h, bg);
}

function moreText(n: number, what: string, p: GraphPaint): string {
  return `${p.glyphs.ellipsis} ${n} more${what ? ` ${what}` : ''}`;
}

/**
 * Text lines wrapped in full to the panel's text width. A body is file text or
 * command output, so its layout is kept: indentation and inner spacing stay,
 * tabs become spaces, and wrapped rows keep the line's indent.
 */
function wrapAll(lines: ReadonlyArray<{ text: string; fg: string }>, width: number): Array<{ text: string; fg: string }> {
  const out: Array<{ text: string; fg: string }> = [];
  for (const line of lines) {
    const parts = wrapPreservingIndent(line.text, Math.max(8, width));
    for (const part of parts.length > 0 ? parts : ['']) out.push({ text: part, fg: line.fg });
  }
  return out;
}

/** One drawn row of a read body: colored runs from the panel's left edge. */
type ReadRow = ReadonlyArray<{ readonly text: string; readonly fg: string; readonly bold?: boolean; readonly italic?: boolean }>;

/**
 * A file's lines as drawn rows: syntax colored for the file's language, tabs
 * as two spaces, and each line wrapped the way a command's output wraps
 * (indentation kept, continuation rows indented like the first).
 */
function readRows(file: ReadBodyFile, width: number): ReadRow[] {
  const t = activeTokens();
  const lines = file.lines.map(expandTabs);
  const tokens = highlightCodeLines(lines, file.path ? languageForPath(file.path) : '');
  const rows: ReadRow[] = [];
  lines.forEach((line, i) => {
    const chars = Array.from(line);
    // Each character's style, from the line's tokens (plain when they do not spell the line).
    const lineTokens = tokens[i] ?? [];
    const styles: Array<{ fg: string; bold?: boolean; italic?: boolean }> = [];
    if (lineTokens.map((tk) => tk.text).join('') === line) {
      for (const tk of lineTokens) for (const _ of Array.from(tk.text)) styles.push({ fg: tk.fg, bold: tk.bold, italic: tk.italic });
    } else {
      for (let k = 0; k < chars.length; k++) styles.push({ fg: t.text });
    }
    let cursor = 0;
    for (const part of wrapPreservingIndent(line, Math.max(8, width))) {
      const pc = Array.from(part);
      let lead = 0;
      while (pc[lead] === ' ') lead++;
      while (chars[cursor] === ' ') cursor++;
      const runs: Array<{ text: string; fg: string; bold?: boolean; italic?: boolean }> = [];
      if (lead > 0) runs.push({ text: ' '.repeat(lead), fg: t.text });
      for (let k = lead; k < pc.length; k++) {
        const style = styles[cursor] ?? { fg: t.text };
        cursor++;
        const last = runs[runs.length - 1];
        if (last && last.fg === style.fg && last.bold === style.bold && last.italic === style.italic) last.text += pc[k];
        else runs.push({ text: pc[k]!, ...style });
      }
      rows.push(runs);
    }
  });
  return rows;
}

/**
 * An opened read: the text the model read, drawn like a command's output
 * (indented exactly, syntax colored, "… N more lines" past the same BODY_CAP).
 * One file shows its text alone, since the row already names it; several
 * files show one short section each, headed by the path and line count, and
 * share BODY_CAP between them (at least 3 rows each).
 */
function paintReadBody(files: readonly ReadBodyFile[], p: GraphPaint, options: BodyPaintOptions, innerWidth: number): { lines: Line[]; capped: boolean } {
  const t = activeTokens();
  const headed = files.length > 1;
  const perFile = headed ? Math.max(3, Math.floor(BODY_CAP / files.length)) : BODY_CAP;
  type Drawn = { kind: 'row'; row: ReadRow } | { kind: 'header'; file: ReadBodyFile } | { kind: 'more'; hidden: number } | { kind: 'error'; text: string } | { kind: 'gap' };
  const drawn: Drawn[] = [];
  let capped = false;
  files.forEach((file, index) => {
    if (headed) {
      if (index > 0) drawn.push({ kind: 'gap' });
      drawn.push({ kind: 'header', file });
    }
    if (file.error !== undefined) {
      for (const part of wrapPreservingIndent(file.error, Math.max(8, innerWidth))) drawn.push({ kind: 'error', text: part });
      return;
    }
    const rows = readRows(file, innerWidth);
    // Trailing blank rows say nothing.
    while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
    const cap = options.expanded ? rows.length : Math.min(rows.length, perFile);
    for (let k = 0; k < cap; k++) drawn.push({ kind: 'row', row: rows[k]! });
    if (rows.length > cap) {
      capped = true;
      drawn.push({ kind: 'more', hidden: rows.length - cap });
    }
  });
  const height = drawn.length + 2;
  const canvas = new SurfaceCanvas(p.width, height);
  const pn = bodyPanel(canvas, p, height, t.backgroundPanel);
  const right = pn.l + innerWidth;
  drawn.forEach((item, k) => {
    const y = 1 + k;
    if (item.kind === 'header') {
      // A file that could not be read has no line count to state; its error follows.
      const count = item.file.error !== undefined ? '' : `${item.file.lineCount} line${item.file.lineCount === 1 ? '' : 's'}`;
      const path = truncateDisplay(item.file.path ?? 'file', Math.max(1, innerWidth - (count ? getDisplayWidth(count) + 2 : 0)), p.glyphs.ellipsis);
      const cx = canvas.put(pn.l, y, path, { fg: t.text, bold: true });
      if (count) canvas.put(cx + 2, y, count, { fg: t.textFaint });
    } else if (item.kind === 'row') {
      let cx = pn.l;
      for (const run of item.row) {
        const room = right - cx;
        if (room <= 0) break;
        cx = canvas.put(cx, y, truncateDisplay(run.text, room, p.glyphs.ellipsis), { fg: run.fg, bold: run.bold, italic: run.italic });
      }
    } else if (item.kind === 'more') {
      canvas.put(pn.l, y, moreText(item.hidden, 'lines', p), { fg: t.textFaint });
    } else if (item.kind === 'error') {
      canvas.put(pn.l, y, truncateDisplay(item.text, innerWidth, p.glyphs.ellipsis), { fg: t.error });
    }
  });
  return { lines: canvas.lines, capped };
}

/**
 * Draw an opened bead's body. Returns full-width lines (the caller draws the
 * lane gutter over their left edge) and whether rows were left out.
 */
export function paintBody(body: BeadBody, p: GraphPaint, options: BodyPaintOptions): { lines: Line[]; capped: boolean } {
  const t = activeTokens();
  const x = textColumn(p);
  const innerWidth = timeEnd(p.width) - x + 1 - 4;

  if (body.kind === 'diff') {
    const files = parseChanges(body.diff);
    const codeWidth = Math.max(8, innerWidth - 8);
    let { rows } = buildDiffRows(files, codeWidth, files.length > 1);
    if (!body.numbered) {
      // Line numbers are unknown: the "⋯ line N" separators would state one.
      rows = rows.filter((row, k) => row.kind !== 'sep' || k > 0).map((row): DiffRow => (row.kind === 'sep' ? { ...row, text: p.glyphs.ellipsis } : row));
    }
    const semanticRows = options.semantic && options.semantic.totalChanges > 0 ? 2 : 0;
    const cap = options.expanded ? rows.length : Math.min(rows.length, DIFF_CAP);
    const hidden = rows.length - cap;
    const height = 1 + semanticRows + cap + (hidden > 0 ? 1 : 0) + 1;
    const canvas = new SurfaceCanvas(p.width, height);
    const pn = bodyPanel(canvas, p, height, t.backgroundPanel);
    let y = 1;
    if (semanticRows > 0 && options.semantic) {
      canvas.put(pn.l, y, '◈', { fg: t.brandEnd });
      let cx = pn.l + 2;
      for (const chip of semanticChips(options.semantic)) {
        if (cx + getDisplayWidth(chip.text) > pn.r) break;
        cx = canvas.put(cx, y, chip.text, { fg: chip.fg }) + 2;
      }
      y += 2;
    }
    for (let k = 0; k < cap; k++) drawDiffRow(canvas, pn, y + k, rows[k]!, -1, { lineNumbers: body.numbered });
    if (hidden > 0) canvas.put(pn.l, y + cap, moreText(hidden, 'lines', p), { fg: t.textFaint });
    return { lines: canvas.lines, capped: hidden > 0 };
  }

  if (body.kind === 'error') {
    const wrapped = wrapAll([{ text: body.text, fg: t.error }], innerWidth);
    const height = wrapped.length + 2;
    const canvas = new SurfaceCanvas(p.width, height);
    const pn = bodyPanel(canvas, p, height, t.backgroundError);
    wrapped.forEach((row, k) => canvas.put(pn.l, 1 + k, row.text, { fg: row.fg }));
    return { lines: canvas.lines, capped: false };
  }

  if (body.kind === 'read') return paintReadBody(body.files, p, options, innerWidth);

  let rows: Array<{ text: string; fg: string }>;
  let footer: string | undefined;
  if (body.kind === 'output') {
    rows = wrapAll(body.lines.map((l) => ({ text: l.text, fg: bodyColor(l.tone) })), innerWidth);
    footer = body.footer;
  } else if (body.kind === 'list') {
    rows = body.items.map((item) => {
      const detail = item.detail ? `  ${item.detail}` : '';
      return { text: truncateDisplay(expandTabs(`${item.text}${detail}`), innerWidth, p.glyphs.ellipsis), fg: t.text };
    });
  } else {
    rows = wrapAll(body.lines.map((text) => ({ text, fg: t.text })), innerWidth);
  }
  const cap = options.expanded ? rows.length : Math.min(rows.length, BODY_CAP);
  const hidden = rows.length - cap;
  const tail = (hidden > 0 ? 1 : 0) + (footer ? (hidden > 0 ? 1 : 2) : 0);
  const height = cap + tail + 2;
  const canvas = new SurfaceCanvas(p.width, height);
  const pn = bodyPanel(canvas, p, height, t.backgroundPanel);
  for (let k = 0; k < cap; k++) canvas.put(pn.l, 1 + k, truncateDisplay(rows[k]!.text, innerWidth, p.glyphs.ellipsis), { fg: rows[k]!.fg });
  let y = 1 + cap;
  if (hidden > 0) canvas.put(pn.l, y++, moreText(hidden, 'lines', p), { fg: t.textFaint });
  if (footer) {
    if (hidden === 0) y++;
    canvas.put(pn.l, y, truncateDisplay(footer, innerWidth, p.glyphs.ellipsis), { fg: t.textMuted });
  }
  // A list is short by design: name the items that did not fit rather than "lines".
  if (body.kind === 'list' && hidden > 0) {
    canvas.fill(pn.l, 1 + cap, innerWidth, 1, t.backgroundPanel);
    canvas.put(pn.l, 1 + cap, moreText(hidden, '', p), { fg: t.textFaint });
  }
  return { lines: canvas.lines, capped: hidden > 0 };
}
