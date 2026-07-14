import { describe, expect, test } from 'bun:test';
import {
  appendConversationMessages,
  type ConversationRenderContext,
} from '../../core/conversation-rendering.ts';
import { renderToolCallBlock } from '../../renderer/tool-call.ts';
import { createCancelToolCall, type ToolCancelOrchestrator } from '../../core/turn-cancellation.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import type { Line } from '../../types/grid.ts';
import { lineToString } from '../setup.ts';

// ---------------------------------------------------------------------------
// STEP 2a — per-tool cancel. A key cancels JUST the running tool call via the
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

const blockText = (width: number): string =>
  renderToolCallBlock({ id: 'c1', name: 'exec', arguments: { command: 'sleep 100' } }, 'cancelled', undefined, width)
    .map(lineToString)
    .join('\n');

describe('renderToolCallBlock cancelled status (STEP 2a)', () => {
  test('renders the cancelled marker and blocked glyph at 80 columns', () => {
    const text = blockText(80);
    expect(text).toContain('cancelled');
    expect(text).toContain('⊘'); // GLYPHS.status.blocked
    expect(text).not.toContain('✓');
  });

  test('renders the cancelled marker and blocked glyph at 60 columns (concise, no clipping)', () => {
    const text = blockText(60);
    expect(text).toContain('cancelled');
    expect(text).toContain('⊘');
  });
});

describe('structural cancelled tool-result render (STEP 2a)', () => {
  test('a cancelled result renders as a "cancelled" block with the partial output preserved', () => {
    // The SDK settles a cancelled call as a tool result whose content leads
    // with "Error: cancelled by user"; any partial output follows.
    const toolResult = {
      role: 'tool',
      callId: 'c1',
      content: 'Error: cancelled by user\npartial-output-line-kept',
      toolName: 'exec',
    };
    const text = renderMessages([toolResult]);
    expect(text).toContain('cancelled');
    expect(text).toContain('⊘');
    // Not mislabelled as a plain "tool result".
    expect(text).not.toContain('tool result');
  });

  test('the partial output is reachable (expanded content carries the preserved bytes)', () => {
    const toolResult = {
      role: 'tool',
      callId: 'c1',
      content: 'Error: cancelled by user\nSENTINELPARTIAL1234',
      toolName: 'exec',
    };
    const { context, lines } = makeContext();
    // Force-expand so the full content renders (long content defaults collapsed).
    context.collapseState.set('msg_0', false);
    appendConversationMessages(context, [toolResult] as never, 80, []);
    const text = lines.map(lineToString).join('\n');
    expect(text).toContain('SENTINELPARTIAL1234');
  });

  test('a normal (non-cancelled) tool result still renders as "tool result"', () => {
    const toolResult = { role: 'tool', callId: 'c1', content: 'ok', toolName: 'read' };
    const text = renderMessages([toolResult]);
    expect(text).toContain('tool result');
    expect(text).not.toContain('⊘');
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
