/**
 * The modal surface kit against the Measurements table: geometry, caps, the
 * title row, the always-live search row, hint rows, list rows, group
 * spacing, scrolling with honest counts, and the compositor's dim pass and
 * stamp-over.
 */
import { describe, expect, test } from 'bun:test';
import { createEmptyLine, createStyledCell, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { ansiToHex, mixHex } from '@pellux/goodvibes-sdk/platform/presentation';
import { beginModal, finishModal, modalGeometry, searchRow, standardModalWidth } from '../../renderer/surface-kit.ts';
import { drawList, drawRow, type KitRow } from '../../renderer/surface-kit-list.ts';
import { composeLayers, type CellGrid } from '../../renderer/surface-compose.ts';
import { activeTokens, setActiveThemeMode } from '../../renderer/theme.ts';
import { frameFromLayer } from '../helpers/surface-frame.ts';

const text = (line: Line | undefined): string => (line ?? []).map((c) => c.char).join('');

describe('geometry (Measurements table)', () => {
  test('86% of the width, at most 124, centered; below 90 columns the full width minus 1 per side', () => {
    expect(standardModalWidth(100)).toBe(86);
    expect(standardModalWidth(160)).toBe(124);
    expect(standardModalWidth(80)).toBe(78);
    expect(modalGeometry(100, 30).x).toBe(7);
    expect(modalGeometry(80, 24).x).toBe(1);
  });

  test('top edge at 8% of the height, with the same dimmed margin under the bottom cap', () => {
    const g = modalGeometry(120, 40);
    expect(g.y).toBe(3);
    // cap on y-1, fill y..y+h-1, bottom cap y+h, then a margin as tall as the one above the top cap
    expect(40 - (g.y + g.h + 1)).toBe(g.y - 1);
  });

  test('small dialogs size to their content and center', () => {
    const g = modalGeometry(100, 30, { width: 64, height: 9, center: true });
    expect(g.w).toBe(64);
    expect(g.h).toBe(9);
    expect(g.y).toBe(Math.round((30 - 9) / 2));
  });
});

describe('modal frame', () => {
  test('gradient ▄ cap above, surface ▀ cap below, no box-drawing frame', () => {
    const t = activeTokens();
    const layer = finishModal(beginModal(100, 30, { title: 'Commands' }));
    const top = layer.lines[0]!;
    const bottom = layer.lines[layer.lines.length - 1]!;
    expect(top.every((c) => c.char === '▄')).toBe(true);
    expect(top[0]!.fg).toBe(t.brand);
    expect(top[top.length - 1]!.fg).toBe(t.brandEnd);
    expect(top[0]!.bg).toBe(''); // keeps what is underneath
    expect(bottom.every((c) => c.char === '▀' && c.fg === t.backgroundPanel)).toBe(true);
    expect(layer.lines.some((line) => /[┌┐└┘│─]/.test(text(line)))).toBe(false);
  });

  test('title row: ✦ at 4 columns in, bold title, esc keycap ending 4 columns from the right edge', () => {
    const f = beginModal(100, 30, { title: 'Settings', crumbs: ['Display', 'Theme'] });
    const row = f.canvas.lines[f.t]!;
    expect(text(row).indexOf('✦')).toBe(4);
    expect(text(row)).toContain('✦ Settings › Display › Theme');
    expect(row[6]!.bold).toBe(true);
    expect(text(row).trimEnd().endsWith('esc')).toBe(true);
    const esc = text(row).lastIndexOf(' esc ');
    expect(esc + 4).toBe(f.r);
    expect(row[esc]!.bg).toBe(activeTokens().border);
  });

  test('hints sit on the second-to-last fill row; the last fill row is empty', () => {
    const f = beginModal(100, 30, { title: 'x', hints: [['↑↓', 'move'], ['⏎', 'run']] });
    const layer = finishModal(f);
    const lastFill = layer.lines[layer.lines.length - 2]!;
    const hintRow = layer.lines[layer.lines.length - 3]!;
    expect(text(lastFill).trim()).toBe('');
    expect(text(hintRow)).toContain(' ↑↓  move');
    expect(text(hintRow)).toContain(' ⏎  run');
  });

  test('hints wrap onto more rows instead of being clipped', () => {
    const hints = Array.from({ length: 10 }, (_, i) => [`ctrl+${i}`, `action number ${i}`] as const);
    const f = beginModal(60, 30, { title: 'x', hints });
    expect(f.hintRows.length).toBeGreaterThan(1);
    const all = finishModal(f).lines.map(text).join('\n');
    for (let i = 0; i < 10; i++) expect(all).toContain(`action number ${i}`);
  });

  test('the search row is always live: cursor then placeholder, or the query then the cursor; count on the right', () => {
    const f = beginModal(100, 30, { title: 'x' });
    searchRow(f, f.top, '', 'Search sessions', '10 saved');
    expect(text(f.canvas.lines[f.top]).slice(f.l)).toMatch(/^▏Search sessions +10 saved/);
    const g = beginModal(100, 30, { title: 'x' });
    searchRow(g, g.top, 'fix', 'Search sessions');
    expect(text(g.canvas.lines[g.top]).slice(g.l)).toMatch(/^fix▏/);
  });
});

describe('list rows', () => {
  const canvasRow = (row: KitRow, width = 60): Line => {
    const f = beginModal(width + 20, 30, { title: 'x' });
    drawRow(f.canvas, f.top, row, f.l, f.r);
    return f.canvas.lines[f.top]!;
  };

  test('the selected row: a brand → brandEnd gradient inset 2 columns each side, dark bold text', () => {
    const t = activeTokens();
    const f = beginModal(100, 30, { title: 'x' });
    drawRow(f.canvas, f.top, { label: 'Review changes', right: '/diff', selected: true }, f.l, f.r);
    const row = f.canvas.lines[f.top]!;
    expect(row[f.l - 3]!.bg).toBe(t.backgroundPanel);
    expect(row[f.l - 2]!.bg).toBe(t.brand);
    expect(row[f.r + 2]!.bg).toBe(t.brandEnd);
    expect(row[f.r + 3]!.bg).toBe(t.backgroundPanel);
    expect(row[f.l]!.fg).toBe(t.selectedListItemText);
    expect(row[f.l]!.bold).toBe(true);
  });

  test('a selected danger row is red, not the gradient', () => {
    const row = canvasRow({ label: 'Press d again', danger: true, selected: true });
    expect(row.some((c) => c.bg === activeTokens().error)).toBe(true);
    expect(row.some((c) => c.bg === activeTokens().brand)).toBe(false);
  });

  test('markers sit 2 columns in from the text; metadata is right-aligned and faint', () => {
    const f = beginModal(100, 30, { title: 'x' });
    drawRow(f.canvas, f.top, { label: 'Agents', mark: '●', right: '/agents' }, f.l, f.r);
    const row = f.canvas.lines[f.top]!;
    expect(row[f.l - 2]!.char).toBe('●');
    expect(text(row).slice(0, f.r + 1).endsWith('/agents')).toBe(true);
    expect(row[f.r]!.fg).toBe(activeTokens().textFaint);
  });

  test('group headers: ✦ in brandEnd, lowercase violet (accent) bold text', () => {
    const t = activeTokens();
    const f = beginModal(100, 30, { title: 'x' });
    drawRow(f.canvas, f.top, { header: 'Suggested' }, f.l, f.r);
    const row = f.canvas.lines[f.top]!;
    expect(row[f.l - 2]!.char).toBe('✦');
    expect(row[f.l - 2]!.fg).toBe(t.brandEnd);
    expect(text(row).slice(f.l, f.l + 9)).toBe('suggested');
    expect(row[f.l]!.fg).toBe(t.accent);
    expect(row[f.l]!.bold).toBe(true);
  });

  test('long labels wrap onto continuation rows; nothing is clipped', () => {
    const long = 'a very long label that cannot possibly fit on one row of this narrow list, so it wraps';
    const f = beginModal(60, 30, { title: 'x' });
    const used = drawRow(f.canvas, f.top, { label: long }, f.l, f.r);
    expect(used).toBeGreaterThan(1);
    const joined = f.canvas.lines.slice(f.top, f.top + used).map((l) => text(l).trim()).join(' ');
    expect(joined).toBe(long);
  });

  test('a blank row above every group but the first; spacing collapses before any row is cut', () => {
    const rows: KitRow[] = [{ header: 'One' }, { label: 'a' }, { header: 'Two' }, { label: 'b' }];
    const f = beginModal(100, 30, { title: 'x' });
    drawList(f.canvas, { rows, top: f.top, bottom: f.top + 10, x0: f.l, x1: f.r });
    expect(text(f.canvas.lines[f.top + 2]).trim()).toBe('');
    expect(text(f.canvas.lines[f.top + 3])).toContain('two');
    const tight = beginModal(100, 30, { title: 'x' });
    const result = drawList(tight.canvas, { rows, top: tight.top, bottom: tight.top + 3, x0: tight.l, x1: tight.r });
    expect(result.below).toBe(0);
    expect(text(tight.canvas.lines[tight.top + 2])).toContain('two');
  });

  /** Five groups of six items; `selected` is an item index (0..29). */
  function groupedRows(selected: number): KitRow[] {
    const rows: KitRow[] = [];
    for (let g = 0; g < 5; g++) {
      rows.push({ header: `Group ${g}` });
      for (let i = 0; i < 6; i++) rows.push({ label: `item ${g * 6 + i}`, selected: g * 6 + i === selected });
    }
    return rows;
  }

  test('a scrolling list on a wide screen keeps the blank row above each group, and the selected row stays in view', () => {
    for (const selected of [0, 7, 13, 20, 29]) {
      const f = beginModal(120, 40, { title: 'x' });
      const bottom = f.top + 14;
      const result = drawList(f.canvas, { rows: groupedRows(selected), top: f.top, bottom, x0: f.l, x1: f.r });
      const shown = f.canvas.lines.slice(f.top, bottom + 1).map(text);
      expect(shown.join('\n')).toContain(`item ${selected}`);
      // Every header after the first visible row has a blank row above it.
      shown.forEach((line, k) => {
        if (k > 0 && line.includes('group ')) expect(shown[k - 1]!.trim()).toBe('');
      });
      expect(shown.some((line, k) => k > 0 && line.includes('group '))).toBe(true);
      // Nothing is drawn past the list area and the counts cover every hidden item.
      expect(result.endY).toBeLessThanOrEqual(bottom + 1);
      const visibleItems = shown.filter((line) => /item \d+/.test(line)).length;
      expect(result.above + result.below + visibleItems).toBe(30);
    }
  });

  test('below 90 columns, or on a short list area, a scrolling list drops group spacing first', () => {
    const narrow = beginModal(80, 40, { title: 'x' });
    expect(narrow.canvas.compact).toBe(true);
    drawList(narrow.canvas, { rows: groupedRows(0), top: narrow.top, bottom: narrow.top + 14, x0: narrow.l, x1: narrow.r });
    const narrowShown = narrow.canvas.lines.slice(narrow.top, narrow.top + 15).map(text);
    const noSpacer = (lines: string[]): boolean => lines.every((line, k) => !(line.trim() === '' && (lines[k + 1] ?? '').includes('group ')));
    expect(noSpacer(narrowShown)).toBe(true);
    expect(narrowShown.filter((line) => line.includes('group ')).length).toBeGreaterThan(1);

    const short = beginModal(120, 40, { title: 'x' });
    drawList(short.canvas, { rows: groupedRows(0), top: short.top, bottom: short.top + 8, x0: short.l, x1: short.r });
    const shortShown = short.canvas.lines.slice(short.top, short.top + 9).map(text);
    expect(noSpacer(shortShown)).toBe(true);
    expect(shortShown.filter((line) => line.includes('group ')).length).toBeGreaterThan(1);
  });

  test('the selected row is one smooth gradient: every cell interpolated across the full highlight span', () => {
    const t = activeTokens();
    const f = beginModal(120, 30, { title: 'x' });
    drawRow(f.canvas, f.top, { label: 'Changes', desc: 'a tinted diff', right: '/changes', selected: true }, f.l, f.r);
    const row = f.canvas.lines[f.top]!;
    const x = f.l - 2;
    const span = f.r - f.l + 1 + 4;
    for (let q = 0; q < span; q++) expect(row[x + q]!.bg).toBe(mixHex(t.brand, t.brandEnd, q / (span - 1)));
    // Text runs do not restart the gradient: cells outside the highlight keep the fill.
    expect(row[x - 1]!.bg).toBe(t.backgroundPanel);
    expect(row[x + span]!.bg).toBe(t.backgroundPanel);
  });

  test('a long list keeps the selected row in view and counts what it hides', () => {
    const rows: KitRow[] = Array.from({ length: 40 }, (_, i) => ({ label: `item ${i}`, selected: i === 30 }));
    const f = beginModal(100, 30, { title: 'x' });
    const result = drawList(f.canvas, { rows, top: f.top, bottom: f.top + 9, x0: f.l, x1: f.r });
    const shown = f.canvas.lines.slice(f.top, f.top + 10).map(text).join('\n');
    expect(shown).toContain('item 30');
    expect(result.above + result.below).toBe(30);
  });

  test('with a scroll key, moving back up inside the window does not scroll', () => {
    const owner = {};
    const draw = (selected: number): number => {
      const rows: KitRow[] = Array.from({ length: 40 }, (_, i) => ({ label: `item ${i}`, selected: i === selected }));
      const f = beginModal(100, 30, { title: 'x' });
      return drawList(f.canvas, { rows, top: f.top, bottom: f.top + 9, x0: f.l, x1: f.r, scrollKey: { owner, name: 'list' } }).start;
    };
    const atBottom = draw(20);
    expect(draw(19)).toBe(atBottom);
    expect(draw(15)).toBe(atBottom);
    expect(draw(5)).toBeLessThan(atBottom);
  });
});

describe('dim pass and stamp-over', () => {
  function grid(lines: Line[], width: number): CellGrid {
    return {
      width,
      height: lines.length,
      getCell: (x, y) => lines[y]?.[x],
      setCell: (x, y, cell) => { lines[y]![x] = cell; },
    };
  }

  test('every cell blends toward the scrim; cells outside the modal keep their (dimmed) content', () => {
    setActiveThemeMode('dark');
    const screen = [createEmptyLine(20), createEmptyLine(20), createEmptyLine(20)];
    screen[0]![0] = createStyledCell('x', { fg: activeTokens().text, bg: activeTokens().backgroundPanel });
    composeLayers(grid(screen, 20), [{ x: 5, y: 1, lines: [Array.from({ length: 4 }, () => createStyledCell('m', { fg: activeTokens().text, bg: activeTokens().backgroundPanel }))], dim: true }]);
    expect(screen[0]![0]!.char).toBe('x');
    expect(screen[0]![0]!.bg).toBe(mixHex(activeTokens().backgroundPanel, ansiToHex(0), 0.62));
    // An empty background resolves before blending: never left as the raw terminal default.
    expect(screen[2]![0]!.bg).not.toBe('');
    // Stamped cells are the layer's, undimmed.
    expect(screen[1]![5]!.char).toBe('m');
    expect(screen[1]![5]!.bg).toBe(activeTokens().backgroundPanel);
  });

  test('a cap cell with no background takes the background underneath', () => {
    const frame = frameFromLayer(finishModal(beginModal(100, 30, { title: 'x' })), 100, 30);
    const g = modalGeometry(100, 30);
    const cap = frame[g.y - 1]![g.x]!;
    expect(cap.char).toBe('▄');
    expect(cap.bg).toBe(frame[0]![0]!.bg);
  });

  test('a wide glyph cut by the layer edge is blanked, not left half drawn', () => {
    const screen = [createEmptyLine(10)];
    screen[0]![3] = createStyledCell('界', {});
    screen[0]![4] = { ...createStyledCell(' '), char: '' };
    composeLayers(grid(screen, 10), [{ x: 4, y: 0, lines: [[createStyledCell('m', { bg: activeTokens().backgroundPanel })]], dim: false }]);
    expect(screen[0]![3]!.char).toBe(' ');
    expect(screen[0]![4]!.char).toBe('m');
  });

  test('no fragment of backdrop text shows beside a modal (live defect: a stray \'/\' at column 8 beside the recovery modal)', () => {
    setActiveThemeMode('dark');
    // The splash's working-directory line overhung the recovery modal by two
    // cells on the left and one on the right; a whole word further out stays.
    const text = 'ok /tmp/demo-proj-ab ok';
    const screen = [createEmptyLine(text.length)];
    for (let x = 0; x < text.length; x++) screen[0]![x] = createStyledCell(text[x]!, { fg: activeTokens().text });
    const fill = Array.from({ length: 14 }, () => createStyledCell(' ', { bg: activeTokens().backgroundPanel }));
    composeLayers(grid(screen, text.length), [{ x: 5, y: 0, lines: [fill], dim: true }]); // columns 5..18
    const row = screen[0]!.map((cell) => cell.char).join('');
    expect(row).toBe('ok' + ' '.repeat(19) + 'ok'); // '/t' and 'b' are gone, both 'ok's stay
    // Only glyphs go: the cleared cells keep the dimmed backdrop's colours.
    expect(screen[0]![3]!.bg).toBe(screen[0]![0]!.bg);
    expect(screen[0]![5]!.bg).toBe(activeTokens().backgroundPanel);
  });

  test('a cut wide glyph goes whole, never half of it', () => {
    const screen = [createEmptyLine(10)];
    screen[0]![6] = createStyledCell('界', {});
    screen[0]![7] = { ...createStyledCell(' '), char: '' };
    composeLayers(grid(screen, 10), [{ x: 2, y: 0, lines: [Array.from({ length: 4 }, () => createStyledCell('m', { bg: activeTokens().backgroundPanel }))], dim: true }]);
    expect(screen[0]![6]!.char).toBe(' ');
    expect(screen[0]![7]!.char).toBe(' ');
  });

  test('a layer that does not dim leaves its neighbours alone', () => {
    const screen = [createEmptyLine(10)];
    screen[0]![1] = createStyledCell('/', {});
    composeLayers(grid(screen, 10), [{ x: 2, y: 0, lines: [[createStyledCell('t', { bg: activeTokens().backgroundPanel })]], dim: false }]);
    expect(screen[0]![1]!.char).toBe('/');
  });

  test('a layer that does not dim (a toast) is stamped as it is', () => {
    const screen = [createEmptyLine(10)];
    composeLayers(grid(screen, 10), [{ x: 0, y: 0, lines: [[createStyledCell('t', { fg: activeTokens().warning, bg: activeTokens().backgroundPanel })]], dim: false }]);
    expect(screen[0]![0]!.fg).toBe(activeTokens().warning);
    expect(screen[0]![5]!.bg).toBe('');
  });
});
