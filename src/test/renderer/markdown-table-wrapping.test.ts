// ---------------------------------------------------------------------------
// markdown-table-wrapping.test.ts — markdown table cells WRAP, never truncate.
//
// The defect: renderTable allocated each column a proportional slice of the
// terminal width and ellipsized anything that did not fit, so a comparison
// table rendered "Files, code, and…" in its label column and
// "citation coverage, checkpoin…" in its content columns. The cut text was
// never written to the buffer, so no scroll, copy, or expand could recover it.
//
// These tests pin the replacement behaviour at several widths: every word of
// every cell reaches the buffer, borders stay aligned when a row grows taller
// than one physical line, and no ellipsis character is emitted at any width.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from '../../renderer/markdown.ts';

const TABLE = [
  '| Capability | GoodVibes TUI | Competitor |',
  '| --- | --- | --- |',
  '| Files, code, and repositories | Full read/write with checkpointing and rewind | Read-only browsing with citation coverage, checkpointing absent |',
  '| Learning reusable behaviour | Consolidates what it learned into durable skills | None |',
  '| Deployment portability | Runs on your own hardware or a managed host | Cloud only |',
].join('\n');

/** Every word that must survive rendering, from the widest and the narrowest
 *  columns alike — these are exactly the words the old renderer cut. */
const REQUIRED_WORDS = [
  'Capability', 'repositories', 'portability', 'reusable', 'behaviour',
  'checkpointing', 'rewind', 'citation', 'coverage', 'absent',
  'Consolidates', 'durable', 'skills', 'managed', 'host',
];

function renderAt(width: number): string[] {
  return renderMarkdown(TABLE, width).map((line) => line.map((cell) => cell.char).join(''));
}

/**
 * All text belonging to one column, read down the physical lines and
 * concatenated with whitespace removed.
 *
 * Reading whole rendered LINES would interleave the columns, and a word that
 * wrapped (or was force-broken) inside a column would never appear contiguous.
 * Column slices are taken between the row's vertical borders, so this is the
 * honest question: did every character of this cell reach the buffer, in order?
 */
function columnText(lines: readonly string[], colIndex: number): string {
  const rowLines = lines.filter((l) => l.includes('│'));
  const bounds = (line: string): number[] => {
    const cols: number[] = [];
    for (let i = 0; i < line.length; i++) if (line[i] === '│') cols.push(i);
    return cols;
  };
  const reference = bounds(rowLines[0]);
  let out = '';
  for (const line of rowLines) {
    out += line.slice(reference[colIndex] + 1, reference[colIndex + 1]);
  }
  return out.replace(/\s+/g, '');
}

describe('markdown table cells wrap instead of ellipsizing', () => {
  for (const width of [100, 72, 44]) {
    describe(`at width ${width}`, () => {
      test('emits no ellipsis anywhere', () => {
        const text = renderAt(width).join('\n');
        expect(text).not.toContain('…');
        expect(text).not.toContain('...');
      });

      test('every word of every cell reaches the buffer', () => {
        const lines = renderAt(width);
        const columns = [0, 1, 2].map((c) => columnText(lines, c));
        for (const word of REQUIRED_WORDS) {
          const found = columns.some((col) => col.includes(word));
          expect(found, `"${word}" must survive rendering at width ${width}`).toBe(true);
        }
      });

      test('all body lines are exactly the render width and borders stay aligned', () => {
        const lines = renderAt(width);
        for (const line of lines) expect(line.length).toBe(width);

        // Every box line has its vertical/horizontal separators at identical
        // columns — a multi-line row must not shift its borders.
        const borderCols = (line: string, ch: string): number[] => {
          const cols: number[] = [];
          for (let i = 0; i < line.length; i++) if (line[i] === ch) cols.push(i);
          return cols;
        };
        const rowLines = lines.filter((l) => l.includes('│'));
        expect(rowLines.length).toBeGreaterThan(3); // proves rows really did wrap
        const reference = borderCols(rowLines[0], '│');
        expect(reference.length).toBe(4); // 3 columns => 4 verticals
        for (const line of rowLines) {
          expect(borderCols(line, '│')).toEqual(reference);
        }
        // The top border's junctions sit at the same columns as the verticals.
        const top = lines.find((l) => l.includes('┬'))!;
        expect([...borderCols(top, '┌'), ...borderCols(top, '┬'), ...borderCols(top, '┐')].sort((a, b) => a - b))
          .toEqual(reference);
      });
    });
  }

  test('a row taller than one line pads its shorter cells rather than dropping the border', () => {
    const lines = renderAt(72);
    // The first body row wraps in all three columns to different heights; the
    // physical line after the tallest cell's last line still carries all four
    // verticals.
    const rowLines = lines.filter((l) => l.includes('│'));
    const blankIshRow = rowLines.find((l) => /│\s{5,}│/.test(l));
    expect(blankIshRow).toBeDefined();
    expect((blankIshRow!.match(/│/g) ?? []).length).toBe(4);
  });

  test('a word wider than its column is force-broken across lines, never cut', () => {
    const md = [
      '| Key | Value |',
      '| --- | --- |',
      '| supercalifragilisticexpialidocious | short |',
    ].join('\n');
    const lines = renderMarkdown(md, 30).map((line) => line.map((c) => c.char).join(''));
    expect(lines.join('\n')).not.toContain('…');
    // Every character of the long word is present, in order, down its column.
    expect(columnText(lines, 0)).toContain('supercalifragilisticexpialidocious');
  });

  test('a narrow table still renders full content, wrapping harder', () => {
    const lines = renderAt(36);
    expect(lines.join('\n')).not.toContain('…');
    // Even force-broken across physical lines, the label survives in order.
    expect(columnText(lines, 0)).toContain('repositories');
    expect(columnText(lines, 2)).toContain('checkpointingabsent');
  });

  test('a table that fits keeps its natural single-line rows', () => {
    const md = [
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
    ].join('\n');
    const lines = renderMarkdown(md, 60).map((line) => line.map((c) => c.char).join(''));
    // top border, header, header separator, one body row, bottom border
    expect(lines.length).toBe(5);
    expect(lines[3]).toContain('one');
    expect(lines[3]).toContain('two');
  });
});

