import { describe, test, expect, beforeEach } from 'bun:test';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools';
import type { StreamDelta } from '@pellux/goodvibes-sdk/platform/providers';
import { getTestAgentManager, resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

beforeEach(() => {
  resetTestRuntimeServices();
  resetTestRuntimeServices();
});

// ---------------------------------------------------------------------------
// AgentRecord streamingContent field
// ---------------------------------------------------------------------------

describe('AgentRecord streamingContent field', () => {
  test('streamingContent is undefined by default after spawn', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    // 'Stuck task' bypasses the orchestrator (test hook in AgentManager.spawn)
    expect(rec.streamingContent).toBeUndefined();
  });

  test('streamingContent can be set on AgentRecord', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    live.streamingContent = 'Hello from streaming';
    expect(am.getStatus(rec.id)!.streamingContent).toBe('Hello from streaming');
  });

  test('streamingContent can be cleared (set to undefined)', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    live.streamingContent = 'some content';
    expect(live.streamingContent).toBe('some content');
    live.streamingContent = undefined;
    expect(live.streamingContent).toBeUndefined();
  });

  test('streamingContent accepts multi-line content', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    live.streamingContent = 'Line one\nLine two\nLine three';
    expect(live.streamingContent).toBe('Line one\nLine two\nLine three');
  });

  test('streamingContent field exists on AgentRecord type', () => {
    // Type-level check: ensure the field is assignable without a cast
    const rec: AgentRecord = {
      id: 'agent-test01',
      task: 'Test task',
      template: 'general',
      tools: ['read'],
      status: 'running',
      startedAt: Date.now(),
      orchestrationDepth: 0,
      toolCallCount: 0,
      executionProtocol: 'gather-plan-apply',
      reviewMode: 'wrfc',
      communicationLane: 'direct',
      streamingContent: 'live content',
    };
    expect(rec.streamingContent).toBe('live content');
    // And can be cleared
    rec.streamingContent = undefined;
    expect(rec.streamingContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// StreamDelta accumulation pattern (pure logic)
// ---------------------------------------------------------------------------

/**
 * Simulate the onDelta accumulation logic from AgentOrchestrator.runAgent().
 * This extracts and tests the core accumulation + progress-truncation logic
 * without requiring a live provider or conversation.
 */
function makeAccumulator(record: AgentRecord) {
  let streamAccumulated = '';
  record.streamingContent = undefined;

  const onDelta = (delta: StreamDelta) => {
    if (delta.content) {
      streamAccumulated += delta.content;
      record.streamingContent = streamAccumulated;
      const snippet =
        streamAccumulated.length > 100
          ? '...' + streamAccumulated.slice(-97)
          : streamAccumulated;
      record.progress = snippet.replace(/\n/g, ' ').trim() || 'Streaming...';
    }
  };

  return { onDelta, getAccumulated: () => streamAccumulated };
}

describe('StreamDelta accumulation pattern', () => {
  test('accumulates content across multiple deltas', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta, getAccumulated } = makeAccumulator(live);

    onDelta({ content: 'Hello' });
    onDelta({ content: ' world' });
    onDelta({ content: '!' });

    expect(getAccumulated()).toBe('Hello world!');
    expect(live.streamingContent).toBe('Hello world!');
  });

  test('ignores deltas with no content', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta, getAccumulated } = makeAccumulator(live);

    onDelta({ content: 'First' });
    onDelta({}); // no content field
    onDelta({ toolCalls: [{ index: 0, name: 'read' }] }); // tool-call delta, no content
    onDelta({ content: ' Last' });

    expect(getAccumulated()).toBe('First Last');
    expect(live.streamingContent).toBe('First Last');
  });

  test('sets streamingContent to accumulated string after each delta', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta } = makeAccumulator(live);

    onDelta({ content: 'Chunk A' });
    expect(live.streamingContent).toBe('Chunk A');

    onDelta({ content: ' Chunk B' });
    expect(live.streamingContent).toBe('Chunk A Chunk B');
  });

  test('streamingContent reflects full accumulated text (not just last delta)', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta } = makeAccumulator(live);

    const chunks = ['Part 1. ', 'Part 2. ', 'Part 3.'];
    for (const chunk of chunks) {
      onDelta({ content: chunk });
    }

    expect(live.streamingContent).toBe('Part 1. Part 2. Part 3.');
  });
});

// ---------------------------------------------------------------------------
// Progress truncation logic
// ---------------------------------------------------------------------------

describe('progress truncation logic', () => {
  test('progress shows full text when accumulated <= 100 chars', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta } = makeAccumulator(live);

    const text = 'Short response text';
    onDelta({ content: text });

    expect(live.progress).toBe(text);
  });

  test('progress uses ellipsis prefix when accumulated > 100 chars', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta } = makeAccumulator(live);

    // Feed exactly 101 chars
    onDelta({ content: 'a'.repeat(101) });

    expect(live.progress).toBeDefined();
    expect(live.progress!.startsWith('...')).toBe(true);
    // Last 97 chars of 101 a's = 97 a's, prefixed with '...'
    expect(live.progress!.length).toBe(100);
    expect(live.progress).toBe('...' + 'a'.repeat(97));
  });

  test('progress truncates to last 97 chars with ... prefix for long text', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta } = makeAccumulator(live);

    // Build a 200-char string with distinct start/end
    const start = 'START'.repeat(10); // 50 chars
    const end = 'FINISH'.repeat(25);  // 150 chars, total > 100
    onDelta({ content: start + end });

    expect(live.progress!.startsWith('...')).toBe(true);
    // Should contain the last 97 chars of (start + end)
    const fullText = start + end;
    const expectedTail = fullText.slice(-97);
    expect(live.progress).toBe('...' + expectedTail);
  });

  test('progress replaces newlines with spaces', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta } = makeAccumulator(live);

    onDelta({ content: 'Line one\nLine two\nLine three' });

    expect(live.progress).not.toContain('\n');
    expect(live.progress).toContain('Line one');
    expect(live.progress).toContain('Line two');
  });

  test('progress defaults to Streaming... when content trims to empty', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta } = makeAccumulator(live);

    // Whitespace-only content normalises to empty after trim
    onDelta({ content: '   \n   \n   ' });

    expect(live.progress).toBe('Streaming...');
  });

  test('progress at exactly 100 chars is not truncated', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta } = makeAccumulator(live);

    onDelta({ content: 'x'.repeat(100) });

    // <= 100 means no ellipsis prefix
    expect(live.progress!.startsWith('...')).toBe(false);
    expect(live.progress).toBe('x'.repeat(100));
  });

  test('multiple delta chunks accumulate before truncation threshold is applied', () => {
    const am = getTestAgentManager();
    const rec = am.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });
    const live = am.getStatus(rec.id)!;
    const { onDelta } = makeAccumulator(live);

    // 50 chars each, first delta stays under 100; second pushes over
    onDelta({ content: 'a'.repeat(50) });
    expect(live.progress!.startsWith('...')).toBe(false);

    onDelta({ content: 'b'.repeat(60) }); // total 110 chars, now over threshold
    expect(live.progress!.startsWith('...')).toBe(true);
    const fullText = 'a'.repeat(50) + 'b'.repeat(60);
    expect(live.progress).toBe('...' + fullText.slice(-97));
  });
});
