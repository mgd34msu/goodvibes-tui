/**
 * markdown-table.ts — box-drawn markdown tables whose cells WRAP.
 *
 * The previous implementation (inside markdown.ts) allocated each column a
 * proportional slice of the terminal width and then ellipsized any cell that
 * did not fit: a comparison table rendered "Files, code, and…" in its label
 * column and "citation coverage, checkpoin…" in its content columns, and the
 * cut text was unrecoverable — it was never written to the buffer at all, so
 * no scroll, copy, or expand could bring it back.
 *
 * This renderer never ellipsizes. A cell that exceeds its column width wraps
 * onto as many physical lines as it needs, the row grows to the tallest cell,
 * and shorter cells are blank-padded so the borders stay aligned. A single
 * word longer than its column is force-broken across lines rather than cut.
 *
 * Column allocation gives every column a workable minimum before any column
 * gets its full natural width, so a narrow label column is never starved down
 * to one word plus an ellipsis while a wide prose column takes the rest:
 *
 *   1. Each column asks for `desiredMin` — enough to hold its longest single
 *      word (capped at WORD_MIN_CAP so one long URL cannot starve the table),
 *      but never more than the column's natural width and never less than
 *      MIN_COL when the budget allows it.
 *   2. If those minimums fit, the leftover budget is shared out in proportion
 *      to each column's remaining demand (natural width minus its minimum),
 *      then any rounding remainder is handed round-robin to columns that are
 *      still short of natural.
 *   3. If the minimums do NOT fit (a genuinely narrow terminal), they are
 *      scaled down toward HARD_MIN_COL and the cells simply wrap harder.
 *
 * When even HARD_MIN_COL per column plus the borders exceeds the terminal
 * width, no allocation helps: the box drawing itself does not fit. That case
 * used to write the overflowing columns past the end of the line buffer, where
 * they were discarded — an eight-column table at width 40 lost its last
 * columns, headers included, with nothing on screen to say so. The renderer now
 * abandons the box at that point and stacks each row as `Header: value` records
 * wrapped to the available width, so every column header and every cell is
 * still emitted in full.
 */

import { type Line, type Cell, createStyledCell } from '../types/grid.ts';
import { UIFactory } from './ui-factory.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { activeTheme } from './theme.ts';
import { renderInlineMarkdown } from './markdown-inline.ts';

/** Width a column is given when the budget allows, even if its content is narrower. */
const MIN_COL = 6;
/** Absolute floor per column on a terminal too narrow for the real minimums. */
const HARD_MIN_COL = 3;
/** Most a single long word may claim as its column's minimum before the word
 *  is simply force-broken instead. Keeps one long URL from starving the rest. */
const WORD_MIN_CAP = 24;

function splitTableCells(row: string): string[] {
  const cells = row.trim().split('|').map((c) => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

export function isLikelyTableSeparatorRow(row: string): boolean {
  if (!row.includes('|')) return false;
  const cells = splitTableCells(row);
  if (cells.length === 0) return false;
  return cells.every((cell) => /:?-{3,}:?/.test(cell));
}

export function isLikelyTableHeaderRow(row: string): boolean {
  return splitTableCells(row).length >= 2;
}

/**
 * Strip markdown formatting from text for width measurement.
 * Removes **, *, `, ~~ markers but keeps the inner text.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
    .replace(/\*(.+?)\*/g, '$1')      // italic
    .replace(/~~(.+?)~~/g, '$1')      // strikethrough
    .replace(/`(.+?)`/g, '$1');       // inline code
}

/** One display character with the style it inherited from its inline token. */
type StyledChar = { char: string; style: Partial<Cell> };

/** Display width of a character, floored at 1 so a zero-width oddity can never
 *  make a wrap loop spin without consuming input. */
function charWidth(ch: string): number {
  return getDisplayWidth(ch) || 1;
}

/** Widest single whitespace-delimited word in a cell, after markdown stripping. */
function longestWordWidth(raw: string): number {
  let widest = 0;
  for (const word of stripMarkdown(raw).split(/\s+/)) {
    if (word.length === 0) continue;
    widest = Math.max(widest, getDisplayWidth(word));
  }
  return widest;
}

