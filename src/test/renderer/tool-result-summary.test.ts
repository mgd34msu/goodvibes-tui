import { describe, expect, test } from 'bun:test';
import { summarizeToolResult } from '../../renderer/tool-result-summary.ts';

describe('summarizeToolResult (item 3)', () => {
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

  test('exec — a run outside the sandbox (no sandboxed field) stays quiet', () => {
    const content = JSON.stringify({ exit_code: 0, duration_ms: 10, stdout: '' });
    expect(summarizeToolResult('exec', content)).toBe('exit 0 · 10ms');
  });

  test('exec — a boundary-safe sandboxed run reports net state', () => {
    const content = JSON.stringify({ exit_code: 0, duration_ms: 10, stdout: '', sandboxed: true, sandbox_network: 'disabled' });
    expect(summarizeToolResult('exec', content)).toBe('exit 0 · 10ms · sandboxed (net disabled)');
  });

  test('exec — a sandboxed run with a granted escalation reports the count', () => {
    const content = JSON.stringify({
      exit_code: 0,
      duration_ms: 10,
      stdout: '',
      sandboxed: true,
      sandbox_network: 'enabled',
      sandbox_escalations: ['network (command on egress allowlist)'],
    });
    expect(summarizeToolResult('exec', content)).toBe('exit 0 · 10ms · sandboxed (net enabled, +1 escalation)');
  });

  test('exec — requested-but-unavailable sandbox is reported honestly, not silently', () => {
    const content = JSON.stringify({ exit_code: 0, duration_ms: 10, stdout: '', sandboxed: false, sandbox_boundary: 'bubblewrap not found on PATH' });
    expect(summarizeToolResult('exec', content)).toBe('exit 0 · 10ms · sandbox unavailable (bubblewrap not found on PATH)');
  });

  test('exec — multiple commands count how many ran sandboxed', () => {
    const content = JSON.stringify({
      total: 2,
      commands: [
        { success: true, sandboxed: true },
        { success: true, sandboxed: false },
      ],
    });
    expect(summarizeToolResult('exec', content)).toBe('2 commands · all ok · 1 sandboxed');
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

  test('agent status/get/wait — a child-failure envelope is rendered compactly', () => {
    const content = JSON.stringify({
      status: 'failed',
      failure: {
        agentId: 'agent-42',
        phase: 'running',
        reason: { code: 'watchdog_timeout', message: 'No progress for 300s' },
        partialOutputs: { turnsCompleted: 3 },
      },
    });
    expect(summarizeToolResult('agent', content)).toBe('agent agent-42 failed [watchdog_timeout] at running: No progress for 300s (3 turns completed)');
  });

  test('agent status/get/wait — a long failure message is truncated', () => {
    const longMessage = 'x'.repeat(200);
    const content = JSON.stringify({
      failure: { agentId: 'a1', phase: 'planning', reason: { code: 'error', message: longMessage } },
    });
    const summary = summarizeToolResult('agent', content);
    expect(summary).toContain('agent a1 failed [error] at planning:');
    expect(summary!.length).toBeLessThan(150);
  });

  test('agent status/get/wait — no failure field means no summary (caller falls back to raw preview)', () => {
    expect(summarizeToolResult('agent', JSON.stringify({ status: 'completed', agentId: 'a1' }))).toBeNull();
  });
});
