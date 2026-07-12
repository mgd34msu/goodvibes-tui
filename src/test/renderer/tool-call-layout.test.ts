import { describe, expect, test } from 'bun:test';
import { renderToolCallBlock } from '../../renderer/tool-call.ts';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { lineToString } from '../setup.ts';

describe('tool call layout', () => {
  test('tool-call rows keep a stable left margin without double-indenting', () => {
    const toolCall: ToolCall = {
      id: 'call_1',
      name: 'find',
      arguments: {
        pattern: 'find',
      },
    };

    const [line] = renderToolCallBlock(toolCall, 'done', undefined, 48);
    const text = lineToString(line);

    expect(text.indexOf('✓')).toBe(4);
    expect(text).toContain('find');
    expect(text.indexOf('find')).toBeLessThan(12);
  });

  test('tool-call rows prefer explicit query arguments instead of relying on fallback object order', () => {
    const toolCall: ToolCall = {
      id: 'call_2',
      name: 'web_search',
      arguments: {
        providerId: 'duckduckgo',
        query: 'dllm language model',
      },
    };

    const [line] = renderToolCallBlock(toolCall, 'done', undefined, 64);
    const text = lineToString(line);

    expect(text).toContain('web_search');
    expect(text).toContain('dllm language model');
    expect(text).not.toContain('duckduckgo');
  });

  test('tool-call rows keep tool name, summary, and duration readable on the same line', () => {
    const toolCall: ToolCall = {
      id: 'call_3',
      name: 'web_search',
      arguments: {
        query: 'dllm language model',
      },
    };

    const [line] = renderToolCallBlock(toolCall, 'done', '1 line', 72, 1200);
    const text = lineToString(line);

    expect(text).toContain('web_search');
    expect(text).toContain('dllm language model');
    expect(text).toContain('(1 line)');
    expect(text).toContain('1s');
  });

  test('executing tool shows static ellipsis when no startedAtMs provided', () => {
    const toolCall: ToolCall = {
      id: 'call_4',
      name: 'precision_read',
      arguments: { path: '/tmp/test.ts' },
    };

    const [line] = renderToolCallBlock(toolCall, 'executing', undefined, 72);
    const text = lineToString(line);

    expect(text).toContain('precision_read');
    expect(text).toContain('...');
  });

  test('executing tool shows elapsed time when startedAtMs is provided', () => {
    const toolCall: ToolCall = {
      id: 'call_5',
      name: 'precision_exec',
      arguments: { cmd: 'npm run build' },
    };

    // Simulate a tool that started 3.5 seconds ago
    const startedAtMs = Date.now() - 3500;
    const [line] = renderToolCallBlock(toolCall, 'executing', undefined, 72, undefined, undefined, 0, startedAtMs);
    const text = lineToString(line);

    expect(text).toContain('precision_exec');
    // Should show elapsed seconds (3s or 4s depending on timing)
    expect(text).toMatch(/\d+s/);
    // Should NOT show static ellipsis
    expect(text).not.toContain('...');
  });

  test('done tool uses formatElapsed for duration (sub-second)', () => {
    const toolCall: ToolCall = {
      id: 'call_6',
      name: 'find',
      arguments: { pattern: '*.ts' },
    };

    const [line] = renderToolCallBlock(toolCall, 'done', undefined, 72, 450);
    const text = lineToString(line);

    // 450ms → Math.floor(450/100)/10 = 0.4s via formatElapsed (truncates, not rounds)
    expect(text).toContain('0.4s');
  });

  test('done tool uses formatElapsed for duration (over 1 minute)', () => {
    const toolCall: ToolCall = {
      id: 'call_7',
      name: 'precision_exec',
      arguments: { cmd: 'bun test' },
    };

    const [line] = renderToolCallBlock(toolCall, 'done', undefined, 80, 64_200);
    const text = lineToString(line);

    // 64200ms = 1m04s via formatElapsed
    expect(text).toContain('1m04s');
  });

  // item 2c: a tool still awaiting a decision (approval) must not show the
  // completed green ✓ — it uses the hollow idle glyph until it actually runs.
  test('pending tool shows the idle glyph, not the completed check', () => {
    const toolCall: ToolCall = { id: 'call_p', name: 'write', arguments: { path: 'a.txt' } };
    const [line] = renderToolCallBlock(toolCall, 'pending', undefined, 72);
    const text = lineToString(line);
    expect(text).toContain('◌');
    expect(text).not.toContain('✓');
  });
});
