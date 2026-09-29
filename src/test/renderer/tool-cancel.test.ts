import { describe, expect, test } from 'bun:test';
import {
  appendConversationMessages,
  type ConversationRenderContext,
} from '../../core/conversation-rendering.ts';
import { createCancelToolCall, type ToolCancelOrchestrator } from '../../core/turn-cancellation.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { lineToString } from '../setup.ts';

// ---------------------------------------------------------------------------
// STEP 2a, per-tool cancel. A key cancels JUST the running tool call via the
// in-process orchestrator (the local-session equivalent of the
// sessions.toolCalls.cancel wire verb); the cancelled result renders
// structurally ("cancelled by user", partial output preserved) and the turn
// visibly continues.
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

const renderMessages = (messages: unknown[], width = 80): string => {
  const { context, lines } = makeContext();
  appendConversationMessages(context, messages as never, width, []);
  return lines.map(lineToString).join('\n');
};

// A cancelled call, as the transcript holds it: the call, then the SDK's
// structured cancelled result with whatever partial output the tool produced.
const cancelledTurn = (partial: string): unknown[] => [
  { role: 'user', content: 'run it' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'exec', arguments: { command: 'sleep 100' } }] },
  { role: 'tool', callId: 'c1', content: `Error: cancelled by user\n${partial}`, toolName: 'exec' },
];

describe('a cancelled call in the work tree (STEP 2a)', () => {
  test('renders as a hollow ○ bead, struck through, with "cancelled" on its row, at 80 and 60 columns', () => {
    for (const width of [80, 60]) {
      const { context, lines } = makeContext();
      appendConversationMessages(context, cancelledTurn('partial') as never, width, []);
      const row = lines.find((l) => lineToString(l).includes('sleep 100'))!;
      const text = lineToString(row);
      expect(text).toContain('○');
      expect(text).toContain('cancelled');
      expect(text).not.toContain('✓');
      expect(row.find((c) => c.char === 's')!.strikethrough).toBe(true);
    }
  });

  test('the partial output is reachable in the bead\'s body', () => {
    const { context, lines } = makeContext();
    context.collapseState.set('bead_c:1:0', false);
    appendConversationMessages(context, cancelledTurn('SENTINELPARTIAL1234') as never, 80, []);
    expect(lines.map(lineToString).join('\n')).toContain('SENTINELPARTIAL1234');
  });

  test('a normal result is a ✓ bead, not a cancelled one', () => {
    const text = renderMessages([
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }] },
      { role: 'tool', callId: 'c1', content: 'ok', toolName: 'read' },
    ]);
    expect(text).toContain('✓');
    expect(text).not.toContain('○');
  });
});

describe('createCancelToolCall target selection (STEP 2a)', () => {
  function fakeOrch(running: string[]): { orch: ToolCancelOrchestrator; cancelled: string[] } {
    const cancelled: string[] = [];
    const orch: ToolCancelOrchestrator = {
      listRunningToolCalls: () => running,
      cancelToolCall: (id: string) => { cancelled.push(id); return true; },
    };
    return { orch, cancelled };
  }

  test('cancels the tracked active callId when known', () => {
    const { orch, cancelled } = fakeOrch(['a', 'b']);
    const notified: string[] = [];
    const cancel = createCancelToolCall(orch, () => 'b', (id) => notified.push(id));
    expect(cancel()).toBe(true);
    expect(cancelled).toEqual(['b']);
    expect(notified).toEqual(['b']);
  });

  test('falls back to the sole in-flight call when no active id is tracked', () => {
    const { orch, cancelled } = fakeOrch(['only']);
    const cancel = createCancelToolCall(orch, () => undefined, () => {});
    expect(cancel()).toBe(true);
    expect(cancelled).toEqual(['only']);
  });

  test('does nothing (never guesses) when several are running and none is tracked', () => {
    const { orch, cancelled } = fakeOrch(['a', 'b']);
    const notified: string[] = [];
    const cancel = createCancelToolCall(orch, () => undefined, (id) => notified.push(id));
    expect(cancel()).toBe(false);
    expect(cancelled).toEqual([]);
    expect(notified).toEqual([]);
  });

  test('does nothing when nothing is running', () => {
    const { orch, cancelled } = fakeOrch([]);
    const cancel = createCancelToolCall(orch, () => undefined, () => {});
    expect(cancel()).toBe(false);
    expect(cancelled).toEqual([]);
  });

  test('onCancelled does not fire when the orchestrator reports no such running call', () => {
    const notified: string[] = [];
    const orch: ToolCancelOrchestrator = {
      listRunningToolCalls: () => ['x'],
      cancelToolCall: () => false, // settled/gone between list and cancel
    };
    const cancel = createCancelToolCall(orch, () => 'x', (id) => notified.push(id));
    expect(cancel()).toBe(false);
    expect(notified).toEqual([]);
  });
});

describe('cancel-tool-call keybinding (STEP 2a)', () => {
  test('Alt+C resolves to the cancel-tool-call action by default', () => {
    const kb = new KeybindingsManager({ configPath: '/nonexistent/keybindings.json' });
    const action = kb.lookup({ logicalName: 'c', ctrl: false, shift: false, alt: true } as never);
    expect(action).toBe('cancel-tool-call');
  });
});