/**
 * Flatten a cell's inline-markdown tokens into per-character styles, applying
 * the same header/body styling the single-line renderer used.
 */
function flattenCellChars(raw: string, isHdr: boolean): StyledChar[] {
  const T = activeTheme();
  const out: StyledChar[] = [];
  for (const token of renderInlineMarkdown(raw)) {
    let style: Partial<Cell>;
    if (token.type === 'code') {
      style = { fg: T.inlineCodeFg, bold: true };
    } else if (token.type === 'link') {
      style = { fg: T.link, underline: true };
    } else {
      style = { ...token.style };
    }
    if (isHdr) {
      style.fg = style.fg || T.heading1;
      style.bold = true;
    } else {
      style.fg = style.fg || '252';
    }
    for (const ch of token.text) out.push({ char: ch, style });
  }
  return out;
}

/**
 * Word-aware wrap of a styled character run into lines no wider than `maxW`
 * display columns. A word wider than `maxW` is broken across lines character
 * by character — the text is always emitted in full, never cut.
 */
function wrapStyledChars(chars: readonly StyledChar[], maxW: number): StyledChar[][] {
  if (maxW <= 0) return [[]];
  const lines: StyledChar[][] = [];
  let cur: StyledChar[] = [];
  let curW = 0;
  let word: StyledChar[] = [];
  let wordW = 0;

  const pushLine = (): void => {
    lines.push(cur);
    cur = [];
    curW = 0;
  };

  const flushWord = (): void => {
    if (word.length === 0) return;
    if (wordW > maxW) {
      // Longer than the whole column: force-break it rather than lose any of it.
      for (const sc of word) {
        const cw = charWidth(sc.char);
        if (curW + cw > maxW && curW > 0) pushLine();
        cur.push(sc);
        curW += cw;
      }
    } else {
      if (curW + wordW > maxW && curW > 0) pushLine();
      cur.push(...word);
      curW += wordW;
    }
    word = [];
    wordW = 0;
  };

  for (const sc of chars) {
    if (sc.char === ' ') {
      flushWord();
      // A space never starts a line; at a line boundary it becomes the break.
      if (curW > 0 && curW + 1 <= maxW) {
        cur.push(sc);
        curW += 1;
      } else if (curW > 0) {
        pushLine();
      }
      continue;
    }
    word.push(sc);
    wordW += charWidth(sc.char);
  }
  flushWord();
  if (cur.length > 0 || lines.length === 0) lines.push(cur);
  return lines;
}

/**
 * Turn one wrapped line of styled characters into exactly `maxW` display
 * columns of Cells, inserting wide-glyph placeholders and blank-padding the
 * remainder so every column of every row is the same width.
 */
function padLineToCells(lineChars: readonly StyledChar[], maxW: number, isHdr: boolean): Cell[] {
  const T = activeTheme();
  const cells: Cell[] = [];
  let w = 0;
  for (const sc of lineChars) {
    const cw = charWidth(sc.char);
    if (w + cw > maxW) break; // wrapping already guaranteed the fit; defensive only
    cells.push(createStyledCell(sc.char, sc.style));
    if (cw === 2) cells.push(createStyledCell('', sc.style)); // wide char placeholder
    w += cw;
  }
  while (w < maxW) {
    cells.push(createStyledCell(' ', isHdr ? { fg: T.heading1 } : { fg: '252' }));
    w++;
  }
  return cells;
}

/**
 * Allocate a display width to each column. See the module header for the
 * three-stage policy; the contract callers rely on is only that every returned
 * width is >= 1 and that no cell is ever asked to truncate.
 */
