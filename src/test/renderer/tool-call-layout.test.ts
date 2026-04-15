import { describe, expect, test } from 'bun:test';
import { renderToolCallBlock } from '../../renderer/tool-call.ts';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types/tools';
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
    expect(text).toContain('1.2s');
  });
});
