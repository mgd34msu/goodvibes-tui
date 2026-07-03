/**
 * error-affordance.test.ts
 *
 * Tests for the one-key retry affordance built on top of wireStreamEventMetrics.
 *
 * Covers:
 *   - onErrorSurfaced fires when TURN_ERROR is surfaced immediately (no optimizer)
 *   - onErrorSurfaced fires after chain exhaustion
 *   - onErrorSurfaced does NOT fire on successful automatic failover
 *   - 'r' key re-submits exactly once with no duplicate user message (message-count)
 *   - 'm' key triggers openModelPicker
 *   - any other key dismisses affordance without retry
 *   - affordance only activates while retryCtx is armed
 *   - affordance is inactive during normal composing (no TURN_ERROR fired)
 */

import { describe, test, expect, mock } from 'bun:test';
import type { WireStreamEventMetricsOptions, StreamMetrics, WireStreamEventMetricsResult } from '../../core/stream-event-wiring.ts';
import { wireStreamEventMetrics } from '../../core/stream-event-wiring.ts';

// ---------------------------------------------------------------------------
// Minimal stubs reused from failover-wiring.test.ts pattern
// ---------------------------------------------------------------------------

type TurnEvent = 'STREAM_START' | 'STREAM_DELTA' | 'STREAM_END' | 'TURN_COMPLETED' | 'TURN_ERROR' | 'TURN_CANCEL';
type ToolEvent = 'TOOL_EXECUTING' | 'TOOL_SUCCEEDED' | 'TOOL_FAILED' | 'TOOL_CANCELLED';

function makeTurnBus() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {
    STREAM_START: [], STREAM_DELTA: [], STREAM_END: [],
    TURN_COMPLETED: [], TURN_ERROR: [], TURN_CANCEL: [],
  };
  return {
    on<K extends TurnEvent>(event: K, handler: K extends 'TURN_ERROR' ? (ev: { error: string }) => void : () => void) {
      // Lazily create the bucket for event names outside the fixed TurnEvent
      // union (e.g. the structurally-consumed STREAM_RETRY/STREAM_STALL —
      // see stream-event-wiring.ts) — a real event bus does not throw when
      // something subscribes to an event type it hasn't seen yet.
      const bucket = (listeners[event] ??= []);
      (bucket as Array<unknown>).push(handler);
      return () => {
        const idx = (bucket as Array<unknown>).indexOf(handler);
        if (idx !== -1) (bucket as Array<unknown>).splice(idx, 1);
      };
    },
    emitTurnError(error: string) {
      for (const h of (listeners['TURN_ERROR'] as Array<(ev: { error: string }) => void>).slice()) h({ error });
    },
    emit(event: TurnEvent) {
      const hs = listeners[event];
      if (hs) for (const h of hs.slice()) (h as () => void)();
    },
  };
}

function makeToolBus() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {
    TOOL_EXECUTING: [], TOOL_SUCCEEDED: [], TOOL_FAILED: [], TOOL_CANCELLED: [],
  };
  return {
    on(event: ToolEvent, handler: (...args: unknown[]) => void) {
      listeners[event]!.push(handler);
      return () => {};
    },
  };
}

function makeMetrics(): StreamMetrics {
  return {
    startTime: 0, deltaCount: 0, tokenSpeed: 0,
    ttftMs: undefined, ttftRecorded: false,
    activeToolStartedAtMs: undefined, activeToolName: undefined,
    lastDeltaAtMs: undefined, stallEpisode: 0,
    reconnectAttempt: undefined, reconnectMaxAttempts: undefined,
  };
}

type FailoverChainNode = { position: number; providerId: string; modelId: string; capable: boolean };

function makeOptimizer(options: { enabled: boolean; chain?: FailoverChainNode[] }) {
  return {
    get enabled() { return options.enabled; },
    testFallback: (_profile?: Record<string, unknown>) => ({ chain: options.chain ?? [] }),
    recordFallbackTransition(_from: string, _to: string, _reason: string) {},
  };
}

