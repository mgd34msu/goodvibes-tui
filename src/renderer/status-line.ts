/**
 * status-line.ts, the one row directly under the composer.
 *
 * Left end: the chips that must always be visible, never dropped for lack of
 * room: the approval mode (muted, plan in the info color), or "! auto-approve"
 * in the error color while everything is auto-approved; "sleep disabled"; the
 * live microphone. Optional chips after them (attachments, orchestration) are
 * dropped first when the row is short. 2 columns between chips.
 *
 * Then, one of (first match wins):
 *   - a notice the user must see now (the "press Ctrl+C again" exit guard, a
 *     copy receipt);
 *   - a running turn: the spinner (brand gradient on the glyph only), the
 *     honest waiting phrase in muted text, the elapsed time, and an `esc`
 *     keycap with "interrupt";
 *   - at rest: the working directory and branch, plus a background-work
 *     summary while agents or processes run (highlighted with its keys while
 *     it owns keyboard focus).
 *
 * Right side, built right to left from width-4 and stopping where the left
 * side really ends (3 columns between pieces, 1 between a key and its
 * action): the `ctrl+p` keycap with "menu", the context bar, the cost.
 *
 * Narrow screens: below 100 columns the directory goes first, then the cost,
 * then the bar narrows from 16 cells toward 6, then the "used / total" label
 * goes, then the word "context"; the bar is dropped only when even the bare
 * 6 cells and percent do not fit. From the warning level up the left side
 * yields room for that bare bar, so a filling window is never hidden. The
 * kept chips at the left end are never dropped.
 */

import { type Line, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth, interpolateColor, truncateDisplay } from '../utils/terminal-width.ts';
import { abbreviateCount } from '../utils/format-number.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { activeTokens } from './theme.ts';
import { keycapHintsWidth, paintKeycapHints } from './surface-kit-parts.ts';
import type { KitHint } from './surface-kit.ts';

/** The bar's cell count when there is room, and the least it narrows to. */
const CONTEXT_BAR_CELLS = 16;
const CONTEXT_BAR_MIN_CELLS = 6;
/** From this fraction of the window the bar turns to the warning color. */
const CONTEXT_WARN_FRACTION = 0.65;
/** Directory is shown only from this width up. */
const DIRECTORY_MIN_WIDTH = 100;
/** Pieces on the status line sit this far apart. */
const GAP = 3;
/** Left edge of the status line (the fill column of the composer above). */
const LEFT_X = 3;
/** Columns between the chips at the left end. */
const CHIP_GAP = 2;

/** A chip at the left end of the status line. */
export interface StatusChip {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
  /** A filled chip (the wake indicator's banner prominence); no fill otherwise. */
  readonly bg?: string;
  /** Never dropped for lack of room (the mode, auto-approve, microphone, sleep). */
  readonly keep?: boolean;
}

export interface StatusBusyState {
  /** The spinner glyph for this frame. */
  readonly spinner: string;
  /** Animation frame, used for the spinner's gradient position. */
  readonly frame: number;
  /** The honest waiting phrase (thinking, stalled, waiting for approval...). */
  readonly phrase: string;
  readonly elapsedMs?: number;
  /** Streaming rate; omitted while waiting on the user. */
  readonly tokenSpeed?: number;
  /** Time to the first token of this turn, once known. */
  readonly ttftMs?: number;
  /** True while the turn is blocked on an approval (Esc still interrupts). */
  readonly approvalPending?: boolean;
}

export interface StatusBackgroundState {
  readonly agents: number;
  readonly processes: number;
  /** True while the background summary owns keyboard focus. */
  readonly focused: boolean;
  /** Optional one-line progress of the running agents. */
  readonly progress?: string;
}

export interface StatusContextState {
  /** Tokens in the last request (0 while unknown). */
  readonly usedTokens: number;
  readonly windowTokens: number;
  /** Compaction threshold as a fraction [0..1]. */
  readonly compactFraction: number;
}

export interface StatusLineOptions {
  readonly width: number;
  /** Chips at the left end, drawn left to right; see the file header. */
  readonly chips?: readonly StatusChip[];
  readonly notice?: { readonly text: string; readonly tone: 'error' | 'info' } | null;
  readonly busy?: StatusBusyState | null;
  readonly directory?: string;
  readonly branch?: string;
  readonly background?: StatusBackgroundState | null;
  /** Formatted cost text ("$0.246", "you $0.25 · fleet $0.47"); omitted when unknown. */
  readonly cost?: string | null;
  readonly context?: StatusContextState | null;
  /**
   * Keys of the view the keyboard is in, shown in place of the busy phrase
   * or directory (the conversation work tree: move, fold, open, copy, back).
   */
  readonly keys?: readonly KitHint[] | null;
}

