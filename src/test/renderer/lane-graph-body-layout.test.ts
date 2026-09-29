/**
 * An opened bead body keeps the layout of what it shows: a read's file text
 * or a command's output keeps its indentation, tabs become spaces the same way
 * everywhere, and no row runs past the body's edge.
 *
 * Live run on 14d4e369: opening a read bead drew every file line flush left
 * (the body wrapped through a prose word-wrapper that drops leading spaces).
 */
import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { beadBody } from '../../renderer/lane-graph/bead.ts';
import { laneGlyphs } from '../../renderer/lane-graph/glyphs.ts';
import { paintBody } from '../../renderer/lane-graph/paint.ts';
import { BODY_TAB_WIDTH, getDisplayWidth, wrapPreservingIndent } from '../../utils/terminal-width.ts';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, arguments: args });
const rowText = (line: ReadonlyArray<{ char: string }>): string => line.map((c) => c.char || ' ').join('');

const FILE = [
  'export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {',
  '  for (let i = 0; i < 3; i++) {',
  '    try {',
  '\treturn await fn();',
  '    } catch {}',
  '  }',
  '}',
].join('\n');

function paintedRows(content: string, width: number, name = 'read'): string[] {
  const body = beadBody(call(name, { files: [{ path: 'src/net/retry.ts' }] }), 'ok', content);
  if (!body) throw new Error('no body');
  const p = { width, gutterWidth: 6, glyphs: laneGlyphs('rounded'), frame: 0 };
  return paintBody(body, p, { expanded: true }).lines.map(rowText);
}

describe('opened read bodies keep indentation', () => {
  test('each file line starts at its own indent, tabs as spaces', () => {
    const rows = paintedRows(FILE, 100);
    const col = (needle: string): number => {
      const row = rows.find((r) => r.includes(needle));
      if (!row) throw new Error(`missing ${needle}`);
      return row.indexOf(needle);
    };
    const base = col('export async');
    expect(col('for (let i')).toBe(base + 2);
    expect(col('try {')).toBe(base + 4);
    expect(col('return await')).toBe(base + BODY_TAB_WIDTH);
    expect(col('} catch')).toBe(base + 4);
    expect(rows.some((r) => r.includes('\t'))).toBe(false);
  });

  test('command output keeps its indentation too', () => {
    const content = JSON.stringify({ exit_code: 0, stdout: 'tree\n  src\n    a.ts\n', stderr: '' });
    const rows = paintedRows(content, 100, 'exec');
    const base = rows.find((r) => r.includes('tree'))!.indexOf('tree');
    expect(rows.find((r) => r.includes('src'))!.indexOf('src')).toBe(base + 2);
    expect(rows.find((r) => r.includes('a.ts'))!.indexOf('a.ts')).toBe(base + 4);
  });

  test('every row is exactly the body width; a long indented line wraps under its own indent', () => {
    const long = `    const message = ${'"word '.repeat(30)}";`;
    const rows = paintedRows(long, 60);
    for (const row of rows) expect(getDisplayWidth(row)).toBe(60);
    const content = rows.filter((r) => r.trim().length > 0);
    expect(content.length).toBeGreaterThan(1);
    const first = content[0]!.indexOf('const message');
    for (const row of content.slice(1)) expect(row.search(/\S/)).toBe(first);
  });
});

describe('wrapPreservingIndent', () => {
  test('a line that fits comes back exactly, inner spacing included', () => {
    expect(wrapPreservingIndent('    a  =  1', 40)).toEqual(['    a  =  1']);
  });

  test('tabs expand to BODY_TAB_WIDTH spaces', () => {
    expect(wrapPreservingIndent('\t\tx', 40)).toEqual([`${' '.repeat(2 * BODY_TAB_WIDTH)}x`]);
  });

  test('wraps at spaces, continuation rows keep the indent, no row wider than the width', () => {
    const rows = wrapPreservingIndent('  alpha beta gamma delta epsilon zeta', 16);
    for (const row of rows) expect(getDisplayWidth(row)).toBeLessThanOrEqual(16);
    for (const row of rows) expect(row.startsWith('  ') && row[2] !== ' ').toBe(true);
    expect(rows.join(' ').replace(/\s+/g, ' ').trim()).toBe('alpha beta gamma delta epsilon zeta');
  });

  test('a word wider than the room is cut hard', () => {
    const rows = wrapPreservingIndent('x'.repeat(25), 10);
    expect(rows).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });
});