function allocateColumnWidths(
  naturalWidths: readonly number[],
  minWordWidths: readonly number[],
  contentBudget: number,
): number[] {
  const colCount = naturalWidths.length;
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);
  if (totalNatural <= contentBudget) return [...naturalWidths];

  const widths = naturalWidths.map((natural, c) =>
    Math.min(natural, Math.max(MIN_COL, Math.min(minWordWidths[c], WORD_MIN_CAP))),
  );
  let used = widths.reduce((a, b) => a + b, 0);

  if (used > contentBudget) {
    // Narrow terminal: scale the minimums down, then shave the widest column
    // repeatedly until the row fits or every column is at the hard floor.
    const scale = contentBudget / used;
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(HARD_MIN_COL, Math.floor(widths[c] * scale));
    }
    used = widths.reduce((a, b) => a + b, 0);
    while (used > contentBudget) {
      let widest = -1;
      let widestW = HARD_MIN_COL;
      for (let c = 0; c < colCount; c++) {
        if (widths[c] > widestW) {
          widestW = widths[c];
          widest = c;
        }
      }
      if (widest === -1) break; // everything is at the floor; cannot shrink further
      widths[widest]--;
      used--;
    }
    return widths;
  }

  // Share the leftover budget in proportion to each column's unmet demand.
  const demand = naturalWidths.map((natural, c) => Math.max(0, natural - widths[c]));
  const totalDemand = demand.reduce((a, b) => a + b, 0);
  if (totalDemand === 0) return widths;

  const leftover = contentBudget - used;
  for (let c = 0; c < colCount; c++) {
    const share = Math.min(demand[c], Math.floor((leftover * demand[c]) / totalDemand));
    widths[c] += share;
    used += share;
  }
  // Rounding remainder: round-robin to whoever is still short of natural.
  let cursor = 0;
  let guard = contentBudget * 2 + colCount;
  while (used < contentBudget && guard-- > 0) {
    if (widths[cursor] < naturalWidths[cursor]) {
      widths[cursor]++;
      used++;
    }
    cursor = (cursor + 1) % colCount;
  }
  return widths;
}

