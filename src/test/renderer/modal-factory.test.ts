import { describe, test, expect } from 'bun:test';
import { ModalFactory } from '../../renderer/modal-factory.ts';
import { lineToString, linesToText } from '../setup.ts';

const W = 100; // terminal width for tests

// ── Helpers ──────────────────────────────────────────────────────────────────────────

/** All lines should be exactly terminalWidth cells wide. */
function expectWidths(lines: ReturnType<typeof ModalFactory.createModal>, width: number) {
  for (let i = 0; i < lines.length; i++) {
    expect(lines[i].length).toBe(width);
  }
}

// ── createModal ────────────────────────────────────────────────────────────────────

describe('ModalFactory.createModal', () => {
  test('returns Line array', () => {
    const lines = ModalFactory.createModal({ title: 'Test', sections: [] }, W);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(2); // title + footer at minimum
  });

  test('all lines have correct terminal width', () => {
    const lines = ModalFactory.createModal({
      title: 'Width Test',
      sections: [{ type: 'text', content: 'hello' }],
    }, W);
    expectWidths(lines, W);
  });

  test('first line contains title text', () => {
    const lines = ModalFactory.createModal({ title: 'My Modal', sections: [] }, W);
    const first = lineToString(lines[0]);
    expect(first).toContain('My Modal');
  });

  test('first line contains top-left corner character', () => {
    const lines = ModalFactory.createModal({ title: 'Test', sections: [] }, W);
    const first = lineToString(lines[0]);
    expect(first).toContain('\u250c');
    expect(first).toContain('\u2510');
  });

  test('last line contains bottom border characters', () => {
    const lines = ModalFactory.createModal({ title: 'Test', sections: [] }, W);
    const last = lineToString(lines[lines.length - 1]);
    expect(last).toContain('\u2514');
    expect(last).toContain('\u2518');
  });

  test('hints appear in the footer line', () => {
    const lines = ModalFactory.createModal({
      title: 'Test',
      sections: [],
      hints: ['[\u2191\u2193] Navigate', '[Enter] Select'],
    }, W);
    const last = lineToString(lines[lines.length - 1]);
    expect(last).toContain('Navigate');
    expect(last).toContain('Select');
  });

  test('footer string appears in the footer line', () => {
    const lines = ModalFactory.createModal({
      title: 'Test',
      sections: [],
      footer: 'Press Esc to close',
    }, W);
    const last = lineToString(lines[lines.length - 1]);
    expect(last).toContain('Esc');
  });

  test('respects custom box width', () => {
    const linesWide = ModalFactory.createModal({ title: 'T', sections: [], width: 60 }, W);
    const linesNarrow = ModalFactory.createModal({ title: 'T', sections: [], width: 40 }, W);
    // Narrower box => shorter border string in title
    const wideTitle = lineToString(linesWide[0]).trimEnd();
    const narrowTitle = lineToString(linesNarrow[0]).trimEnd();
    expect(wideTitle.length).toBeGreaterThan(narrowTitle.length);
  });

  test('respects custom margin', () => {
    const linesNoMargin = ModalFactory.createModal({
      title: 'T', sections: [], margin: 0,
    }, W);
    const linesMargin8 = ModalFactory.createModal({
      title: 'T', sections: [], margin: 8,
    }, W);
    const noMargTitle = lineToString(linesNoMargin[0]);
    const margTitle = lineToString(linesMargin8[0]);
    // margin=0 title starts with corner char, margin=8 starts with spaces
    expect(noMargTitle.trimStart()).toEqual(noMargTitle);
    expect(margTitle.startsWith('        ')).toBe(true);
  });

  test('box width is clamped to terminal width minus margins', () => {
    // Very wide requested box on narrow terminal => fits within terminal
    const narrowW = 30;
    const lines = ModalFactory.createModal({ title: 'T', sections: [], width: 200 }, narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });

  // Sections —————————————————————————————————————————————

  test('text section content appears in output', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [{ type: 'text', content: 'Hello World' }],
    }, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Hello World');
  });

  test('text section multi-line splits on newlines', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [{ type: 'text', content: 'Line A\nLine B\nLine C' }],
    }, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Line A');
    expect(text).toContain('Line B');
    expect(text).toContain('Line C');
  });

  test('separator section renders \u251c...\u2524 line', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [{ type: 'separator' }],
    }, W);
    const texts = linesToText(lines);
    const hasSep = texts.some((t) => t.includes('\u251c') && t.includes('\u2524'));
    expect(hasSep).toBe(true);
  });

  test('list section renders items', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [{
        type: 'list',
        items: [
          { label: 'Alpha' },
          { label: 'Beta' },
          { label: 'Gamma' },
        ],
      }],
    }, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text).toContain('Gamma');
  });

  test('list section: selected item has selection indicator', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [{
        type: 'list',
        items: [
          { label: 'One', selected: false },
          { label: 'Two', selected: true },
          { label: 'Three', selected: false },
        ],
      }],
    }, W);
    const texts = linesToText(lines);
    const selectedLine = texts.find((t) => t.includes('\u25b6') && t.includes('Two'));
    expect(selectedLine).toBeTruthy();
  });

  test('list section: selected item cells have bold=true', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [{
        type: 'list',
        items: [{ label: 'Target', selected: true }],
      }],
    }, W);
    // The line with the selected item should have bold cells
    const selectedLineIndex = lines.findIndex((line) =>
      line.some((cell) => cell.char === '\u25b6'),
    );
    expect(selectedLineIndex).toBeGreaterThan(-1);
    const hasBold = lines[selectedLineIndex].some((c) => c.bold);
    expect(hasBold).toBe(true);
  });

  test('list section: unselected items do not show indicator', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [{
        type: 'list',
        items: [{ label: 'NotSelected', selected: false }],
      }],
    }, W);
    const texts = linesToText(lines);
    const hasArrow = texts.some((t) => t.includes('\u25b6') && t.includes('NotSelected'));
    expect(hasArrow).toBe(false);
  });

  test('input section renders cursor and content', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [{ type: 'input', content: 'myquery' }],
    }, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('myquery');
    expect(text).toContain('\u2588'); // block cursor
  });

  test('input section renders empty query with cursor', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [{ type: 'input', content: '' }],
    }, W);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('\u2588');
  });

  test('multiple sections rendered in order', () => {
    const lines = ModalFactory.createModal({
      title: 'T',
      sections: [
        { type: 'text', content: 'First' },
        { type: 'separator' },
        { type: 'text', content: 'Second' },
      ],
    }, W);
    const texts = linesToText(lines).join('\n');
    const firstIdx = texts.indexOf('First');
    const secondIdx = texts.indexOf('Second');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});

