import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import {
  beadArgument,
  beadBody,
  beadName,
  beadStatus,
  beadSummary,
  formatBeadTime,
  isBackgroundCall,
  needsAttention,
  type BeadStatusInput,
} from '../../renderer/lane-graph/bead.ts';
import { laneGlyphs } from '../../renderer/lane-graph/glyphs.ts';
import { laneColor, paintBeadRow, textColumn } from '../../renderer/lane-graph/paint.ts';

/** The spec's columns: the time ends at width−4, the summary 9 columns left of it. */
const timeEnd = (width: number): number => width - 4;
const SUMMARY_GAP = 9;

/** The diff an edit opens to (the body's own diff text). */
function editDiff(c: ToolCall, content: string): { text: string; numbered: boolean; path: string | undefined } | null {
  const body = beadBody(c, 'ok', content);
  return body?.kind === 'diff' ? { text: body.diff, numbered: body.numbered, path: body.path } : null;
}
import { activeTokens } from '../../renderer/theme.ts';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, arguments: args });
const base: BeadStatusInput = { outcome: 'ok', waiting: false, ownerActive: true, background: false, attention: false };

describe('bead status mapping', () => {
  test('✓ done, ! done with something to look at, ✕ failed', () => {
    expect(beadStatus(base)).toBe('ok');
    expect(beadStatus({ ...base, attention: true })).toBe('warn');
    expect(beadStatus({ ...base, outcome: 'error' })).toBe('err');
  });

  test('○ cancelled, ▶ backgrounded', () => {
    expect(beadStatus({ ...base, outcome: 'cancelled' })).toBe('cancel');
    expect(beadStatus({ ...base, background: true })).toBe('bg');
  });

  test('◐ running while its owner works, ● waiting while a prompt holds it', () => {
    expect(beadStatus({ ...base, outcome: undefined })).toBe('run');
    expect(beadStatus({ ...base, outcome: undefined, waiting: true })).toBe('wait');
  });

  test('an unsettled call whose owner stopped reads as cancelled, never spinning forever', () => {
    expect(beadStatus({ ...base, outcome: undefined, ownerActive: false })).toBe('cancel');
  });

  test('attention: a non-zero exit, a timed-out command, an edit with failed items', () => {
    expect(needsAttention(call('exec'), JSON.stringify({ exit_code: 1, stdout: '' }))).toBe(true);
    expect(needsAttention(call('exec'), JSON.stringify({ exit_code: 0, stdout: 'ok' }))).toBe(false);
    expect(needsAttention(call('exec'), JSON.stringify({ commands: [{ exit_code: 0 }, { timed_out: true }] }))).toBe(true);
    expect(needsAttention(call('edit'), JSON.stringify({ applied: 1, failed: 1 }))).toBe(true);
    expect(needsAttention(call('edit'), 'Edits applied: 2, failed: 0')).toBe(false);
  });

  test('a background call is recognised from its arguments', () => {
    expect(isBackgroundCall(call('exec', { command: 'bun run dev', background: true }))).toBe(true);
    expect(isBackgroundCall(call('exec', { commands: [{ cmd: 'a', background: true }] }))).toBe(true);
    expect(isBackgroundCall(call('exec', { command: 'bun test' }))).toBe(false);
  });

  test('each status draws its own mark and color on the row', () => {
    const glyphs = laneGlyphs('rounded');
    const t = activeTokens();
    const p = { width: 100, gutterWidth: 6, glyphs, frame: 1 };
    const cases: Array<[Parameters<typeof paintBeadRow>[1]['status'], string, string]> = [
      ['ok', '✓', t.success], ['warn', '!', t.warning], ['err', '✕', t.error], ['run', '◓', laneColor(0)],
      ['wait', '●', t.warning], ['cancel', '○', t.textFaint], ['bg', '▶', t.success],
    ];
    for (const [status, mark, fg] of cases) {
      const line = paintBeadRow([{ role: 'bead', color: 0 }], { status, name: 'exec', arg: 'x', summary: null, time: undefined, laneColor: '#123456', hasBody: false, open: false }, p);
      expect(line[3]!.char).toBe(mark);
      expect(line[3]!.fg).toBe(fg);
    }
  });
});

