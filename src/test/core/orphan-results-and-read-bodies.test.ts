/**
 * Live run on 81da49b2 (abacusai route-llm, demo project):
 *
 * 1. Results stored without their call (from before compaction kept calls
 *    whole) drew the bare label "tool": `▸ tool  +3 −1`, `▸ tool  4 pass`.
 *    They are named from the result's shape when that is unambiguous, and
 *    "result" otherwise.
 * 2. An opened read showed only its file list (`src/net/retry.ts  22 lines`),
 *    repeating the row. It now shows the text the model read, like a command
 *    shows its output: indented exactly, syntax colored, clipped with
 *    "… N more lines" at the command-body limit; a multi-file read shows one
 *    short section per file headed by its path and line count.
 */
import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { activeTokens } from '../../renderer/theme.ts';
import { beadBody, inferResultToolName } from '../../renderer/lane-graph/bead.ts';
import { laneGlyphs } from '../../renderer/lane-graph/glyphs.ts';
import { paintBody, textColumn } from '../../renderer/lane-graph/paint.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { buildTurnModel, transcriptUnits, type BeadModel } from '../../core/work-tree-model.ts';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, arguments: args });
const rowText = (line: ReadonlyArray<{ char: string }>): string => line.map((c) => c.char || ' ').join('');

const EDIT = 'Applied 1 edit to src/net/retry.ts\n\n--- src/net/retry.ts\n+++ src/net/retry.ts\n@@ -9,3 +9,5 @@\n       lastError = err;\n-      await sleep(opts.baseDelayMs);\n+      if (i === opts.attempts - 1) break;\n+      const backoff = opts.baseDelayMs * 2 ** i;\n+      await sleep(backoff);\n';
const BUN_TEST = 'bun test v1.3.4\n\ntest/retry.test.ts:\n✓ withRetry > returns [0.41ms]\n\n 4 pass\n 0 fail\n 9 expect() calls\n';
const RETRY_LINES = [
  'export interface RetryOptions {',
  '  attempts: number;',
  '  baseDelayMs: number;',
  '}',
  '',
  'export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {',
  '  let lastError: unknown;',
  '  for (let i = 0; i < opts.attempts; i++) {',
  '    try {',
  '      return await fn();',
  '    } catch (err) {',
  '      lastError = err;',
  '      await sleep(opts.baseDelayMs);',
  '    }',
  '  }',
  '  throw lastError;',
  '}',
  '',
  'function sleep(ms: number): Promise<void> {',
  '  return new Promise((resolve) => setTimeout(resolve, ms));',
  '}',
  '',
];
/** The read tool's standard format: `NNNNN | text`. */
const numbered = (lines: readonly string[]): string => lines.map((l, i) => `${String(i + 1).padStart(5)} | ${l}`).join('\n');
const readJson = (files: ReadonlyArray<{ path: string; lines?: readonly string[]; error?: string }>): string => JSON.stringify({
  success: true,
  summary: { files_read: files.length, files_binary: 0, files_errored: 0, total_lines: files.reduce((n, f) => n + (f.lines?.length ?? 0), 0), total_tokens: 100 },
  files: files.map((f) => ({
    path: f.path,
    resolvedPath: `/demo/${f.path}`,
    lineCount: f.lines?.length ?? 0,
    byteSize: 10,
    tokenEstimate: 10,
    extract: 'content',
    ...(f.lines ? { content: numbered(f.lines) } : {}),
    ...(f.error ? { error: f.error } : {}),
  })),
});

describe('a result whose call is gone is named by its shape', () => {
  test('a unified diff or the edit report is an edit', () => {
    expect(inferResultToolName(EDIT)).toBe('edit');
    expect(inferResultToolName(JSON.stringify({ applied: 2, failed: 0, dry_run: false }))).toBe('edit');
    expect(inferResultToolName('Edits applied: 1, failed: 0')).toBe('edit');
  });

  test('test totals or command output are exec', () => {
    expect(inferResultToolName(BUN_TEST)).toBe('exec');
    expect(inferResultToolName(JSON.stringify({ exit_code: 0, stdout: 'ok\n', stderr: '' }))).toBe('exec');
  });

  test('line-numbered file text or a read summary is a read', () => {
    expect(inferResultToolName(numbered(RETRY_LINES.slice(0, 4)))).toBe('read');
    expect(inferResultToolName(readJson([{ path: 'src/net/retry.ts', lines: RETRY_LINES }]))).toBe('read');
  });

  test('anything else is an honest "result", never "tool"', () => {
    for (const content of ['Created schedule auto-1\n  status enabled', 'a\nb\nc', JSON.stringify({ ok: true }), 'src/a.ts:3: x\nsrc/b.ts:9: y', '']) {
      expect(inferResultToolName(content)).toBe('result');
    }
  });

  test('call-less rows in a transcript carry those names', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('fix the retry');
    cm.addAssistantMessage('working on it', { model: 'route-llm' });
    cm.addToolResults([
      { callId: 'lost-1', success: true, output: EDIT },
      { callId: 'lost-2', success: true, output: BUN_TEST },
      { callId: 'lost-3', success: true, output: 'Created schedule auto-1\n  status enabled' },
    ]);
    cm.addAssistantMessage('done', { model: 'route-llm' });
    const messages = cm.getMessageSnapshot();
    const unit = transcriptUnits(messages).filter((u) => u.kind === 'turn').pop();
    if (!unit || unit.kind !== 'turn') throw new Error('no turn');
    const model = buildTurnModel({ messages, offset: 0, unit, sources: { turnActive: () => false }, collapse: new Map(), streamingIndex: -1 });
    const beads = model.rows.flatMap((r): BeadModel[] => (r.kind === 'bead' ? [r.bead] : []));
    expect(beads.map((b) => [b.name, b.summary?.text])).toEqual([
      ['edit', '+3 −1'],
      ['exec', '4 pass'],
      ['result', 'Created schedule auto-1'],
    ]);
  });
});