// ── renderTitle ────────────────────────────────────────────────────────────────────

describe('ModalFactory.renderTitle', () => {
  test('returns a single Line', () => {
    const line = ModalFactory.renderTitle(72, 4, 'Hello', W);
    expect(Array.isArray(line)).toBe(true);
    expect(line.length).toBe(W);
  });

  test('contains title text', () => {
    const line = ModalFactory.renderTitle(72, 4, 'My Title', W);
    expect(lineToString(line)).toContain('My Title');
  });

  test('contains corner characters', () => {
    const text = lineToString(ModalFactory.renderTitle(60, 4, 'T', W));
    expect(text).toContain('\u250c');
    expect(text).toContain('\u2510');
  });

  test('custom style changes fg color', () => {
    const line = ModalFactory.renderTitle(60, 4, 'T', W, { titleFg: '#ff0000' });
    const colored = line.find((c) => c.char !== ' ' && c.fg === '#ff0000');
    expect(colored).toBeTruthy();
  });
});

// ── renderHints ────────────────────────────────────────────────────────────────────

describe('ModalFactory.renderHints', () => {
  test('returns a single Line', () => {
    const line = ModalFactory.renderHints(72, 4, '', W);
    expect(Array.isArray(line)).toBe(true);
    expect(line.length).toBe(W);
  });

  test('contains hint text', () => {
    const line = ModalFactory.renderHints(72, 4, '[Esc] Close', W);
    expect(lineToString(line)).toContain('Esc');
  });

  test('contains bottom-left corner character', () => {
    const text = lineToString(ModalFactory.renderHints(60, 4, '', W));
    expect(text).toContain('\u2514');
    expect(text).toContain('\u2518');
  });

  test('empty hints still produces valid border', () => {
    const line = ModalFactory.renderHints(60, 4, '', W);
    const text = lineToString(line);
    expect(text).toContain('\u2514');
    expect(text).toContain('\u2518');
  });
});

// ── renderListItem ────────────────────────────────────────────────────────────────

