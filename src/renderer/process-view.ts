/**
 * process-view.ts, a background process opened full screen: its live output.
 *
 *   row 0          blank
 *   rows           HH:MM:SS at column 3 (faint), the line from column 13,
 *                  wrapped to width-4 with continuations at column 13; a
 *                  line that reads as an error in the error color
 *   second-last    blank
 *   last           the follow state: "▾ following · new output scrolls in",
 *                  or how far up you are, or how the process ended; while
 *                  searching, the search line in its place
 *
 * Follow mode is on by default: the newest output stays in view. Scrolling
 * up leaves it; End (or scrolling back to the bottom) returns to it. A search
 * leaves follow mode and jumps between matching lines.
 */

import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth, truncateDisplay, wrapText } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';
import { keycapHintsWidth, paintKeycapHints } from './surface-kit-parts.ts';
import type { ProcessLine } from '../core/process-output-log.ts';

const TIME_X = 3;
const TEXT_X = 13;

/** One screen row of output. */
export interface ProcessRow {
  /** The source line's index in the log. */
  readonly source: number;
  /** Set on the first row of a line. */
  readonly time?: string;
  readonly text: string;
  readonly error: boolean;
}

export interface ProcessSearchState {
  readonly query: string;
  /** Typing the query (the search line takes the keys). */
  readonly editing: boolean;
  /** The log line of the current match (-1 when nothing matches). */
  readonly current: number;
}

export interface ProcessViewInput {
  readonly width: number;
  /** Rows the view may use. */
  readonly height: number;
  readonly rows: readonly ProcessRow[];
  /** Rows scrolled up from the newest; 0 follows the output. */
  readonly scrollFromBottom: number;
  readonly color: string;
  /** How the process ended, once it has ("exited with code 0 · 12m 04s"). */
  readonly ended?: { readonly text: string; readonly ok: boolean } | null;
  readonly search?: ProcessSearchState | null;
  /** Lines the log dropped off the front (its bound). */
  readonly dropped?: number;
}

function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** HH:MM:SS in local time. */
function clockTime(at: number): string {
  const d = new Date(at);
  return `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}:${twoDigits(d.getSeconds())}`;
}

/** Wrap log lines into screen rows (the caller caches this per width and line count). */
export function processRows(lines: readonly ProcessLine[], width: number, formatTime: (at: number) => string = clockTime): ProcessRow[] {
  const room = Math.max(10, width - 4 - TEXT_X);
  const rows: ProcessRow[] = [];
  lines.forEach((line, source) => {
    const parts = line.text.length === 0 ? [''] : wrapText(line.text, room);
    parts.forEach((text, k) => rows.push({ source, time: k === 0 ? formatTime(line.at) : undefined, text, error: line.error }));
  });
  return rows;
}

/** Source indexes of lines containing the query (case-insensitive). */
export function processMatches(lines: readonly ProcessLine[], query: string): number[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  lines.forEach((line, i) => { if (line.text.toLowerCase().includes(q)) out.push(i); });
  return out;
}

function put(line: Line, x: number, endX: number, text: string, style: { fg: string; bg?: string; bold?: boolean }): number {
  let cx = x;
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (cx + w > endX || cx >= line.length) break;
    line[cx] = { char: ch, fg: style.fg, bg: style.bg ?? '', bold: style.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
    if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
    cx += w;
  }
  return cx;
}

function blank(width: number): Line {
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  return line;
}

/** Tint every occurrence of the query on a drawn row. */
function markMatches(line: Line, text: string, query: string, bg: string): void {
  if (!query) return;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(q, from);
    if (at < 0) return;
    const x0 = TEXT_X + getDisplayWidth(text.slice(0, at));
    const w = getDisplayWidth(text.slice(at, at + q.length));
    for (let x = x0; x < x0 + w && x < line.length; x++) line[x] = { ...line[x]!, bg };
    from = at + q.length;
  }
}

/** The largest scrollFromBottom that still shows rows. */
export function processMaxScroll(rowCount: number, height: number): number {
  return Math.max(0, rowCount - Math.max(1, height - 3));
}

export function renderProcessView(input: ProcessViewInput): Line[] {
  const t = activeTokens();
  const { width } = input;
  const logRows = Math.max(1, input.height - 3);
  const end = width - 3;
  const scroll = Math.max(0, Math.min(input.scrollFromBottom, processMaxScroll(input.rows.length, input.height)));
  const last = input.rows.length - scroll;
  const first = Math.max(0, last - logRows);
  const search = input.search ?? null;

  const out: Line[] = [blank(width)];
  if (input.rows.length === 0) {
    const line = blank(width);
    put(line, TIME_X, end, input.ended ? 'The process printed nothing.' : 'No output yet.', { fg: t.textFaint });
    out.push(line);
  }
  if (first === 0 && (input.dropped ?? 0) > 0 && input.rows.length > 0) {
    const line = blank(width);
    put(line, TIME_X, end, `… ${input.dropped} earlier lines are no longer kept`, { fg: t.textFaint });
    out.push(line);
  }
  for (let r = first; r < last; r++) {
    const row = input.rows[r]!;
    const line = blank(width);
    if (row.time) put(line, TIME_X, TEXT_X - 1, row.time, { fg: t.textFaint });
    put(line, TEXT_X, end, row.text, { fg: row.error ? t.error : t.text });
    if (search && search.query) markMatches(line, row.text, search.query, row.source === search.current ? t.searchCurrentBg : t.searchMatchBg);
    out.push(line);
  }
  while (out.length < input.height - 2) out.push(blank(width));
  out.length = Math.min(out.length, Math.max(0, input.height - 2));
  out.push(blank(width));
  out.push(statusRow(input, scroll, end));
  return out;
}

function statusRow(input: ProcessViewInput, scroll: number, end: number): Line {
  const t = activeTokens();
  const line = blank(input.width);
  const search = input.search ?? null;
  if (search && (search.editing || search.query)) {
    let x = put(line, TIME_X, end, '/', { fg: input.color, bold: true });
    x = put(line, x + 1, end, search.query, { fg: t.text });
    if (search.editing) x = put(line, x, end, '▏', { fg: input.color });
    const hints: Array<[string, string]> = search.editing ? [['⏎', 'next'], ['esc', 'close']] : [['n', 'next'], ['/', 'edit'], ['esc', 'close']];
    const hintsW = keycapHintsWidth(hints);
    if (x + 3 + hintsW <= end) paintKeycapHints(line, x + 3, end, hints, { fg: t.textFaint });
    return line;
  }
  if (scroll > 0) {
    const x = put(line, TIME_X, end, '▴', { fg: input.color, bold: true });
    put(line, x + 1, end, truncateDisplay(`paused · ${scroll} newer row${scroll === 1 ? '' : 's'} below · end follows again`, Math.max(0, end - x - 1)), { fg: t.textFaint });
    return line;
  }
  if (input.ended) {
    const x = put(line, TIME_X, end, '■', { fg: input.ended.ok ? t.success : t.error, bold: true });
    put(line, x + 1, end, truncateDisplay(input.ended.text, Math.max(0, end - x - 1)), { fg: input.ended.ok ? t.textFaint : t.error });
    return line;
  }
  const x = put(line, TIME_X, end, '▾', { fg: input.color, bold: true });
  put(line, x + 1, end, 'following · new output scrolls in', { fg: t.textFaint });
  return line;
}
