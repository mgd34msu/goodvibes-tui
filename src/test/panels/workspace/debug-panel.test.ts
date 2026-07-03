import { beforeEach, describe, expect, test } from 'bun:test';
import { createEventEnvelope, type RuntimeEventBus } from '@/runtime/index.ts';
import { createUiRuntimeEvents } from '../../../runtime/ui-events.ts';
import { DebugPanel } from '../../../panels/debug-panel.ts';
import { createRuntimeBusStub, linesText, flushMicrotasks } from './_shared.ts';

function emitTurn(runtimeBus: RuntimeEventBus, type: string, payload: Record<string, unknown>): void {
  runtimeBus.emit('turn', createEventEnvelope(type as never, { type, ...payload } as never, {
    sessionId: 'session-1',
    source: 'test',
    turnId: (payload.turnId as string | undefined) ?? 'turn-1',
  }));
}

describe('workspace panel migrations', () => {
  let runtimeBus: RuntimeEventBus;

  beforeEach(async () => {
    runtimeBus = createRuntimeBusStub();
  });

  test('DebugPanel renders shared workspace empty state cleanly', async () => {
    const panel = new DebugPanel(createUiRuntimeEvents(runtimeBus).turns);
    const lines = panel.render(80, 20);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(linesText(lines)).toContain('API Debug');
    expect(linesText(lines)).toContain('No calls yet');
  });
});

