// ---------------------------------------------------------------------------
// frame-audit-gap.test.ts, the layout audit's GAP check on hand-made frames:
// output text, the throbber, the input area and the status line must never
// touch (helpers/frame-audit.ts). The golden frames are audited with the same
// check in golden-frames-audit.test.ts.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { activeTokens } from '../../renderer/theme.ts';
import { auditFrame } from '../helpers/frame-audit.ts';

function row(width: number, content = '', opts: { fill?: boolean; bar?: string; x?: number } = {}): Line {
  const t = activeTokens();
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  if (opts.fill) for (let x = 3; x <= width - 3; x++) line[x] = { ...line[x]!, bg: t.backgroundElement };
  if (opts.bar) line[2] = { ...line[2]!, char: opts.bar };
  [...content].forEach((ch, k) => { const x = (opts.x ?? 5) + k; if (x < width) line[x] = { ...line[x]!, char: ch }; });
  return line;
}

function capRow(width: number, ch: '▄' | '▀'): Line {
  const t = activeTokens();
  const line = row(width, '', { bar: ch === '▄' ? '╻' : '╹' });
  for (let x = 3; x <= width - 3; x++) line[x] = { ...line[x]!, char: ch, fg: t.backgroundElement };
  return line;
}

function throbberRow(width: number, words: string): Line {
  const line = row(width, words, { x: 5 });
  line[3] = { ...line[3]!, char: '⠋' };
  return line;
}

function inputArea(width: number): Line[] {
  return [row(width, '', { fill: true, bar: '┃' }), row(width, 'Ask anything', { fill: true, bar: '┃' }), row(width, '', { fill: true, bar: '┃' })];
}

const W = 60;
const gaps = (lines: Line[]): string[] => auditFrame(lines, W, activeTokens()).filter((i) => i.kind === 'GAP').map((i) => `row ${i.row}: ${i.detail}`);

describe('layout audit: output text, throbber, input area and status line never touch', () => {
  test('the full stack with its gaps passes', () => {
    expect(gaps([row(W, '| 2 | 400 |', { x: 3 }), row(W), throbberRow(W, 'Thinking... · 12s'), capRow(W, '▄'), ...inputArea(W), capRow(W, '▀'), row(W, 'normal   main', { x: 3 })])).toEqual([]);
  });

  test('at rest, output text half a row over the input area passes', () => {
    expect(gaps([row(W, '| 2 | 400 |', { x: 3 }), capRow(W, '▄'), ...inputArea(W), capRow(W, '▀'), row(W, 'normal   main', { x: 3 })])).toEqual([]);
  });

  test('output text directly on the input area fails', () => {
    expect(gaps([row(W, 'title'), row(W, '| 2 | 400 |', { x: 3 }), ...inputArea(W), capRow(W, '▀'), row(W, 'normal   main', { x: 3 })])).toEqual([
      'row 1: text directly over the input area :: | 2 | 400 |',
    ]);
  });

  test('the status line directly under the input area fails', () => {
    expect(gaps([row(W, 'title'), capRow(W, '▄'), ...inputArea(W), row(W, 'normal   main', { x: 3 })])).toEqual([
      'row 5: text directly under the input area :: normal   main',
    ]);
  });

  test('the throbber directly on the input area fails', () => {
    expect(gaps([row(W, 'title'), row(W), throbberRow(W, 'Thinking... · 12s'), ...inputArea(W), capRow(W, '▀'), row(W, 'normal   main', { x: 3 })])).toEqual([
      'row 2: text directly over the input area :: ⠋ Thinking... · 12s',
    ]);
  });

  test('output text directly on the throbber fails', () => {
    expect(gaps([row(W, 'title'), row(W, '| 2 | 400 |', { x: 3 }), throbberRow(W, 'Thinking... · 12s'), capRow(W, '▄'), ...inputArea(W), capRow(W, '▀'), row(W, 'normal   main', { x: 3 })])).toEqual([
      'row 1: no empty row between the throbber and the text above it :: | 2 | 400 |',
    ]);
  });
});

describe('layout audit: a table border is output too', () => {
  test('a table\'s bottom border directly on the input area fails', () => {
    expect(gaps([row(W, 'title'), row(W, '└─────┴─────┘', { x: 3 }), ...inputArea(W), capRow(W, '▀'), row(W, 'normal   main', { x: 3 })])).toEqual([
      'row 1: text directly over the input area :: └─────┴─────┘',
    ]);
  });
});

const headerIssues = (lines: Line[]): string[] => auditFrame(lines, W, activeTokens()).filter((i) => i.kind === 'HEADER').map((i) => `row ${i.row}: ${i.detail}`);
const header = (): Line => row(W, 'GoodVibes 2.0.21', { x: 1 });
const chips = (): Line => row(W, '◐ main     ◐ engineer     tab  next    shift+tab  prev', { x: 5 });
const stackBottom = (): Line[] => [capRow(W, '▄'), ...inputArea(W), capRow(W, '▀'), row(W, 'normal   main', { x: 3 })];

describe('layout audit: output never touches the header', () => {
  test('the header, one empty row, then output passes', () => {
    expect(headerIssues([header(), row(W), row(W, 'The retry helper never backs off.'), ...stackBottom()])).toEqual([]);
  });

  test('output directly under the header fails', () => {
    expect(headerIssues([header(), row(W, 'The retry helper never backs off.'), row(W), ...stackBottom()])).toEqual([
      'row 1: output directly under the header :: The retry helper never backs off.',
    ]);
  });

  test('with the session chips row, the row after the chips is the one that must stay empty', () => {
    expect(headerIssues([header(), chips(), row(W), row(W, 'output'), ...stackBottom()])).toEqual([]);
    expect(headerIssues([header(), chips(), row(W, 'output'), ...stackBottom()])).toEqual(['row 2: output directly under the header :: output']);
  });

  test('the input area\'s own cap right under the header is not output', () => {
    expect(headerIssues([header(), ...stackBottom()])).toEqual([]);
  });
});