describe('ModalFactory.renderListItem', () => {
  test('returns a single Line of correct width', () => {
    const line = ModalFactory.renderListItem(72, 4, 'item', false, W);
    expect(Array.isArray(line)).toBe(true);
    expect(line.length).toBe(W);
  });

  test('selected item has indicator', () => {
    const line = ModalFactory.renderListItem(72, 4, 'item', true, W);
    const text = lineToString(line);
    expect(text).toContain('\u25b6');
    expect(text).toContain('item');
  });

  test('unselected item has no indicator', () => {
    const line = ModalFactory.renderListItem(72, 4, 'item', false, W);
    const text = lineToString(line);
    expect(text).not.toContain('\u25b6');
    expect(text).toContain('item');
  });

  test('selected item has bold cells', () => {
    const line = ModalFactory.renderListItem(72, 4, 'bold-item', true, W);
    const hasBold = line.some((c) => c.bold);
    expect(hasBold).toBe(true);
  });

  test('unselected item has no bold cells (or only space cells)', () => {
    const line = ModalFactory.renderListItem(72, 4, 'plain', false, W);
    // Non-space cells should not be bold
    const nonSpaceBold = line.filter((c) => c.char !== ' ' && c.bold);
    expect(nonSpaceBold.length).toBe(0);
  });

  test('very long text is truncated with ellipsis', () => {
    const longText = 'a'.repeat(200);
    const line = ModalFactory.renderListItem(72, 4, longText, false, W);
    const text = lineToString(line);
    expect(text).toContain('\u2026');
  });

  test('contains border chars on both sides', () => {
    const line = ModalFactory.renderListItem(72, 4, 'x', false, W);
    const text = lineToString(line);
    expect(text).toContain('\u2502');
  });
});

// ── renderBox ────────────────────────────────────────────────────────────────────────

describe('ModalFactory.renderBox', () => {
  test('wraps content with top and bottom borders', () => {
    const content: ReturnType<typeof ModalFactory.createModal> = [
      ModalFactory.renderListItem(68, 4, 'row', false, W),
    ];
    const boxed = ModalFactory.renderBox(72, 4, content, W);
    expect(boxed.length).toBe(3); // top + content + bottom
    expect(lineToString(boxed[0])).toContain('\u250c');
    expect(lineToString(boxed[2])).toContain('\u2514');
  });

  test('all lines have correct width', () => {
    const content: ReturnType<typeof ModalFactory.createModal> = [
      ModalFactory.renderListItem(68, 4, 'x', false, W),
    ];
    const boxed = ModalFactory.renderBox(72, 4, content, W);
    for (const line of boxed) {
      expect(line.length).toBe(W);
    }
  });

  test('empty content produces 2-line box', () => {
    const boxed = ModalFactory.renderBox(72, 4, [], W);
    expect(boxed.length).toBe(2);
  });
});

// ── File-picker compatibility ──────────────────────────────────────────────────

describe('file-picker overlay compatibility', () => {
  test('reproduces structural elements: title, search input, results, hints', () => {
    const lines = ModalFactory.createModal({
      title: 'Select File',
      width: 70,
      margin: 4,
      sections: [
        { type: 'input', content: 'myfile' },
        { type: 'separator' },
        {
          type: 'list',
          items: [
            { label: 'src/main.ts', selected: true },
            { label: 'src/utils.ts', selected: false },
          ],
        },
      ],
      hints: ['[\u2191\u2193] Navigate', '[Enter] Select', '[Esc] Cancel'],
    }, W);

    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Select File');
    expect(texts).toContain('myfile');
    expect(texts).toContain('src/main.ts');
    expect(texts).toContain('src/utils.ts');
    expect(texts).toContain('Navigate');
    expect(texts).toContain('Cancel');
    expectWidths(lines, W);
  });
});

// ── Model-picker compatibility ──────────────────────────────────────────────────

describe('model-picker overlay compatibility', () => {
  test('reproduces model list with selection and hints', () => {
    const lines = ModalFactory.createModal({
      title: 'Select Model',
      width: 72,
      margin: 4,
      sections: [
        {
          type: 'list',
          items: [
            { label: 'claude-3-5-sonnet', selected: true },
            { label: 'gpt-4o', selected: false },
            { label: 'gemini-2.0', selected: false },
          ],
        },
        { type: 'separator' },
        { type: 'text', content: 'Provider: anthropic' },
      ],
      hints: ['[\u2191\u2193] Navigate', '[Enter] Select', '[Esc] Cancel'],
    }, W);

    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Select Model');
    expect(texts).toContain('claude-3-5-sonnet');
    expect(texts).toContain('gpt-4o');
    expect(texts).toContain('Provider: anthropic');
    expectWidths(lines, W);
  });
});

// ── Selection-modal compatibility ──────────────────────────────────────────────

describe('selection-modal overlay compatibility', () => {
  test('reproduces title, search input, item list and footer hints', () => {
    const lines = ModalFactory.createModal({
      title: 'Choose Action',
      width: 72,
      margin: 4,
      sections: [
        { type: 'input', content: '' },
        { type: 'separator' },
        {
          type: 'list',
          items: [
            { label: 'New Chat', selected: true },
            { label: 'Open File', selected: false },
            { label: 'Settings', selected: false },
          ],
        },
      ],
      hints: ['[\u2191\u2193] Navigate', '[Enter] Select', '[Esc] Close'],
    }, W);

    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('Choose Action');
    expect(texts).toContain('New Chat');
    expect(texts).toContain('Open File');
    expect(texts).toContain('Navigate');
    expectWidths(lines, W);
  });
});