function paint(content: string, args: Record<string, unknown>, width = 120, expanded = false) {
  const body = beadBody(call('read', args), 'ok', content);
  const p = { width, gutterWidth: 6, glyphs: laneGlyphs('rounded'), frame: 0 };
  return { body, p, painted: body ? paintBody(body, p, { expanded }) : null };
}

describe('an opened read shows the text the model read', () => {
  test('one file: its lines, indented exactly, no line-number prefix, no repeated file row', () => {
    const { body, p, painted } = paint(readJson([{ path: 'src/net/retry.ts', lines: RETRY_LINES.slice(0, 4) }]), { files: [{ path: 'src/net/retry.ts' }] });
    expect(body?.kind).toBe('read');
    const rows = painted!.lines.map(rowText);
    const x = textColumn(p) + 2;
    const at = (needle: string): number => rows.find((r) => r.includes(needle))!.indexOf(needle);
    expect(at('export interface RetryOptions {')).toBe(x);
    expect(at('attempts: number;')).toBe(x + 2);
    expect(rows.some((r) => /\d+ \|/.test(r))).toBe(false);
    expect(rows.some((r) => r.includes('22 lines') || r.includes('4 lines'))).toBe(false);
  });

  test('the text is syntax colored for the file language', () => {
    const { p, painted } = paint(readJson([{ path: 'src/net/retry.ts', lines: RETRY_LINES.slice(0, 4) }]), { files: [{ path: 'src/net/retry.ts' }] });
    const line = painted!.lines.find((l) => rowText(l).includes('export interface'))!;
    const x = textColumn(p) + 2;
    const colors = new Set(line.slice(x, x + 'export interface RetryOptions'.length).map((c) => c.fg));
    expect(colors.size).toBeGreaterThan(1);
    expect(line[x]!.fg).not.toBe(activeTokens().text);
  });

  test('clipped like a command body: 12 rows, then "… N more lines"; expanded shows all', () => {
    const { painted } = paint(readJson([{ path: 'src/net/retry.ts', lines: RETRY_LINES }]), { files: [{ path: 'src/net/retry.ts' }] });
    const rows = painted!.lines.map(rowText);
    expect(painted!.capped).toBe(true);
    expect(rows.some((r) => r.includes('… 9 more lines'))).toBe(true);
    // A padding row, 12 file rows (one of them the file's blank line), the "more" row, a padding row.
    expect(painted!.lines).toHaveLength(1 + 12 + 1 + 1);
    const full = paint(readJson([{ path: 'src/net/retry.ts', lines: RETRY_LINES }]), { files: [{ path: 'src/net/retry.ts' }] }, 120, true).painted!;
    expect(full.capped).toBe(false);
    expect(full.lines.map(rowText).some((r) => r.includes('return new Promise'))).toBe(true);
  });

  test('several files: one short section each, headed by path and line count', () => {
    const content = readJson([
      { path: 'src/net/retry.ts', lines: RETRY_LINES },
      { path: 'src/api/client.ts', lines: ['import { withRetry } from "../net/retry";', '', 'export const get = (url: string) => withRetry(() => fetch(url), { attempts: 3, baseDelayMs: 50 });'] },
      { path: 'src/missing.ts', error: 'File not found' },
    ]);
    const { body, painted } = paint(content, { files: [{ path: 'src/net/retry.ts' }, { path: 'src/api/client.ts' }, { path: 'src/missing.ts' }] });
    expect(body?.kind).toBe('read');
    const rows = painted!.lines.map(rowText);
    expect(rows.some((r) => /src\/net\/retry\.ts {2}22 lines/.test(r))).toBe(true);
    expect(rows.some((r) => /src\/api\/client\.ts {2}3 lines/.test(r))).toBe(true);
    expect(rows.some((r) => r.includes('src/missing.ts'))).toBe(true);
    expect(rows.some((r) => r.includes('File not found'))).toBe(true);
    // 12 rows shared across three files: four each, so retry.ts (21 rows once
    // its trailing blank line is dropped) shows 4 and hides 17.
    expect(rows.some((r) => r.includes('… 17 more lines'))).toBe(true);
    // An unreadable file's header states no line count.
    expect(rows.find((r) => r.includes('src/missing.ts'))!.trim()).toBe('src/missing.ts');
  });

  test('a read that returned no text for one file has no body: the row already says it', () => {
    const minimal = JSON.stringify({ success: true, summary: { files_read: 1, total_lines: 22 }, files: [{ path: 'src/net/retry.ts', lineCount: 22 }] });
    expect(beadBody(call('read', { files: [{ path: 'src/net/retry.ts' }] }), 'ok', minimal)).toBeNull();
  });

  test('a read whose result is the file text itself opens the same way', () => {
    const { body, p, painted } = paint(RETRY_LINES.slice(0, 4).join('\n'), { path: 'src/net/retry.ts' });
    expect(body?.kind).toBe('read');
    const rows = painted!.lines.map(rowText);
    expect(rows.find((r) => r.includes('attempts'))!.indexOf('attempts')).toBe(textColumn(p) + 4);
  });
});
