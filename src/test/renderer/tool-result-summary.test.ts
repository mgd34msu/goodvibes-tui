import { describe, expect, test } from 'bun:test';
import { summarizeToolResult } from '../../renderer/tool-result-summary.ts';

describe('summarizeToolResult (UX-B item 3)', () => {
  test('write — single file names the file and its byte size', () => {
    const content = JSON.stringify({
      files_written: 1,
      bytes_written: 532,
      files: [{ path: 'poems/haiku.txt', resolved_path: '/abs/poems/haiku.txt', bytes_written: 532 }],
    });
    expect(summarizeToolResult('write', content)).toBe('wrote haiku.txt (532 B)');
  });

  test('write — count_only (no files array) still summarises', () => {
    expect(summarizeToolResult('write', JSON.stringify({ files_written: 1, bytes_written: 87 }))).toBe('wrote 1 file (87 B)');
  });

  test('write — multiple files reports the count and total', () => {
    const content = JSON.stringify({ files_written: 3, bytes_written: 4096, files: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] });
    expect(summarizeToolResult('write', content)).toBe('wrote 3 files (4.0 KB)');
  });

  test('read — single file names the file and line count', () => {
    const content = JSON.stringify({
      success: true,
      summary: { files_read: 1, total_lines: 120 },
      files: [{ path: 'src/foo.py', lineCount: 120 }],
    });
    expect(summarizeToolResult('read', content)).toBe('read foo.py (120 lines)');
  });

  test('exec — single command reports exit, duration and stdout lines', () => {
    const content = JSON.stringify({ cmd: 'ls', exit_code: 0, stdout: 'a\nb\nc', duration_ms: 1200, success: true });
    expect(summarizeToolResult('exec', content)).toBe('exit 0 · 1.2s · 3 lines');
  });

  test('exec — a timeout is summarised honestly', () => {
    const content = JSON.stringify({ cmd: 'sleep 99', exit_code: null, stdout: '', timed_out: true, duration_ms: 30000 });
    expect(summarizeToolResult('exec', content)).toBe('timed out · 30.0s');
  });

  test('exec — multiple commands report the count and failures', () => {
    const content = JSON.stringify({ commands: [{ success: true }, { success: false }], total: 2 });
    expect(summarizeToolResult('exec', content)).toBe('2 commands · 1 failed');
  });

  test('exec — a clean scrub (no withheld_env) stays quiet', () => {
    const content = JSON.stringify({ cmd: 'ls', exit_code: 0, stdout: 'a', duration_ms: 10, success: true });
    expect(summarizeToolResult('exec', content)).toBe('exit 0 · 10ms · 1 line');
  });

  test('exec — withheld_env names are rendered compactly', () => {
    const content = JSON.stringify({
      cmd: 'env',
      exit_code: 0,
      stdout: '',
      duration_ms: 10,
      success: true,
      withheld_env: ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN'],
    });
    expect(summarizeToolResult('exec', content)).toBe('exit 0 · 10ms · withheld: AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN');
  });

  test('exec — withheld_env caps the shown names and counts the rest', () => {
    const content = JSON.stringify({
      cmd: 'env',
      exit_code: 0,
      stdout: '',
      duration_ms: 10,
      success: true,
      withheld_env: ['A_TOKEN', 'B_TOKEN', 'C_TOKEN', 'D_TOKEN', 'E_TOKEN'],
    });
    expect(summarizeToolResult('exec', content)).toBe('exit 0 · 10ms · withheld: A_TOKEN, B_TOKEN, C_TOKEN, +2 more');
  });

  test('exec — multiple commands union withheld names across the batch', () => {
    const content = JSON.stringify({
      total: 2,
      commands: [
        { success: true, withheld_env: ['AWS_SECRET_ACCESS_KEY'] },
        { success: true, withheld_env: ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'] },
      ],
    });
    expect(summarizeToolResult('exec', content)).toBe('2 commands · all ok · withheld: AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN');
  });

  test('edit — reports edits applied and target', () => {
    expect(summarizeToolResult('edit', JSON.stringify({ applied: 2, failed: 0, path: 'src/x.ts' }))).toBe('applied 2 edits to x.ts');
  });

  test('mcp server__tool names are reduced to the family before matching', () => {
    const content = JSON.stringify({ files_written: 1, bytes_written: 10, files: [{ path: 'z.txt' }] });
    expect(summarizeToolResult('server__write', content)).toBe('wrote z.txt (10 B)');
  });

  test('unrecognised tool or non-JSON returns null (caller falls back)', () => {
    expect(summarizeToolResult('unknown', '{"a":1}')).toBeNull();
    expect(summarizeToolResult('write', 'not json')).toBeNull();
    expect(summarizeToolResult(undefined, '{}')).toBeNull();
  });
});
