/**
 * A tool row's result column says what happened (42 lines, 3 matches, +5 −2)
 * whatever shape the stored result has, and a compaction keeps the calls the
 * rows are built from.
 *
 * Live run on 14d4e369 (resumed "Fix retry backoff" session): the resumed
 * turn's results were stored as text (the file itself, grep lines, bun test
 * output), and the rows showed each result's raw first line. Then the
 * small-window auto-compaction rebuilt the transcript without any assistant
 * tool calls, so every kept result became a call-less row (no argument, no
 * summary from its call) and the turn header lost its model.
 */
import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { beadSummary } from '../../renderer/lane-graph/bead.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { buildTurnModel, transcriptUnits, type BeadModel } from '../../core/work-tree-model.ts';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, arguments: args });

const RETRY_TS = 'export interface RetryOptions {\n  attempts: number;\n  baseDelayMs: number;\n}\n';
const GREP = 'src/net/retry.ts:6: export async function withRetry<T>(\nsrc/api/client.ts:14:   return withRetry(() => fetchJson(url));\nsrc/api/upload.ts:31:   await withRetry(send);';
const BUN_TEST = 'bun test v1.3.4\n\ntest/retry.test.ts:\n✓ withRetry > returns [0.41ms]\n\n 4 pass\n 0 fail\n 9 expect() calls\n';
const EDIT = 'Applied 1 edit to src/net/retry.ts\n\n--- src/net/retry.ts\n+++ src/net/retry.ts\n@@ -9,3 +9,5 @@\n       lastError = err;\n-      await sleep(opts.baseDelayMs);\n+      if (i === opts.attempts - 1) break;\n+      const backoff = opts.baseDelayMs * 2 ** i;\n+      await sleep(backoff);\n';

describe('text results summarize like structured ones', () => {
  test('a read of file text says how many lines, never the first line', () => {
    expect(beadSummary(call('read', { files: [{ path: 'src/net/retry.ts' }] }), 'ok', RETRY_TS)?.text).toBe('4 lines');
    expect(beadSummary(call('read', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] }), 'ok', RETRY_TS)?.text).toBe('2 files · 4 lines');
  });

  test('grep-style find text counts matches and files', () => {
    expect(beadSummary(call('find', { pattern: 'withRetry' }), 'ok', GREP)?.text).toBe('3 matches in 3 files');
    expect(beadSummary(call('find'), 'ok', 'src/a.ts\nsrc/b.ts\n')?.text).toBe('2 files');
  });

  test('bare command output reads as its test totals, or how much it printed', () => {
    expect(beadSummary(call('exec', { command: 'bun test' }), 'ok', BUN_TEST)?.text).toBe('4 pass');
    expect(beadSummary(call('exec', { command: 'ls' }), 'ok', 'a\nb\nc\n')?.text).toBe('3 lines of output');
  });

  test('a result whose call is unknown still reads by its shape', () => {
    expect(beadSummary(call('tool'), 'ok', EDIT)?.text).toBe('+3 −1');
    expect(beadSummary(call('tool'), 'ok', BUN_TEST)?.text).toBe('4 pass');
    expect(beadSummary(call('tool'), 'ok', GREP)?.text).toBe('3 matches in 3 files');
    // A one-line or unrecognized result keeps its own first line.
    expect(beadSummary(call('tool'), 'ok', 'Created schedule auto-1\n  status enabled')?.text).toBe('Created schedule auto-1');
  });
});

function turnBeads(messages: readonly ConversationMessageSnapshot[]): { beads: BeadModel[]; header: string } {
  const unit = transcriptUnits(messages).filter((u) => u.kind === 'turn').pop();
  if (!unit || unit.kind !== 'turn') throw new Error('no turn');
  const model = buildTurnModel({ messages, offset: 0, unit, sources: { turnActive: () => false }, collapse: new Map(), streamingIndex: -1 });
  return { beads: model.rows.flatMap((r) => (r.kind === 'bead' ? [r.bead] : [])), header: model.headerText };
}

describe('a compaction keeps the kept messages whole', () => {
  function conversationWithTurns(): ConversationManager {
    const cm = new ConversationManager(() => 100);
    for (let k = 0; k < 3; k++) {
      cm.addUserMessage(`question ${k}`);
      cm.addAssistantMessage('', { toolCalls: [{ id: `r${k}`, name: 'read', arguments: { files: [{ path: `src/f${k}.ts` }] } }], model: 'route-llm', reasoningContent: 'thinking' });
      cm.addToolResults([{ callId: `r${k}`, success: true, output: JSON.stringify({ success: true, summary: { files_read: 1, total_lines: 10 + k } }) }]);
      cm.addAssistantMessage(`answer ${k}`, { model: 'route-llm' });
    }
    return cm;
  }

  test('small-window keep-last-N keeps tool calls, model and reasoning on the transcript', () => {
    const cm = conversationWithTurns();
    const llm = cm.getMessagesForLLM();
    // What compactSmallWindow hands over: a summary pair plus the last N provider messages as they were.
    cm.replaceMessagesForLLM([
      { role: 'user', content: '[Context compacted, small window mode, 8 messages summarized]' },
      { role: 'assistant', content: '[8 earlier messages omitted.]' },
      ...llm.slice(-4),
    ]);
    const snapshot = cm.getMessageSnapshot();
    const { beads, header } = turnBeads(snapshot);
    expect(beads).toHaveLength(1);
    expect(beads[0]!.call.name).toBe('read');
    expect(beads[0]!.arg).toBe('src/f2.ts');
    expect(beads[0]!.summary?.text).toBe('12 lines');
    expect(header.startsWith('route-llm')).toBe(true);
    const asst = snapshot.find((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0);
    expect(asst?.role === 'assistant' ? asst.reasoningContent : undefined).toBe('thinking');
  });

  test('the next request still pairs every kept result with its call', () => {
    const cm = conversationWithTurns();
    cm.replaceMessagesForLLM(cm.getMessagesForLLM().slice(-4));
    const after = cm.getMessagesForLLM();
    const calls = new Set(after.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [])));
    for (const m of after) if (m.role === 'tool') expect(calls.has(m.callId)).toBe(true);
  });

  test('provider messages the compaction wrote itself keep their tool calls too', () => {
    const cm = conversationWithTurns();
    cm.replaceMessagesForLLM([
      { role: 'user', content: 'summary' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x1', name: 'read', arguments: { path: 'z.ts' } }] },
      { role: 'tool', callId: 'x1', content: 'a\nb\n', name: 'read' },
    ]);
    const { beads } = turnBeads(cm.getMessageSnapshot());
    expect(beads[0]!.arg).toBe('z.ts');
    expect(beads[0]!.summary?.text).toBe('2 lines');
  });

  test('system messages and the title survive the replace', () => {
    const cm = conversationWithTurns();
    cm.title = 'Fix retry backoff';
    cm.addSystemMessage('note');
    cm.replaceMessagesForLLM(cm.getMessagesForLLM().slice(-4));
    expect(cm.title).toBe('Fix retry backoff');
    expect(cm.getMessageSnapshot().filter((m) => m.role === 'system').map((m) => m.content)).toEqual(['note']);
  });
});