describe('bead row geometry', () => {
  test('▸ two columns left of the text column; summary ends 9 left of the time; time ends at width-4', () => {
    const p = { width: 100, gutterWidth: 6, glyphs: laneGlyphs('rounded'), frame: 0 };
    const line = paintBeadRow([{ role: 'bead', color: 0 }], { status: 'ok', name: 'read', arg: 'src/a.ts', summary: { text: '20 lines', tone: 'faint' }, time: '0.2s', laneColor: '#ffffff', hasBody: true, open: false }, p);
    const text = line.map((c) => c.char || ' ').join('');
    expect(textColumn(p)).toBe(9);
    expect(text[7]).toBe('▸');
    expect(text.slice(9, 22)).toBe('read src/a.ts');
    expect(text.slice(timeEnd(100) - 3, timeEnd(100) + 1)).toBe('0.2s');
    expect(text.slice(timeEnd(100) - SUMMARY_GAP - 7, timeEnd(100) - SUMMARY_GAP + 1)).toBe('20 lines');
    expect(text.slice(timeEnd(100) + 1).trim()).toBe('');
  });

  test('no triangle when the bead has nothing inside; ▾ when open', () => {
    const p = { width: 80, gutterWidth: 6, glyphs: laneGlyphs('rounded'), frame: 0 };
    const closedEmpty = paintBeadRow([{ role: 'bead', color: 0 }], { status: 'ok', name: 'x', arg: '', summary: null, time: undefined, laneColor: '#fff', hasBody: false, open: false }, p);
    const open = paintBeadRow([{ role: 'bead', color: 0 }], { status: 'ok', name: 'x', arg: '', summary: null, time: undefined, laneColor: '#fff', hasBody: true, open: true }, p);
    expect(closedEmpty[7]!.char).toBe(' ');
    expect(open[7]!.char).toBe('▾');
  });

  test('a cancelled row is struck through', () => {
    const p = { width: 80, gutterWidth: 6, glyphs: laneGlyphs('rounded'), frame: 0 };
    const line = paintBeadRow([{ role: 'bead', color: 0 }], { status: 'cancel', name: 'exec', arg: 'bun test --watch', summary: { text: 'cancelled', tone: 'faint' }, time: undefined, laneColor: '#fff', hasBody: false, open: false }, p);
    expect(line[9]!.strikethrough).toBe(true);
    expect(line[14]!.strikethrough).toBe(true);
  });
});

describe('bead summaries', () => {
  test('read, find, edit, write, exec', () => {
    expect(beadSummary(call('read'), 'ok', JSON.stringify({ summary: { files_read: 1, total_lines: 20 } }))?.text).toBe('20 lines');
    expect(beadSummary(call('find'), 'ok', JSON.stringify({ q1: { matches: [{ file: 'a', line: 1, text: 'x' }, { file: 'b', line: 2, text: 'y' }, { file: 'c', line: 3, text: 'z' }], count: 3 } }))?.text).toBe('3 matches in 3 files');
    expect(beadSummary(call('edit', { edits: [{ path: 'a.ts', find: 'a\nb', replace: 'a\nc\nd' }] }), 'ok', 'Edits applied: 1, failed: 0')).toEqual({ text: '+2 −1', tone: 'good' });
    expect(beadSummary(call('write', { files: [{ path: 'docs/x.md', content: 'a\nb\nc' }] }), 'ok', '{"files_written":1}')).toEqual({ text: '+3', tone: 'good' });
    expect(beadSummary(call('exec', { command: 'bun test' }), 'ok', JSON.stringify({ exit_code: 0, stdout: ' 4 pass\n 0 fail' }))?.text).toBe('4 pass · exit 0');
    expect(beadSummary(call('exec'), 'warn', JSON.stringify({ exit_code: 2, stdout: '' }))).toEqual({ text: 'exit 2', tone: 'warn' });
  });

  test('failed, waiting, cancelled and running rows', () => {
    expect(beadSummary(call('exec'), 'err', 'Error: exit code 1\n2 failing')).toEqual({ text: '2 failing', tone: 'bad' });
    expect(beadSummary(call('exec'), 'err', 'Error: exit code 1\nboom')).toEqual({ text: 'exit 1', tone: 'bad' });
    expect(beadSummary(call('exec'), 'wait', undefined)).toEqual({ text: 'waiting for you', tone: 'warn' });
    expect(beadSummary(call('exec'), 'cancel', undefined)?.text).toBe('cancelled');
    expect(beadSummary(call('exec'), 'run', undefined)).toBeNull();
  });

  test('a background process names its port when it printed one', () => {
    expect(beadSummary(call('exec', { background: true }), 'bg', JSON.stringify({ pid: 48213, note: 'http://localhost:5173' }))?.text).toBe('in background · :5173');
    expect(beadSummary(call('exec', { background: true }), 'bg', JSON.stringify({ pid: 48213 }))?.text).toBe('in background · pid 48213');
  });

  test('bead times: 0.2s, 1.4s, 38s, 2m 14s, 1h 02m', () => {
    expect([200, 1400, 38_000, 134_000, 3_720_000].map(formatBeadTime)).toEqual(['0.2s', '1.4s', '38s', '2m 14s', '1h 02m']);
  });
});

