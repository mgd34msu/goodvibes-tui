/**
 * session-chips.ts, the one row under the header that lists every session
 * there is to switch to: main, each running agent, each background process.
 *
 *   col 3     the first chip; chips sit 1 column apart
 *   chip      2 columns of padding, the status mark, 1 space, the name,
 *             2 columns of padding
 *   current   filled in the session's own color, dark bold text
 *   others    on the panel fill, muted name, the mark in its status color
 *   right     `tab next   shift+tab prev` keycaps ending at width-4
 *
 * Shown only when there is more than one session (the caller decides).
 * Chips that do not fit are left out whole and counted in a faint "+N".
 */

import { type Line, createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';
import { keycapHintsWidth, paintKeycapHints } from './surface-kit-parts.ts';
import type { KitHint } from './surface-kit.ts';

export interface SessionChip {
  /** The status mark: ◐ running, ● idle, ✓ finished, ✕ failed, ○ cancelled, ▶ a running process. */
  readonly mark: string;
  /** The mark's color on an unselected chip. */
  readonly markFg: string;
  readonly name: string;
  /** The session's own color (main: brand; an agent: its lane color; a process: success). */
  readonly color: string;
  readonly current: boolean;
}

const LEFT_X = 3;
const CHIP_PAD = 2;
const CHIP_GAP = 1;
/** Longest name a chip shows before it is cut with an ellipsis. */
const NAME_MAX = 24;
const HINTS: readonly KitHint[] = [['tab', 'next'], ['shift+tab', 'prev']];

function put(line: Line, x: number, endX: number, text: string, style: { fg: string; bg: string; bold?: boolean }): number {
  let cx = x;
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (cx + w > endX || cx >= line.length) break;
    line[cx] = { char: ch, fg: style.fg, bg: style.bg, bold: style.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
    if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
    cx += w;
  }
  return cx;
}

function chipWidth(chip: SessionChip): number {
  return CHIP_PAD * 2 + getDisplayWidth(chip.mark) + 1 + getDisplayWidth(truncateDisplay(chip.name, NAME_MAX));
}

export function renderSessionChips(width: number, chips: readonly SessionChip[]): Line {
  const t = activeTokens();
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  const rightEdge = width - 3; // exclusive: right-aligned text ends at width-4
  const hintsW = keycapHintsWidth(HINTS);
  const showHints = LEFT_X + hintsW + 3 + (chips[0] ? chipWidth(chips[0]) : 0) <= rightEdge;
  const chipsEnd = showHints ? rightEdge - hintsW - 3 : rightEdge;

  // The current chip is always drawn: when the row is short, the ones before it make way first.
  const order = chips.map((chip, i) => ({ chip, i }));
  const currentIdx = chips.findIndex((c) => c.current);
  const shown = new Set<number>();
  let used = 0;
  const moreW = (n: number): number => (n > 0 ? CHIP_GAP + getDisplayWidth(`+${n}`) : 0);
  const tryAdd = (i: number): boolean => {
    const w = chipWidth(chips[i]!) + (shown.size > 0 ? CHIP_GAP : 0);
    const remaining = chips.length - shown.size - 1;
    if (LEFT_X + used + w + moreW(remaining) > chipsEnd) return false;
    shown.add(i);
    used += w;
    return true;
  };
  if (currentIdx >= 0) tryAdd(currentIdx);
  for (const { i } of order) if (i !== currentIdx && !tryAdd(i)) break;

  let x = LEFT_X;
  let first = true;
  for (const { chip, i } of order) {
    if (!shown.has(i)) continue;
    if (!first) x += CHIP_GAP;
    first = false;
    const name = truncateDisplay(chip.name, NAME_MAX);
    const bg = chip.current ? chip.color : t.backgroundPanel;
    const end = x + chipWidth(chip);
    put(line, x, end, ' '.repeat(end - x), { fg: t.text, bg });
    let cx = x + CHIP_PAD;
    cx = put(line, cx, end, chip.mark, chip.current ? { fg: t.selectedListItemText, bg, bold: true } : { fg: chip.markFg, bg, bold: true });
    put(line, cx + 1, end, name, chip.current ? { fg: t.selectedListItemText, bg, bold: true } : { fg: t.textMuted, bg });
    x = end;
  }
  const hidden = chips.length - shown.size;
  if (hidden > 0) x = put(line, x + CHIP_GAP, chipsEnd, `+${hidden}`, { fg: t.textFaint, bg: '' });
  if (showHints) paintKeycapHints(line, rightEdge - hintsW, rightEdge, HINTS, { fg: t.textFaint });
  return line;
}
