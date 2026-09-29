import { describe, expect, test } from 'bun:test';
import { MAX_LINES, ProcessOutputLog, isErrorLine, portOf } from '../../core/process-output-log.ts';

const rec = (stdout: string[], stderr: string[] = [], done = false) => ({ stdout, stderr, done });

describe('process output log', () => {
  test('each line is stamped with the time it was first seen; a partial line waits for its newline', () => {
    const log = new ProcessOutputLog();
    const out = ['ready in 412 ms\nLocal: http://localhost:5173/\npart'];
    log.poll(new Map([['p', rec(out)]]), 1000);
    expect(log.lines('p').map((l) => [l.at, l.text])).toEqual([[1000, 'ready in 412 ms'], [1000, 'Local: http://localhost:5173/']]);
    out.push('ial line\n');
    log.poll(new Map([['p', rec(out)]]), 2000);
    expect(log.lines('p').at(-1)).toMatchObject({ at: 2000, text: 'partial line' });
  });

  test('a finished process flushes its last partial line', () => {
    const log = new ProcessOutputLog();
    log.poll(new Map([['p', rec(['no newline'], [], true)]]), 5);
    expect(log.lines('p').map((l) => l.text)).toEqual(['no newline']);
  });

  test('errors are marked, colors and cursor codes are stripped, a carriage return keeps the redrawn text', () => {
    const log = new ProcessOutputLog();
    log.poll(new Map([['p', rec(['\x1b[32mok\x1b[0m\n', '10%\r50%\r100%\n'], ["error TS2345: bad\n"])]]), 1);
    const lines = log.lines('p');
    expect(lines.map((l) => l.text)).toEqual(['ok', '100%', 'error TS2345: bad']);
    expect(lines.map((l) => l.error)).toEqual([false, false, true]);
    expect(lines[2]!.stream).toBe('stderr');
  });

  test('the port comes from the first line that names one', () => {
    expect(portOf('  ➜  Local:   http://localhost:5173/')).toBe(5173);
    expect(portOf('Server listening on port 3000')).toBe(3000);
    expect(portOf('compiled 12 modules')).toBeUndefined();
    const log = new ProcessOutputLog();
    log.poll(new Map([['p', rec(['starting\nhttp://127.0.0.1:8080\nhttp://localhost:9000\n'])]]), 1);
    expect(log.port('p')).toBe(8080);
  });

  test('the log is bounded and counts what it dropped; an unlisted process is forgotten', () => {
    const log = new ProcessOutputLog();
    const chunk = Array.from({ length: MAX_LINES + 25 }, (_, i) => `line ${i}`).join('\n') + '\n';
    log.poll(new Map([['p', rec([chunk])]]), 1);
    expect(log.lines('p')).toHaveLength(MAX_LINES);
    expect(log.dropped('p')).toBe(25);
    expect(log.lines('p')[0]!.text).toBe('line 25');
    log.poll(new Map(), 2);
    expect(log.lines('p')).toHaveLength(0);
  });

  test('plain words that contain error-ish text are not all errors', () => {
    expect(isErrorLine('hmr update /src/api/client.ts')).toBe(false);
    expect(isErrorLine('Build failed with 2 errors')).toBe(true);
  });
});