// ---------------------------------------------------------------------------
// Widths where the box itself cannot fit
// ---------------------------------------------------------------------------

/**
 * The defect this pins: every column is laid out at HARD_MIN_COL when the
 * budget collapses, but the row is then written into a line buffer exactly
 * `width` cells wide. Once left border + per-column (pad + content + pad +
 * border) exceeded the terminal width, the trailing columns were written past
 * the end of the buffer and dropped — an eight-column table at width 40 lost
 * its last columns, HEADERS INCLUDED, with nothing on screen to say so.
 *
 * The renderer now abandons the box at that width and stacks each row as
 * `Header: value` records, so every header and every cell is still emitted.
 */
const WIDE_TABLE = [
  '| Alpha | Bravo | Charlie | Delta | Echo | Foxtrot | Golf | Hotel |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| one | two | three | four | five | six | seven | eight |',
  '| nine | ten | eleven | twelve | thirteen | fourteen | fifteen | sixteen |',
].join('\n');

const WIDE_HEADERS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
const WIDE_VALUES = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
];

function renderTextAt(markdown: string, width: number): string {
  return renderMarkdown(markdown, width)
    .map((line) => line.map((cell) => cell.char).join(''))
    .join('\n');
}

describe('an eight-column table at a width the box cannot fit', () => {
  test('every column header still reaches the buffer at width 40', () => {
    const text = renderTextAt(WIDE_TABLE, 40);
    for (const header of WIDE_HEADERS) {
      expect(text).toContain(header);
    }
  });

  test('every cell value still reaches the buffer at width 40', () => {
    const text = renderTextAt(WIDE_TABLE, 40);
    for (const value of WIDE_VALUES) {
      expect(text).toContain(value);
    }
  });

  test('nothing is ellipsized at that width either', () => {
    const text = renderTextAt(WIDE_TABLE, 40);
    expect(text).not.toContain('…');
    expect(text).not.toContain('...');
  });

  test('no rendered line runs past the terminal width', () => {
    for (const width of [20, 30, 40, 60]) {
      for (const line of renderMarkdown(WIDE_TABLE, width)) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test('every header survives verbatim at every width the box cannot fit', () => {
    // Below the box-fit threshold the stacked layout runs, so each header is
    // emitted whole on its own line rather than wrapped across column bands.
    for (const width of [20, 24, 30, 32, 40, 48]) {
      const text = renderTextAt(WIDE_TABLE, width);
      for (const header of WIDE_HEADERS) {
        expect(text).toContain(header);
      }
    }
  });

  test('at widths the box DOES fit, all eight columns are still drawn', () => {
    // Header text legitimately wraps inside a narrow column band here, so the
    // check that no column was dropped is the border's own column count.
    for (const width of [56, 80, 120]) {
      const top = renderTextAt(WIDE_TABLE, width).split('\n')[0]!;
      expect(top).toContain('┌');
      expect(top).toContain('┐');
      expect([...top].filter((ch) => ch === '┬')).toHaveLength(WIDE_HEADERS.length - 1);
    }
  });

  test('a width wide enough for the box still draws the box', () => {
    const text = renderTextAt(WIDE_TABLE, 120);
    expect(text).toContain('┌');
    expect(text).toContain('└');
  });
});