describe('bead bodies are never JSON', () => {
  test('an exec opens to its terminal output with the exit line', () => {
    const body = beadBody(call('exec'), 'ok', JSON.stringify({ exit_code: 0, stdout: 'line one\nline two\n', stderr: '' }));
    expect(body).toEqual({ kind: 'output', lines: [{ text: 'line one', tone: 'text' }, { text: 'line two', tone: 'text' }], footer: 'exit 0' });
  });

  test('a read opens to the text it read; finds open to short lists', () => {
    // Owner ruling (live run on 81da49b2): an opened read shows the text the
    // model read, not a file list that repeats the row.
    expect(beadBody(call('read'), 'ok', JSON.stringify({ summary: {}, files: [{ path: 'a.ts', lineCount: 2, content: '    1 | const a = 1;\n    2 |   return a;' }] })))
      .toEqual({ kind: 'read', files: [{ path: 'a.ts', lineCount: 2, lines: ['const a = 1;', '  return a;'] }] });
    // Without text: several files still list their counts; one file would only repeat its row.
    expect(beadBody(call('read'), 'ok', JSON.stringify({ summary: {}, files: [{ path: 'a.ts', lineCount: 20 }, { path: 'b.ts', lineCount: 5 }] })))
      .toEqual({ kind: 'list', items: [{ text: 'a.ts', detail: '20 lines' }, { text: 'b.ts', detail: '5 lines' }] });
    expect(beadBody(call('read'), 'ok', JSON.stringify({ summary: {}, files: [{ path: 'a.ts', lineCount: 20 }] }))).toBeNull();
    expect(beadBody(call('find'), 'ok', JSON.stringify({ q1: { matches: [{ file: 'a.ts', line: 4, text: '  export x' }] } }))).toEqual({ kind: 'list', items: [{ text: 'a.ts:4', detail: 'export x' }] });
  });

  test('an unknown object result opens flattened, never as braces', () => {
    const body = beadBody(call('custom'), 'ok', JSON.stringify({ status: 'ok', nested: { count: 3 }, list: ['a', 'b'] }));
    expect(body?.kind).toBe('text');
    const text = body?.kind === 'text' ? body.lines.join('\n') : '';
    expect(text).not.toContain('{');
    expect(text).toContain('status  ok');
    expect(text).toContain('nested.count  3');
  });

  test('a failure opens to its full error text', () => {
    expect(beadBody(call('exec'), 'err', 'Error: exit code 1\nerror TS2345: long message')).toEqual({ kind: 'error', text: 'exit code 1\nerror TS2345: long message' });
  });

  test('a bead with nothing inside has no body', () => {
    expect(beadBody(call('exec'), 'run', undefined)).toBeNull();
    expect(beadBody(call('custom'), 'ok', '')).toBeNull();
  });
});

describe('edit diffs', () => {
  test('the edit tool\'s own unified diff keeps its line numbers, without the tool\'s banner lines', () => {
    const content = ['Edits applied: 1, failed: 0', '', '--- src/a.ts (1 replacement(s)) ---', 'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -3,1 +3,1 @@', '-old', '+new'].join('\n');
    const diff = editDiff(call('edit'), content);
    expect(diff?.numbered).toBe(true);
    expect(diff?.path).toBe('src/a.ts');
    expect(diff?.text.startsWith('diff --git')).toBe(true);
    expect(diff?.text).not.toContain('replacement(s)');
  });

  test('without a diff in the result, the call\'s find/replace becomes a hunk with unknown line numbers', () => {
    const diff = editDiff(call('edit', { edits: [{ path: 'a.ts', find: 'keep\nold', replace: 'keep\nnew' }] }), '{"applied":1,"failed":0}');
    expect(diff?.numbered).toBe(false);
    expect(diff?.text).toContain(' keep\n-old\n+new');
  });
});

describe('terminal control sequences never reach the row', () => {
  test('names and arguments are sanitized', () => {
    const arg = beadArgument(call('exec', { command: 'echo \u001b[2J\u001b[Hhi \u001b]0;title\u0007there' }));
    expect(arg).not.toMatch(/\u001b|\u0007/);
    expect(beadName(call('mcp__srv__do\u001b[31mit'))).not.toContain('\u001b');
  });

  test('the key argument of an edit is its path', () => {
    expect(beadArgument(call('edit', { edits: [{ path: 'src/a.ts', find: 'a', replace: 'b' }] }))).toBe('src/a.ts');
    expect(beadArgument(call('edit', { edits: [{ path: 'a.ts', find: 'a', replace: 'b' }, { path: 'b.ts', find: 'a', replace: 'b' }] }))).toBe('a.ts +1 more');
  });
});
