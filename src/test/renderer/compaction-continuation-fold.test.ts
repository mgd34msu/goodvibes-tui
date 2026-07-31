import { describe, expect, test } from 'bun:test';
import {
  appendConversationMessages,
  type ConversationRenderContext,
} from '../../core/conversation-rendering.ts';
import { COMPACTION_HANDOFF_HEADER } from '@pellux/goodvibes-sdk/platform/core';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { lineToString } from '../setup.ts';

// ---------------------------------------------------------------------------
// Compaction-continuation folding. The compactor injects a user-ROLE message
// (handoff header + full re-injected instruction block) after every automatic
// compaction. Rendered in full it repeats a multi-kilobyte instruction wall
// every few messages in a long session — it must fold to a header + preview
// line by default, with the payload reachable via the normal expand toggle.
// ---------------------------------------------------------------------------

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

const continuationContent = [
  COMPACTION_HANDOFF_HEADER,
  '',
  '## Standing Instructions (re-injected)',
  ...Array.from({ length: 120 }, (_, i) => `- ALWAYS follow directive number ${i}`),
].join('\n');

describe('compaction-continuation user message folding', () => {
  test('folds to a compaction-handoff header instead of the full instruction wall', () => {
    const { context, lines } = makeContext();
    appendConversationMessages(
      context,
      [{ role: 'user', content: continuationContent }] as never,
      100,
      [],
    );
    const text = lines.map(lineToString).join('\n');
    expect(text).toContain('compaction handoff');
    expect(text).not.toContain('directive number 50');
    // Folded to header + preview + trailing blank, not 120+ content lines.
    expect(lines.length).toBeLessThan(10);
  });

  test('expanded state renders the full payload', () => {
    const { context, lines } = makeContext();
    context.collapseState.set('msg_0', false);
    appendConversationMessages(
      context,
      [{ role: 'user', content: continuationContent }] as never,
      100,
      [],
    );
    const text = lines.map(lineToString).join('\n');
    expect(text).toContain('directive number 50');
  });

  test('an ordinary user message still renders as a normal message bar', () => {
    const { context, lines } = makeContext();
    appendConversationMessages(
      context,
      [{ role: 'user', content: 'hello, please fix the login bug' }] as never,
      100,
      [],
    );
    const text = lines.map(lineToString).join('\n');
    expect(text).toContain('hello, please fix the login bug');
    expect(text).not.toContain('compaction handoff');
  });

  test('folded block registers for the expand toggle with the raw payload', () => {
    const { context } = makeContext();
    appendConversationMessages(
      context,
      [{ role: 'user', content: continuationContent }] as never,
      100,
      [],
    );
    expect(context.blockRegistry.length).toBe(1);
    expect(context.blockRegistry[0].collapseKey).toBe('msg_0');
    expect(context.blockRegistry[0].rawContent).toBe(continuationContent);
  });
});