interface Piece {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
  readonly bg?: string;
}

function putText(line: Line, x: number, endX: number, piece: Piece): number {
  let cx = x;
  for (const ch of piece.text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (cx + w > endX || cx >= line.length) break;
    line[cx] = { char: ch, fg: piece.fg, bg: piece.bg ?? '', bold: piece.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
    if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
    cx += w;
  }
  return cx;
}

function piecesWidth(pieces: readonly Piece[]): number {
  return pieces.reduce((sum, p) => sum + getDisplayWidth(p.text), 0);
}

/** "13.2k / 1.0M", or "— / 1.0M" before the first count arrives. */
function contextUsageLabel(usedTokens: number, windowTokens: number): string {
  const used = usedTokens > 0 ? abbreviateCount(usedTokens, { bSuffix: true }) : '—';
  return `${used} / ${abbreviateCount(windowTokens, { bSuffix: true })}`;
}

function contextFraction(state: StatusContextState): number {
  if (!(state.windowTokens > 0)) return 0;
  return Math.max(0, Math.min(1, state.usedTokens / state.windowTokens));
}

/** Which optional parts of the context piece are drawn. */
interface ContextBarForm {
  readonly cells: number;
  readonly word: boolean;
  readonly label: boolean;
}

/** Width of the context bar piece in a given form. */
function contextBarWidth(state: StatusContextState, form: ContextBarForm): number {
  const pct = `${Math.round(contextFraction(state) * 100)}%`;
  return (form.word ? getDisplayWidth('context') + 1 : 0) + form.cells + 1 + getDisplayWidth(pct)
    + (form.label ? 1 + getDisplayWidth(contextUsageLabel(state.usedTokens, state.windowTokens)) : 0);
}

/** The bare form: minimum cells and the percent, nothing else. */
const BARE_CONTEXT_FORM: ContextBarForm = { cells: CONTEXT_BAR_MIN_CELLS, word: false, label: false };

/**
 * The widest form that fits `room`: 16 cells narrowing to 6 with the word and
 * label, then without the label, then without the word. Null when even the
 * bare form does not fit.
 */
function fitContextForm(state: StatusContextState, room: number): ContextBarForm | null {
  const full: ContextBarForm = { cells: CONTEXT_BAR_CELLS, word: true, label: true };
  const fullW = contextBarWidth(state, full);
  if (fullW <= room) return full;
  const narrowed = CONTEXT_BAR_CELLS - (fullW - room);
  if (narrowed >= CONTEXT_BAR_MIN_CELLS) return { ...full, cells: narrowed };
  for (const form of [
    { cells: CONTEXT_BAR_MIN_CELLS, word: true, label: false },
    BARE_CONTEXT_FORM,
  ] satisfies ContextBarForm[]) {
    if (contextBarWidth(state, form) <= room) return form;
  }
  return null;
}

/**
 * Draw "context ███░░│░░ 34% 340K / 1.0M" at x. Filled cells carry the brand
 * gradient while healthy, the warning color from 65%, the error color at or
 * past the compaction threshold; the track is the border color and an amber
 * tick marks the threshold. Returns the column after the label.
 */
function drawContextBar(line: Line, x: number, state: StatusContextState, form: ContextBarForm): number {
  const cells = form.cells;
  const t = activeTokens();
  const used = contextFraction(state);
  const threshold = Math.max(0, Math.min(1, state.compactFraction > 0 ? state.compactFraction : 1));
  const hot = used >= threshold ? t.error : used >= CONTEXT_WARN_FRACTION ? t.warning : null;
  const filled = used > 0 ? Math.max(1, Math.round(cells * used)) : 0;
  const tick = threshold < 1 ? Math.min(cells - 1, Math.round(cells * threshold)) : -1;
  let cx = form.word ? putText(line, x, line.length, { text: 'context', fg: t.textMuted }) + 1 : x;
  for (let q = 0; q < cells; q++) {
    if (q === tick) {
      putText(line, cx + q, line.length, { text: '│', fg: t.warning, bold: true });
      continue;
    }
    const isFilled = q < filled;
    const fg = isFilled ? (hot ?? interpolateColor(t.brand, t.brandEnd, cells > 1 ? q / (cells - 1) : 0)) : t.border;
    putText(line, cx + q, line.length, { text: isFilled ? '█' : '░', fg });
  }
  cx += cells + 1;
  cx = putText(line, cx, line.length, { text: `${Math.round(used * 100)}%`, fg: hot ?? t.text, bold: true });
  if (!form.label) return cx;
  return putText(line, cx + 1, line.length, { text: contextUsageLabel(state.usedTokens, state.windowTokens), fg: t.textMuted });
}

function backgroundSummary(bg: StatusBackgroundState): string {
  const parts: string[] = [];
  if (bg.agents > 0) parts.push(`${bg.agents} agent${bg.agents === 1 ? '' : 's'} running`);
  if (bg.processes > 0) parts.push(`${bg.processes} process${bg.processes === 1 ? '' : 'es'} running`);
  if (parts.length === 0) return 'no background work';
  return parts.join(' · ');
}

/** Draw the left side from `startX`; returns the column where it really ends. */
function drawLeft(line: Line, options: StatusLineOptions, startX: number, maxX: number, withDirectory: boolean): number {
  const t = activeTokens();
  const width = options.width;
  if (options.notice) {
    return putText(line, startX, maxX, { text: options.notice.text, fg: options.notice.tone === 'error' ? t.error : t.info, bold: true });
  }
  if (options.keys && options.keys.length > 0) {
    // As many whole keys as fit, in order.
    const keys: KitHint[] = [];
    for (const key of options.keys) {
      if (keycapHintsWidth([...keys, key]) > maxX - startX) break;
      keys.push(key);
    }
    return keys.length > 0 ? paintKeycapHints(line, startX, maxX, keys, { fg: t.textFaint }) : startX;
  }
  if (options.busy) {
    const b = options.busy;
    const glyphFg = interpolateColor(t.brand, t.brandEnd, ((Math.sin(b.frame / 6) + 1) / 2));
    let x = putText(line, startX, maxX, { text: b.spinner, fg: glyphFg, bold: true });
    x += 1;
    const tail: string[] = [];
    if (b.elapsedMs !== undefined) tail.push(formatElapsed(b.elapsedMs));
    if (!b.approvalPending && b.ttftMs !== undefined && b.ttftMs > 0) tail.push(`first token ${formatElapsed(b.ttftMs)}`);
    if (!b.approvalPending && b.tokenSpeed !== undefined && b.tokenSpeed > 0) tail.push(`${Math.round(b.tokenSpeed)} tok/s`);
    const hints: KitHint[] = [['esc', 'interrupt']];
    const hintsW = keycapHintsWidth(hints) + GAP;
    const tailText = tail.length > 0 ? ` · ${tail.join(' · ')}` : '';
    const room = Math.max(0, maxX - x - hintsW);
    // The phrase stays whole as long as it can: the timers go before it is
    // cut, and its trailing dots go before a letter does.
    const bare = b.phrase.replace(/(\.\.\.|…)$/, '');
    const phrase = getDisplayWidth(b.phrase) > room && getDisplayWidth(bare) <= room ? bare : truncateDisplay(b.phrase, room);
    x = putText(line, x, maxX, { text: phrase, fg: t.textMuted });
    if (getDisplayWidth(tailText) <= maxX - x - hintsW) x = putText(line, x, maxX, { text: tailText, fg: t.textFaint });
    if (x + hintsW <= maxX) x = paintKeycapHints(line, x + GAP, maxX, hints, { fg: t.textFaint });
    return x;
  }
  let x = startX;
  const place: Piece[] = [];
  if (withDirectory && options.directory && width >= DIRECTORY_MIN_WIDTH) place.push({ text: options.directory, fg: t.textFaint });
  if (options.branch) place.push({ text: options.branch, fg: t.textFaint });
  if (place.length > 0) {
    const joined = place.map((p) => p.text).join(' · ');
    x = putText(line, x, maxX, { text: truncateDisplay(joined, Math.max(0, maxX - x)), fg: t.textFaint });
  }
  const bg = options.background;
  if (bg && (bg.focused || bg.agents + bg.processes > 0)) {
    const start = place.length > 0 ? x + GAP : x;
    const summary = backgroundSummary(bg) + (bg.progress ? ` · ${bg.progress}` : '');
    const hints: KitHint[] = bg.focused
      ? (bg.agents + bg.processes > 0 ? [['⏎', 'open'], ['esc', 'back']] : [['esc', 'back']])
      : [['⏎', 'view']];
    if (bg.focused) {
      const text = truncateDisplay(`▸ ${summary}`, Math.max(0, maxX - start - keycapHintsWidth(hints) - GAP));
      x = putText(line, start, maxX, { text, fg: t.text, bold: true, bg: t.backgroundSelected });
      x = paintKeycapHints(line, x + GAP, maxX, hints, { fg: t.textFaint });
    } else {
      const text = truncateDisplay(`◐ ${summary}`, Math.max(0, maxX - start));
      x = putText(line, start, maxX, { text, fg: t.brand, bold: true });
    }
  }
  return x;
}

/**
 * Draw the left-end chips; returns the column after the last one (LEFT_X when
 * none). Optional chips that would run past `maxX` are dropped, last first; a
 * kept chip is always drawn, up to the row's right edge.
 */
function drawChips(line: Line, chips: readonly StatusChip[], maxX: number, rightEdge: number): number {
  const shown = [...chips];
  const width = (list: readonly StatusChip[]): number => list.reduce((s, c, i) => s + (i > 0 ? CHIP_GAP : 0) + getDisplayWidth(c.text), 0);
  while (shown.length > 0 && LEFT_X + width(shown) > maxX) {
    const idx = shown.map((c) => c.keep === true).lastIndexOf(false);
    if (idx < 0) break;
    shown.splice(idx, 1);
  }
  let x = LEFT_X;
  shown.forEach((chip, i) => {
    if (i > 0) x += CHIP_GAP;
    x = putText(line, x, rightEdge, { text: chip.text, fg: chip.fg, bold: chip.bold, bg: chip.bg });
  });
  return x;
}

/** Render the status line. */
export function renderStatusLine(options: StatusLineOptions): Line {
  // The directory is the first thing to go: when it would cost the cost or the
  // full context bar their room, the row is laid out again without it.
  const withDirectory = layoutStatusLine(options, true);
  if (withDirectory.fullFit || !options.directory) return withDirectory.line;
  return layoutStatusLine(options, false).line;
}

function layoutStatusLine(options: StatusLineOptions, withDirectory: boolean): { line: Line; fullFit: boolean } {
  const t = activeTokens();
  const width = options.width;
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  const rightEdge = width - 3; // exclusive: right-aligned text ends at width-4
  const menu: KitHint[] = [['ctrl+p', 'menu']];
  const menuW = keycapHintsWidth(menu);

  const ctx = options.context && options.context.windowTokens > 0 ? options.context : null;
  // From the warning level up the bare bar is reserved before the left side
  // is laid out, so a busy phrase truncates instead of hiding a filling window.
  const reserve = ctx && contextFraction(ctx) >= CONTEXT_WARN_FRACTION
    ? contextBarWidth(ctx, BARE_CONTEXT_FORM) + GAP
    : 0;

  // The left side is drawn first so the right side knows where it really ends.
  // It may use everything left of the menu keycap (and the reserve).
  const leftMax = Math.max(LEFT_X, rightEdge - menuW - GAP - reserve);
  const chipsEnd = drawChips(line, options.chips ?? [], leftMax, rightEdge);
  const leftStart = chipsEnd > LEFT_X ? chipsEnd + GAP : LEFT_X;
  const drawn = drawLeft(line, options, leftStart, Math.max(leftStart, leftMax), withDirectory);
  const leftEnd = drawn > leftStart ? drawn : chipsEnd;

  const cost = options.cost ?? null;
  const costW = cost ? getDisplayWidth(cost) : 0;
  const full: ContextBarForm = { cells: CONTEXT_BAR_CELLS, word: true, label: true };
  const fullRightW = menuW
    + (ctx ? GAP + contextBarWidth(ctx, full) : 0)
    + (cost ? GAP + costW : 0);
  const fullFit = leftEnd + GAP + fullRightW <= rightEdge;

  let rx = rightEdge;
  if (rx - menuW >= leftEnd + GAP) {
    paintKeycapHints(line, rx - menuW, rx, menu, { fg: t.textFaint });
    rx -= menuW + GAP;
  } else {
    return { line, fullFit };
  }

  const room = rx - leftEnd - GAP;
  let form: ContextBarForm | null = null;
  let showCost = false;
  if (ctx) {
    if (cost && contextBarWidth(ctx, full) + GAP + costW <= room) { form = full; showCost = true; }
    else form = fitContextForm(ctx, room);
  } else if (cost && costW <= room) {
    showCost = true;
  }
  if (ctx && form) {
    const w = contextBarWidth(ctx, form);
    drawContextBar(line, rx - w, ctx, form);
    rx -= w + GAP;
  }
  if (showCost && cost) putText(line, rx - costW, rx, { text: cost, fg: t.textMuted });
  return { line, fullFit };
}
