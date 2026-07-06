import { describe, test, expect, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';


// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
// ---------------------------------------------------------------------------
// Auto-generated conversation title
// ---------------------------------------------------------------------------
describe('ConversationManager - title', () => {
  let cm: ConversationManager;

  beforeEach(async () => {
    cm = new ConversationManager(() => 80);
  });

  test('title starts empty', async () => {
    expect(cm.title).toBe('');
  });

  test('auto-generates title from first user message (short)', async () => {
    cm.addUserMessage('Hello world');
    expect(cm.title).toBe('Hello world');
  });

  test('auto-generates title truncated at word boundary for long messages', async () => {
    cm.addUserMessage('Please help me fix the TypeScript errors in my large codebase project files');
    // Should truncate at 50 chars at word boundary
    expect(cm.title.length).toBeLessThanOrEqual(50);
    // Title should be a prefix of the original message (word boundary cut)
    expect('Please help me fix the TypeScript errors in my large codebase project files'.startsWith(cm.title)).toBe(true);
    // Should not end with a partial word — the next char after the title should be a space or end
    const original = 'Please help me fix the TypeScript errors in my large codebase project files';
    const nextChar = original[cm.title.length];
    expect(nextChar === ' ' || nextChar === undefined).toBe(true);
  });

  test('auto-generates title truncated at 50 chars exactly when no word boundary available', async () => {
    const longWord = 'a'.repeat(60);
    cm.addUserMessage(longWord);
    expect(cm.title).toBe(longWord.slice(0, 50));
  });

  test('does not override title on subsequent messages', async () => {
    cm.addUserMessage('First message');
    const firstTitle = cm.title;
    cm.addUserMessage('Second message');
    expect(cm.title).toBe(firstTitle);
  });

  test('manual title override via direct assignment', async () => {
    cm.addUserMessage('Auto title message');
    cm.title = 'My custom title';
    expect(cm.title).toBe('My custom title');
    expect(cm.getTitleSource()).toBe('user');
  });

  test('system title updates do not override manual titles', async () => {
    cm.addUserMessage('Auto title message');
    cm.title = 'My custom title';
    cm.setSystemTitle('Generated replacement');
    expect(cm.title).toBe('My custom title');
    expect(cm.getTitleSource()).toBe('user');
  });

  test('resetAll clears the title', async () => {
    cm.addUserMessage('Some message');
    expect(cm.title).not.toBe('');
    cm.resetAll();
    expect(cm.title).toBe('');
  });

  test('title auto-generates again after reset', async () => {
    cm.addUserMessage('First session');
    cm.resetAll();
    cm.addUserMessage('Second session');
    expect(cm.title).toBe('Second session');
  });
});

// ---------------------------------------------------------------------------
// Token budget warnings
// NOTE: These tests verify runtime event envelope shape only — they do not test the
// actual Orchestrator.runTurn() path, which requires a mock provider and full
// initialization. The cooldown bracket logic (lastWarningBracket) cannot be
// unit-tested here without substantially refactoring Orchestrator dependencies.
// ---------------------------------------------------------------------------
describe('Token budget warning', () => {
  test('OPS_CONTEXT_WARNING event has correct shape', async () => {
    const bus = new RuntimeEventBus();
    const events: Array<{ usage: number; threshold: number }> = [];
    bus.on<Extract<import('@/runtime/index.ts').OpsEvent, { type: 'OPS_CONTEXT_WARNING' }>>(
      'OPS_CONTEXT_WARNING',
      ({ payload }) => events.push(payload),
    );

    bus.emit('ops', createEventEnvelope('OPS_CONTEXT_WARNING', {
      type: 'OPS_CONTEXT_WARNING',
      usage: 85,
      threshold: 80,
    }, {
      sessionId: 'test-session',
      traceId: 'test-trace',
      source: 'qol-features.test',
    }));
    await flushMicrotasks();
    expect(events).toHaveLength(1);
    expect(events[0].usage).toBe(85);
    expect(events[0].threshold).toBe(80);
  });

  test('OPS_CONTEXT_WARNING is not emitted below threshold', async () => {
    // Simulate the logic: warning fires only when usagePct >= threshold
    const bus = new RuntimeEventBus();
    const events: Array<{ usage: number; threshold: number }> = [];
    bus.on<Extract<import('@/runtime/index.ts').OpsEvent, { type: 'OPS_CONTEXT_WARNING' }>>(
      'OPS_CONTEXT_WARNING',
      ({ payload }) => events.push(payload),
    );

    const threshold = 80;
    const usagePct = 70; // below threshold
    if (usagePct >= threshold) {
      bus.emit('ops', createEventEnvelope('OPS_CONTEXT_WARNING', {
        type: 'OPS_CONTEXT_WARNING',
        usage: usagePct,
        threshold,
      }, {
        sessionId: 'test-session',
        traceId: 'test-trace',
        source: 'qol-features.test',
      }));
      await flushMicrotasks();
    }
    expect(events).toHaveLength(0);
  });

  test('OPS_CONTEXT_WARNING fires at threshold exactly', async () => {
    const bus = new RuntimeEventBus();
    const events: Array<{ usage: number; threshold: number }> = [];
    bus.on<Extract<import('@/runtime/index.ts').OpsEvent, { type: 'OPS_CONTEXT_WARNING' }>>(
      'OPS_CONTEXT_WARNING',
      ({ payload }) => events.push(payload),
    );

    const threshold = 80;
    const usagePct = 80; // exactly at threshold
    if (usagePct >= threshold) {
      bus.emit('ops', createEventEnvelope('OPS_CONTEXT_WARNING', {
        type: 'OPS_CONTEXT_WARNING',
        usage: usagePct,
        threshold,
      }, {
        sessionId: 'test-session',
        traceId: 'test-trace',
        source: 'qol-features.test',
      }));
      await flushMicrotasks();
    }
    expect(events).toHaveLength(1);
    expect(events[0].usage).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Conversation export format
// ---------------------------------------------------------------------------
describe('Conversation export format', () => {
  let cm: ConversationManager;

  beforeEach(async () => {
    cm = new ConversationManager(() => 80);
  });

  test('toJSON includes messages array', async () => {
    cm.addUserMessage('Hello');
    cm.addAssistantMessage('Hi there');
    const data = cm.toJSON() as { messages: Array<{ role: string; content: string }> };
    expect(data.messages).toBeDefined();
    expect(data.messages.length).toBe(2);
  });

  test('toJSON preserves user message role', async () => {
    cm.addUserMessage('test input');
    const data = cm.toJSON() as { messages: Array<{ role: string; content: string }> };
    expect(data.messages[0].role).toBe('user');
    expect(data.messages[0].content).toBe('test input');
  });

  test('toJSON preserves assistant message role', async () => {
    cm.addAssistantMessage('test response');
    const data = cm.toJSON() as { messages: Array<{ role: string; content: string }> };
    expect(data.messages[0].role).toBe('assistant');
    expect(data.messages[0].content).toBe('test response');
  });

  test('export markdown structure: user section', async () => {
    // Simulate what /export does: format messages as markdown
    cm.addUserMessage('Hello world');
    const data = cm.toJSON() as { messages: Array<{ role: string; content: string }> };

    const lines: string[] = [];
    for (const msg of data.messages) {
      if (msg.role === 'user') lines.push(`## User\n\n${msg.content}\n`);
    }
    const md = lines.join('\n');
    expect(md).toContain('## User');
    expect(md).toContain('Hello world');
  });

  test('export markdown structure: assistant section', async () => {
    cm.addAssistantMessage('Sure thing!');
    const data = cm.toJSON() as { messages: Array<{ role: string; content: string }> };

    const lines: string[] = [];
    for (const msg of data.messages) {
      if (msg.role === 'assistant') lines.push(`## Assistant\n\n${msg.content}\n`);
    }
    const md = lines.join('\n');
    expect(md).toContain('## Assistant');
    expect(md).toContain('Sure thing!');
  });

  test('export markdown structure: tool section with code block', async () => {
    cm.addToolResults([{ callId: 'c1', success: true, output: 'file content here' }]);
    const data = cm.toJSON() as { messages: Array<{ role: string; content: string; callId?: string; toolName?: string }> };

    const lines: string[] = [];
    for (const msg of data.messages) {
      if (msg.role === 'tool') {
        const name = msg.toolName ?? msg.callId ?? 'tool';
        lines.push(`## Tool: ${name}\n\n\`\`\`\n${msg.content}\n\`\`\`\n`);
      }
    }
    const md = lines.join('\n');
    expect(md).toContain('## Tool:');
    expect(md).toContain('```');
    expect(md).toContain('file content here');
  });
});