/** Lay one wrapped run of styled characters into a full-width Line at `indent`. */
function emitStyledLines(
  chars: readonly StyledChar[],
  width: number,
  indent: number,
  maxW: number,
): Line[] {
  const out: Line[] = [];
  for (const lineChars of wrapStyledChars(chars, maxW)) {
    const line = new Array(width).fill(null).map(() => createStyledCell(' ')) as Cell[];
    let x = indent;
    for (const sc of lineChars) {
      if (x < width) line[x] = createStyledCell(sc.char, sc.style);
      x++;
      if (charWidth(sc.char) === 2) {
        if (x < width) line[x] = createStyledCell('', sc.style);
        x++;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * The no-box fallback for a terminal too narrow to draw the table at all.
 *
 * Each data row becomes a block of `Header: value` lines wrapped to the
 * available width, separated by a rule. Header text is styled as a header and
 * force-broken rather than cut if it is somehow wider than the terminal, so the
 * guarantee the box layout makes — every column present, nothing truncated —
 * holds at any width.
 */
function renderStackedTable(
  parsedRows: readonly string[][],
  colCount: number,
  hasSeparator: boolean,
  width: number,
  indent: number,
): Line[] {
  const lines: Line[] = [];
  const availW = Math.max(1, width - indent);
  const headerRow = hasSeparator ? parsedRows[0] : undefined;
  const bodyRows = hasSeparator ? parsedRows.slice(1) : [...parsedRows];
  // A header-only table still has to show its headers, so it renders as one
  // record with empty values rather than as nothing at all.
  const records: readonly string[][] = bodyRows.length > 0 ? bodyRows : [[]];
  const separatorStyle: Partial<Cell> = { fg: '240' };
  const rule = UIFactory.stringToLine(' '.repeat(indent) + '─'.repeat(availW), width, { fg: '240' });

  for (let r = 0; r < records.length; r++) {
    if (r > 0) lines.push(rule);
    const row = records[r];
    for (let c = 0; c < colCount; c++) {
      const label = headerRow ? (headerRow[c] ?? '') : `Column ${c + 1}`;
      const value = c < row.length ? row[c] : '';
      const chars: StyledChar[] = [
        ...flattenCellChars(label, true),
        { char: ':', style: separatorStyle },
        { char: ' ', style: separatorStyle },
        ...flattenCellChars(value, false),
      ];
      lines.push(...emitStyledLines(chars, width, indent, availW));
    }
  }
  return lines;
}

/**
 * Render a markdown table with box-drawing borders. Cells wrap to as many
 * physical lines as their content needs; nothing is ever truncated.
 */
export function renderTable(rows: string[], width: number, indent: number): Line[] {
  const lines: Line[] = [];

  // Parse rows into cells, skip separator
  const parsedRows: string[][] = [];
  let hasSeparator = false;
  for (const row of rows) {
    const trimmed = row.trim();
    if (isLikelyTableSeparatorRow(trimmed)) {
      hasSeparator = true;
      continue;
    }
    const cells = splitTableCells(trimmed);
    if (cells.length > 0) parsedRows.push(cells);
  }

  if (parsedRows.length === 0) return lines;

  const colCount = Math.max(...parsedRows.map((r) => r.length));
  const availW = width - indent;

  // Measure using stripped text (no markdown markers), both the natural width
  // and the widest single word — the latter is what a column needs before it
  // has to start breaking words apart.
  const naturalWidths: number[] = new Array(colCount).fill(0);
  const minWordWidths: number[] = new Array(colCount).fill(0);
  for (const row of parsedRows) {
    for (let c = 0; c < row.length; c++) {
      naturalWidths[c] = Math.max(naturalWidths[c], getDisplayWidth(stripMarkdown(row[c])));
      minWordWidths[c] = Math.max(minWordWidths[c], longestWordWidth(row[c]));
    }
  }

  // Budget: availW minus borders (colCount+1) minus padding (2 per col)
  const overhead = (colCount + 1) + (colCount * 2);
  const contentBudget = Math.max(colCount * HARD_MIN_COL, availW - overhead);
  const colWidths = allocateColumnWidths(naturalWidths, minWordWidths, contentBudget);

  // Left border + per column (leading pad, content, trailing pad, border).
  // When that does not fit, the columns past the edge would be written beyond
  // the end of the line buffer and silently dropped, so the box is abandoned
  // for the stacked layout instead.
  const boxWidth = indent + 1 + colWidths.reduce((sum, w) => sum + w + 3, 0);
  if (boxWidth > width) {
    return renderStackedTable(parsedRows, colCount, hasSeparator, width, indent);
  }

  const bc = '240'; // border color

  const makeBorder = (left: string, mid: string, right: string, horiz: string): Line => {
    let s = ' '.repeat(indent) + left;
    for (let c = 0; c < colCount; c++) {
      s += horiz.repeat(colWidths[c] + 2) + (c < colCount - 1 ? mid : right);
    }
    return UIFactory.stringToLine(s, width, { fg: bc });
  };

  lines.push(makeBorder('┌', '┬', '┐', '─'));

  for (let r = 0; r < parsedRows.length; r++) {
    const row = parsedRows[r];
    const isHeader = hasSeparator && r === 0;

    // Wrap every cell first; the row is as tall as its tallest cell.
    const wrappedCells: StyledChar[][][] = [];
    for (let c = 0; c < colCount; c++) {
      const raw = c < row.length ? row[c] : '';
      wrappedCells.push(wrapStyledChars(flattenCellChars(raw, isHeader), colWidths[c]));
    }
    const rowHeight = Math.max(1, ...wrappedCells.map((cell) => cell.length));

    for (let physical = 0; physical < rowHeight; physical++) {
      const line = new Array(width).fill(null).map(() => createStyledCell(' ')) as Cell[];
      let x = indent;

      if (x < width) line[x] = createStyledCell('│', { fg: bc });
      x++;

      for (let c = 0; c < colCount; c++) {
        if (x < width) line[x] = createStyledCell(' ');
        x++;

        // Past the end of this cell's wrapped lines => blank padding, so the
        // borders of a tall row stay aligned.
        const cellLine = wrappedCells[c][physical] ?? [];
        for (const cell of padLineToCells(cellLine, colWidths[c], isHeader)) {
          if (x < width) line[x] = cell;
          x++;
        }

        if (x < width) line[x] = createStyledCell(' ');
        x++;

        if (x < width) line[x] = createStyledCell('│', { fg: bc });
        x++;
      }

      lines.push(line);
    }

    if (isHeader) {
      lines.push(makeBorder('├', '┼', '┤', '─'));
    }
  }

  lines.push(makeBorder('└', '┴', '┘', '─'));

  return lines;
}
