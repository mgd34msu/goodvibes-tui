import { describe, expect, test } from 'bun:test';
import {
  appendConversationMessages,
  collectCompletedToolCallIds,
  type ConversationRenderContext,
} from '../../core/conversation-rendering.ts';
import type { Line } from '../../types/grid.ts';
import { lineToString } from '../setup.ts';

function makeContext(): { context: ConversationRenderContext; lines: Line[] } {
  const lines: Line[] = [];
  const context: ConversationRenderContext = {
    history: {
      addLine: (line: Line) => { lines.push(line); },
      addLines: (ls: Line[]) => { for (const l of ls) lines.push(l); },
      getLineCount: () => lines.length,
    },
    blockRegistry: [],
    collapseState: new Map(),
    errorLineRegistry: [],
    messageKindRegistry: new Map(),
    configManager: null,
    splashOptions: {} as ConversationRenderContext['splashOptions'],
  };
  return { context, lines };
}

const render = (messages: unknown[]): string => {
  const { context, lines } = makeContext();
  appendConversationMessages(context, messages as never, 80, []);
  return lines.map(lineToString).join('\n');
};

describe('assistant tool-call pending glyph (UX-B item 2c)', () => {
  const assistantWithToolCall = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'write', arguments: { path: 'haiku.txt' } }],
  };

  test('a tool call with no result message shows the pending idle glyph, not ✓', () => {
    const text = render([assistantWithToolCall]);
    expect(text).toContain('◌');
    expect(text).not.toContain('✓');
  });

  test('once a matching tool result exists, the tool call shows the completed ✓', () => {
    const toolResult = { role: 'tool', callId: 'c1', content: '{"files_written":1,"bytes_written":10}', toolName: 'write' };
    const text = render([assistantWithToolCall, toolResult]);
    expect(text).toContain('✓');
    expect(text).not.toContain('◌');
  });

  test('a write tool result renders a human summary line instead of a raw JSON blob (item 3)', () => {
    const toolResult = {
      role: 'tool',
      callId: 'c1',
      content: '{"files_written":1,"bytes_written":532,"files":[{"path":"notes/haiku.txt"}]}',
      toolName: 'write',
    };
    const text = render([toolResult]);
    expect(text).toContain('wrote haiku.txt (532 B)');
    expect(text).not.toContain('bytes_written'); // raw payload is tucked behind the expand toggle
  });

  test('collectCompletedToolCallIds gathers ids from tool-result messages only', () => {
    const ids = collectCompletedToolCallIds([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', callId: 'c1', content: 'ok' },
    ] as never);
    expect(ids.has('c1')).toBe(true);
    expect(ids.size).toBe(1);
  });
});
