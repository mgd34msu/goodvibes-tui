import { describe, expect, test } from 'bun:test';
import { SelectionManager } from '../../input/selection.ts';
import { createEmptyLine, createStyledCell, type Line } from '@pellux/goodvibes-sdk/platform/types/grid';

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

  test('preserves leading indentation when copying code lines', () => {
    const line = createEmptyLine(40);
    line[0] = createStyledCell(' ');
    line[1] = createStyledCell(' ');
    line[2] = createStyledCell('1', { fg: '238', dim: true, bg: '#0d0d0d' });
    line[3] = createStyledCell(' ', { fg: '238', dim: true, bg: '#0d0d0d' });
    line[4] = createStyledCell(' ', { bg: '#0d0d0d' });
    line[5] = createStyledCell(' ');
    line[6] = createStyledCell(' ');
    line[7] = createStyledCell('r');
    line[8] = createStyledCell('e');
    line[9] = createStyledCell('t');
    line[10] = createStyledCell('u');
    line[11] = createStyledCell('r');
    line[12] = createStyledCell('n');
    line[13] = createStyledCell(' ');
    line[14] = createStyledCell('x');
    line[15] = createStyledCell(';');

    const selection = new SelectionManager();
    selection.anchor = { row: 0, col: 0 };
    selection.focus = { row: 0, col: 16 };

    const text = selection.getSelectedText(makeHistory([line]) as never);
    expect(text).toBe('  return x;');
  });

  test('preserves blank lines inside a multi-line code selection', () => {
    const first = createEmptyLine(20);
    first[0] = createStyledCell('c');
    first[1] = createStyledCell('o');
    first[2] = createStyledCell('n');
    first[3] = createStyledCell('s');
    first[4] = createStyledCell('t');
    first[5] = createStyledCell(' ');
    first[6] = createStyledCell('x');
    first[7] = createStyledCell(' ');
    first[8] = createStyledCell('=');
    first[9] = createStyledCell(' ');
    first[10] = createStyledCell('1');

    const blank = createEmptyLine(20);

    const third = createEmptyLine(20);
    third[0] = createStyledCell('r');
    third[1] = createStyledCell('e');
    third[2] = createStyledCell('t');
    third[3] = createStyledCell('u');
    third[4] = createStyledCell('r');
    third[5] = createStyledCell('n');
    third[6] = createStyledCell(' ');
    third[7] = createStyledCell('x');

    const selection = new SelectionManager();
    selection.anchor = { row: 0, col: 0 };
    selection.focus = { row: 2, col: 8 };

    const text = selection.getSelectedText(makeHistory([first, blank, third]) as never);
    expect(text).toBe('const x = 1\n\nreturn x');
  });

  test('does not treat code indentation as margin when line numbers are hidden', () => {
    const line = createEmptyLine(30);
    line[4] = createStyledCell(' ', { bg: '#0d0d0d' });
    line[5] = createStyledCell(' ', { bg: '#0d0d0d' });
    line[6] = createStyledCell('i', { bg: '#0d0d0d' });
    line[7] = createStyledCell('f', { bg: '#0d0d0d' });
    line[8] = createStyledCell(' ', { bg: '#0d0d0d' });
    line[9] = createStyledCell('(', { bg: '#0d0d0d' });
    line[10] = createStyledCell('x', { bg: '#0d0d0d' });
    line[11] = createStyledCell(')', { bg: '#0d0d0d' });

    const selection = new SelectionManager();
    selection.anchor = { row: 0, col: 0 };
    selection.focus = { row: 0, col: 12 };

    const text = selection.getSelectedText(makeHistory([line]) as never);
    expect(text).toBe('  if (x)');
  });
});
