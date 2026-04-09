import { describe, expect, test } from 'bun:test';
import { renderToolCallBlock } from '../../renderer/tool-call.ts';
import type { ToolCall } from '../../types/tools.ts';
import { lineToString } from '../setup.ts';

describe('tool call layout', () => {
  test('tool-call rows do not double-indent when normalized through the conversation row helper', () => {
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
});