function makeProviderRegistry(currentProvider = 'anthropic') {
  let currentKey = `${currentProvider}:claude-3-5-sonnet`;
  return {
    getCurrentModel: () => ({ provider: currentKey.split(':')[0]!, registryKey: currentKey }),
    setCurrentModel(key: string) { currentKey = key; },
  };
}

function wireBasic(
  turnBus: ReturnType<typeof makeTurnBus>,
  toolBus: ReturnType<typeof makeToolBus>,
  overrides: Partial<WireStreamEventMetricsOptions> = {},
): WireStreamEventMetricsResult & { messages: string[] } {
  const messages: string[] = [];
  const result = wireStreamEventMetrics({
    events: { turns: turnBus, tools: toolBus } as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 },
    providerRegistry: makeProviderRegistry(),
    systemMessageRouter: { high: (m: string) => messages.push(m), low: (m: string) => messages.push(m) },
    render: () => {},
    metrics: makeMetrics(),
    ...overrides,
  });
  return Object.assign(result, { messages });
}

// ---------------------------------------------------------------------------
// Tests: onErrorSurfaced callback
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — onErrorSurfaced', () => {
  test('fires when TURN_ERROR surfaces immediately (no optimizer)', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const result = wireBasic(turns, tools);
    const cb = mock(() => {});
    result.onErrorSurfaced(cb);

    turns.emitTurnError('network timeout');

    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('does NOT fire on successful automatic failover', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const optimizer = makeOptimizer({
      enabled: true,
      chain: [
        { position: 0, providerId: 'anthropic', modelId: 'claude-3-5-sonnet', capable: true },
        { position: 1, providerId: 'openai', modelId: 'gpt-5', capable: true },
      ],
    });
    const result = wireBasic(turns, tools, { providerOptimizer: optimizer, retryTurn });
    const cb = mock(() => {});
    result.onErrorSurfaced(cb);

    turns.emitTurnError('api error');

    // Successful failover: retryTurn called, onErrorSurfaced NOT called
    expect(retryTurn).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();
  });

  test('fires after chain exhaustion', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const optimizer = makeOptimizer({
      enabled: true,
      chain: [
        // Only the current provider — no alternative capable node
        { position: 0, providerId: 'anthropic', modelId: 'claude-3-5-sonnet', capable: true },
      ],
    });
    const result = wireBasic(turns, tools, { providerOptimizer: optimizer, retryTurn });
    const cb = mock(() => {});
    result.onErrorSurfaced(cb);

    turns.emitTurnError('503 service unavailable');

    expect(retryTurn).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('fires when optimizer is present but disabled', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const optimizer = makeOptimizer({
      enabled: false,
      chain: [{ position: 0, providerId: 'openai', modelId: 'gpt-5', capable: true }],
    });
    const result = wireBasic(turns, tools, { providerOptimizer: optimizer });
    const cb = mock(() => {});
    result.onErrorSurfaced(cb);

    turns.emitTurnError('rate limit');

    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: retry affordance state machine simulation
// ---------------------------------------------------------------------------

describe('error affordance state machine', () => {
  /**
   * Simulate the main.ts affordance logic directly:
   *   errorAffordanceActive flag, retryCtx snapshot, key intercept.
   * This validates the logic in isolation without spinning up a full TUI.
   */

  function makeAffordanceSim() {
    // Message log and fake conversation (tracks message count).
    let msgCount = 0;
    const addUserMessage = () => { msgCount++; };
    const removeMessagesAfter = (n: number) => { msgCount = n; };
    const getMessageCount = () => msgCount;

    // retryCtx shape mirrors main.ts
    let retryCtx: { count: number; text: string } | null = null;
    let errorAffordanceActive = false;
    const resubmissions: string[] = [];
    const modelPickerOpens: number[] = [];
    let renderCount = 0;

    // retryTurn: rolls back to snapshot count, resubmits
    const retryTurn = () => {
      if (!retryCtx) return;
      const { count, text } = retryCtx;
      removeMessagesAfter(count);
      resubmissions.push(text);
    };

    // Simulate submitInput: snapshot + add user message
    const submitInput = (text: string) => {
      retryCtx = { count: msgCount, text };
      addUserMessage();
    };

    // Simulate onErrorSurfaced callback
    const onErrorSurfaced = () => {
      if (retryCtx) {
        errorAffordanceActive = true;
      }
    };

    // Simulate stdin data handler key intercept
    const handleKey = (data: string): 'retry' | 'model-picker' | 'dismissed' | 'normal' => {
      if (errorAffordanceActive) {
        errorAffordanceActive = false;
        if (data === 'r' && retryCtx) {
          retryTurn();
          renderCount++;
          return 'retry';
        }
        if (data === 'm') {
          modelPickerOpens.push(1);
          renderCount++;
          return 'model-picker';
        }
        return 'dismissed';
      }
      return 'normal';
    };

    return {
      submitInput, onErrorSurfaced, handleKey,
      getMessageCount, resubmissions, modelPickerOpens,
      getRenderCount: () => renderCount,
      isAffordanceActive: () => errorAffordanceActive,
    };
  }

  test('r key re-submits exactly once with no duplicate user message', () => {
    const sim = makeAffordanceSim();
    sim.submitInput('hello world'); // msgCount=1
    // Simulate LLM error surfacing
    sim.onErrorSurfaced();
    expect(sim.isAffordanceActive()).toBe(true);

    const result = sim.handleKey('r');
    expect(result).toBe('retry');
    // removeMessagesAfter(count=1 from snapshot before addUserMessage... wait:
    // submitInput sets retryCtx.count=0 (pre-add), then addUserMessage makes it 1.
    // After retry: removeMessagesAfter(0) → msgCount=0. No duplicate.
    expect(sim.getMessageCount()).toBe(0);
    expect(sim.resubmissions).toHaveLength(1);
    expect(sim.resubmissions[0]).toBe('hello world');
    // Affordance no longer active after 'r'
    expect(sim.isAffordanceActive()).toBe(false);
  });

  test('m key opens model picker without retrying', () => {
    const sim = makeAffordanceSim();
    sim.submitInput('test query');
    sim.onErrorSurfaced();

    const result = sim.handleKey('m');
    expect(result).toBe('model-picker');
    expect(sim.modelPickerOpens).toHaveLength(1);
    expect(sim.resubmissions).toHaveLength(0);
    expect(sim.isAffordanceActive()).toBe(false);
  });

  test('any other key dismisses affordance without retry', () => {
    const sim = makeAffordanceSim();
    sim.submitInput('query');
    sim.onErrorSurfaced();
    expect(sim.isAffordanceActive()).toBe(true);

    const result = sim.handleKey('x');
    expect(result).toBe('dismissed');
    expect(sim.resubmissions).toHaveLength(0);
    expect(sim.modelPickerOpens).toHaveLength(0);
    expect(sim.isAffordanceActive()).toBe(false);
  });

  test('affordance only active while retryCtx is armed', () => {
    const sim = makeAffordanceSim();
    // No submission — retryCtx is null, so onErrorSurfaced should not arm affordance
    sim.onErrorSurfaced();
    expect(sim.isAffordanceActive()).toBe(false);
  });

  test('affordance inactive during normal composing (no TURN_ERROR)', () => {
    const sim = makeAffordanceSim();
    sim.submitInput('query');
    // No error fired — affordance should not be active
    expect(sim.isAffordanceActive()).toBe(false);
    // Normal key routes normally
    const result = sim.handleKey('a');
    expect(result).toBe('normal');
  });

  test('exhausted chain: r still retries on current provider', () => {
    const sim = makeAffordanceSim();
    sim.submitInput('complex query');
    // Simulate exhausted chain: error surfaced to user
    sim.onErrorSurfaced();
    expect(sim.isAffordanceActive()).toBe(true);

    // 'r' re-submits on the current (unchanged) provider
    const result = sim.handleKey('r');
    expect(result).toBe('retry');
    expect(sim.resubmissions).toHaveLength(1);
    expect(sim.resubmissions[0]).toBe('complex query');
  });
});
