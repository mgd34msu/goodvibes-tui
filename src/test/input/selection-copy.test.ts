import { describe, expect, test } from 'bun:test';
import { SelectionManager } from '../../input/selection.ts';
import { createEmptyLine, createStyledCell, type Line } from '../../types/grid.ts';

function makeHistory(lines: Line[]) {
  return {
    getAllLines: () => lines,
  };
}

describe('SelectionManager clipboard copy', () => {
  test('strips visual code-block line-number gutters from copied text', () => {
    const line = createEmptyLine(40);
    line[0] = createStyledCell(' ');
    line[1] = createStyledCell(' ');
    line[2] = createStyledCell('1', { fg: '238', dim: true, bg: '#0d0d0d' });
    line[3] = createStyledCell(' ', { fg: '238', dim: true, bg: '#0d0d0d' });
    line[4] = createStyledCell(' ', { bg: '#0d0d0d' });
    line[5] = createStyledCell('c');
    line[6] = createStyledCell('o');
    line[7] = createStyledCell('n');
    line[8] = createStyledCell('s');
    line[9] = createStyledCell('t');

    const selection = new SelectionManager();
    selection.anchor = { row: 0, col: 0 };
    selection.focus = { row: 0, col: 10 };

    const text = selection.getSelectedText(makeHistory([line]) as never);
    expect(text).toBe('const');
  });

  test('strips visual all-lines gutters with divider from copied text', () => {
    const line = createEmptyLine(40);
    line[0] = createStyledCell(' ');
    line[1] = createStyledCell(' ');
    line[2] = createStyledCell('1', { fg: '238', dim: true });
    line[3] = createStyledCell(' ', { fg: '238', dim: true });
    line[4] = createStyledCell('│', { fg: '238', dim: true });
    line[5] = createStyledCell(' ', { fg: '238', dim: true });
    line[6] = createStyledCell('h');
    line[7] = createStyledCell('e');
    line[8] = createStyledCell('l');
    line[9] = createStyledCell('l');
    line[10] = createStyledCell('o');

    const selection = new SelectionManager();
    selection.anchor = { row: 0, col: 0 };
    selection.focus = { row: 0, col: 11 };

    const text = selection.getSelectedText(makeHistory([line]) as never);
    expect(text).toBe('hello');
  });

  test('strips decorative row markers from copied semantic content', () => {
    const line = createEmptyLine(40);
    line[0] = createStyledCell('▸', { fg: '#38bdf8', bold: true });
    line[1] = createStyledCell(' ');
    line[2] = createStyledCell('R');
    line[3] = createStyledCell('u');
    line[4] = createStyledCell('n');
    line[5] = createStyledCell(' ');
    line[6] = createStyledCell('t');
    line[7] = createStyledCell('a');
    line[8] = createStyledCell('s');
    line[9] = createStyledCell('k');

    const selection = new SelectionManager();
    selection.anchor = { row: 0, col: 0 };
    selection.focus = { row: 0, col: 10 };

    const text = selection.getSelectedText(makeHistory([line]) as never);
    expect(text).toBe('Run task');
  });
});
