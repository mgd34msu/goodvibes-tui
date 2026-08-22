import { describe, expect, test } from 'bun:test';
import {
  buildAlignedRow,
  buildStatusBadge,
  buildTreeRow,
  buildTable,
  buildKeyboardHints,
  buildPanelLine,
  DEFAULT_PANEL_PALETTE,
  type ColumnSpec,
} from '../../panels/polish.ts';
import { lineToString } from '../setup.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';

const P = DEFAULT_PANEL_PALETTE;
const CJK = '世界'; // 世界, 4 display columns, 2 code points

describe('buildAlignedRow', () => {
  const cols: ColumnSpec[] = [
    { width: 8, align: 'left' },
    { width: 6, align: 'right' },
  ];

  test('pads and aligns columns to exact widths', () => {
    const line = buildAlignedRow(60, [
      { text: 'name', fg: P.value },
      { text: '42', fg: P.value },
    ], cols, { gap: 1 });
    const text = lineToString(line);
    expect(text.startsWith('name    ')).toBe(true);
    expect(text).toContain('    42');
  });

  test('wide chars (CJK) do not break column alignment', () => {
    const line = buildAlignedRow(40, [
      { text: CJK, fg: P.value },
      { text: 'x', fg: P.value },
    ], [{ width: 6, align: 'left' }, { width: 4, align: 'left' }], { gap: 1 });
    // Grid emits a spacer cell after each wide char; col2 still starts at col 7.
    expect(line[0].char).toBe(CJK[0]);
    expect(line[2].char).toBe(CJK[1]);
    expect(line[7].char).toBe('x');
    expect(getDisplayWidth(CJK)).toBe(4);
  });

  test('truncates overlong text to the column width', () => {
    const line = buildAlignedRow(40, [
      { text: 'a-very-long-name-that-overflows', fg: P.value },
      { text: '1', fg: P.value },
    ], cols);
    expect(lineToString(line)).toContain('…'); // …
  });
});

describe('buildStatusBadge', () => {
  test('renders distinct glyph + label per kind', () => {
    expect(lineToString(buildPanelLine(40, buildStatusBadge('running')))).toContain('Running');
    expect(lineToString(buildPanelLine(40, buildStatusBadge('failed')))).toContain('Failed');
  });

  test('running and completed use different colors', () => {
    expect(buildStatusBadge('running')[0].fg).not.toBe(buildStatusBadge('completed')[0].fg);
  });

  test('supports custom label and count', () => {
    const seg = buildStatusBadge('completed', 'Done', { count: 3 });
    expect(seg[0].text.endsWith('Done (3)')).toBe(true);
  });
});

describe('buildTreeRow', () => {
  test('indents by depth and shows expand/collapse glyph', () => {
    const collapsed = lineToString(buildTreeRow(60, { depth: 1, label: 'src', expandable: true, expanded: false }, P));
    const expanded = lineToString(buildTreeRow(60, { depth: 1, label: 'src', expandable: true, expanded: true }, P));
    expect(collapsed).toContain('▸'); // ▸
    expect(expanded).toContain('▾');  // ▾
    expect(collapsed.indexOf('src')).toBeGreaterThan(1); // indented
  });

  test('right-aligns metadata', () => {
    const line = buildTreeRow(40, {
      depth: 0,
      label: 'file.ts',
      metadata: [{ text: '2.1K', fg: P.dim }],
    }, P);
    const text = lineToString(line);
    expect(text).toContain('file.ts');
    expect(text.trimEnd().endsWith('2.1K')).toBe(true);
  });
});

describe('buildTable', () => {
  test('renders a header plus aligned data rows', () => {
    const lines = buildTable(60, [
      { label: 'Name', width: 20 },
      { label: 'Count', width: 8, align: 'right' },
    ], [
      { cells: [{ text: 'alpha' }, { text: '3' }] },
      { cells: [{ text: 'beta' }, { text: '12' }], selected: true },
    ], P);
    expect(lines.length).toBe(3);
    expect(lineToString(lines[0])).toContain('Name');
    expect(lineToString(lines[0])).toContain('Count');
    expect(lineToString(lines[1])).toContain('alpha');
    expect(lineToString(lines[2])).toContain('beta');
  });

  test('auto-distributes width to unsized columns without throwing', () => {
    expect(() => buildTable(50, [
      { label: 'A' },
      { label: 'B' },
    ], [{ cells: [{ text: 'x' }, { text: 'y' }] }], P)).not.toThrow();
  });
});

describe('buildKeyboardHints', () => {
  test('renders keys and labels', () => {
    const line = buildKeyboardHints(80, [
      { keys: '↑/↓', label: 'move' },
      { keys: 'Enter', label: 'open' },
    ], P);
    const text = lineToString(line);
    expect(text).toContain('↑/↓');
    expect(text).toContain('move');
    expect(text).toContain('Enter');
    expect(text).toContain('open');
  });
});