describe('DebugPanel — WO-137', () => {
  let runtimeBus: RuntimeEventBus;
  let panel: DebugPanel;

  beforeEach(() => {
    runtimeBus = createRuntimeBusStub();
    panel = new DebugPanel(createUiRuntimeEvents(runtimeBus).turns);
  });

  test('successful calls never fabricate a 200 status code', async () => {
    emitTurn(runtimeBus, 'LLM_RESPONSE_RECEIVED', {
      turnId: 'turn-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      contentSummary: 'hi',
      toolCallCount: 0,
      inputTokens: 100,
      outputTokens: 50,
    });
    await flushMicrotasks();

    const text = linesText(panel.render(100, 24));
    expect(text).toContain('anthropic');
    expect(text).toContain('claude-sonnet-4-6');
    expect(text).not.toContain('[200]');
    expect(text).not.toContain('200');
  });

  test('TURN_ERROR rows attribute the real in-flight provider/model, never a fabricated unknown', async () => {
    emitTurn(runtimeBus, 'TURN_SUBMITTED', { turnId: 'turn-1', prompt: 'hello' });
    emitTurn(runtimeBus, 'LLM_REQUEST_STARTED', {
      turnId: 'turn-1',
      provider: 'openai',
      model: 'gpt-5.4',
      promptSummary: 'hello',
    });
    emitTurn(runtimeBus, 'TURN_ERROR', {
      turnId: 'turn-1',
      error: 'connection reset by provider',
      stopReason: 'provider_error',
    });
    await flushMicrotasks();

    const text = linesText(panel.render(120, 24));
    expect(text).toContain('openai');
    expect(text).toContain('gpt-5.4');
    expect(text).not.toContain('unknown');
  });

  test('TURN_ERROR with no in-flight request attributes honestly (n/a), not a fabricated unknown', async () => {
    emitTurn(runtimeBus, 'TURN_ERROR', {
      turnId: 'turn-1',
      error: 'preflight rejected the request',
      stopReason: 'preflight_failed',
    });
    await flushMicrotasks();

    const text = linesText(panel.render(120, 24));
    expect(text).toContain('n/a');
    expect(text).not.toContain('unknown');
  });

  test('a real HTTP status code is still surfaced when scraped from the error text', async () => {
    emitTurn(runtimeBus, 'LLM_REQUEST_STARTED', {
      turnId: 'turn-1',
      provider: 'openai',
      model: 'gpt-5.4',
      promptSummary: 'hello',
    });
    emitTurn(runtimeBus, 'TURN_ERROR', {
      turnId: 'turn-1',
      error: 'Error 429: rate limit exceeded',
      stopReason: 'provider_error',
    });
    await flushMicrotasks();

    const text = linesText(panel.render(120, 24));
    expect(text).toContain('[429]');
  });

  test('nav/filter/detail come from ScrollableListPanel: up/down select a row and the detail section reflects it', async () => {
    emitTurn(runtimeBus, 'LLM_RESPONSE_RECEIVED', {
      turnId: 'turn-1', provider: 'anthropic', model: 'claude-sonnet-4-6',
      contentSummary: 'a', toolCallCount: 0, inputTokens: 10, outputTokens: 5,
    });
    emitTurn(runtimeBus, 'LLM_RESPONSE_RECEIVED', {
      turnId: 'turn-2', provider: 'openai', model: 'gpt-5-mini',
      contentSummary: 'b', toolCallCount: 0, inputTokens: 20, outputTokens: 8,
    });
    await flushMicrotasks();

    // Follow-mode: newest call selected by default.
    let text = linesText(panel.render(120, 24));
    expect(text).toContain('gpt-5-mini');

    panel.handleInput('up');
    text = linesText(panel.render(120, 24));
    // Selected-row detail should now show the earlier call's provider.
    expect(text).toContain('anthropic');

    panel.handleInput('/');
    for (const ch of 'openai') panel.handleInput(ch);
    text = linesText(panel.render(120, 24));
    expect(text).toContain('gpt-5-mini');
    expect(text).not.toContain('claude-sonnet-4-6');
  });

  test('cost column reflects shared pricing (non-zero for a priced model)', async () => {
    emitTurn(runtimeBus, 'LLM_RESPONSE_RECEIVED', {
      turnId: 'turn-1', provider: 'anthropic', model: 'claude-opus-4-6',
      contentSummary: 'a', toolCallCount: 0, inputTokens: 1_000_000, outputTokens: 1_000_000,
    });
    await flushMicrotasks();

    const text = linesText(panel.render(120, 24));
    // input $15/1M + output $75/1M == $90 total for this one call.
    expect(text).toContain('$90');
  });

  test('render() returns exactly H lines of exactly W cells, populated and filtered', async () => {
    for (let i = 0; i < 3; i++) {
      emitTurn(runtimeBus, 'LLM_RESPONSE_RECEIVED', {
        turnId: `turn-${i}`, provider: 'anthropic', model: 'claude-sonnet-4-6',
        contentSummary: 'x', toolCallCount: 0, inputTokens: 10, outputTokens: 5,
      });
    }
    await flushMicrotasks();

    for (const [w, h] of [[80, 24], [120, 30], [100, 16]] as const) {
      const lines = panel.render(w, h);
      expect(lines).toHaveLength(h);
      expect(lines.every((line) => line.length === w)).toBe(true);
    }

    panel.handleInput('/');
    for (const ch of 'anthropic') panel.handleInput(ch);
    const filteredLines = panel.render(90, 24);
    expect(filteredLines).toHaveLength(24);
    expect(filteredLines.every((line) => line.length === 90)).toBe(true);
  });

  test('c clears the log after ConfirmState confirmation (y/Enter confirms, n/Esc cancels)', async () => {
    emitTurn(runtimeBus, 'LLM_RESPONSE_RECEIVED', {
      turnId: 'turn-1', provider: 'anthropic', model: 'claude-sonnet-4-6',
      contentSummary: 'a', toolCallCount: 0, inputTokens: 10, outputTokens: 5,
    });
    await flushMicrotasks();

    expect(linesText(panel.render(100, 24))).toContain('anthropic');

    panel.handleInput('c');
    let text = linesText(panel.render(100, 24));
    expect(text).toContain('Clear');
    expect(text).toContain('confirm');

    panel.handleInput('n');
    text = linesText(panel.render(100, 24));
    expect(text).toContain('anthropic');

    panel.handleInput('c');
    panel.handleInput('y');
    text = linesText(panel.render(100, 24));
    expect(text).toContain('No calls yet');
  });
});
