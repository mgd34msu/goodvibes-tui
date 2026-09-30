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
type ToolEvent = 'TOOL_RECEIVED' | 'TOOL_EXECUTING' | 'TOOL_SUCCEEDED' | 'TOOL_FAILED' | 'TOOL_CANCELLED';

function makeTurnBus() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {
    STREAM_START: [], STREAM_DELTA: [], STREAM_END: [],
    TURN_COMPLETED: [], TURN_ERROR: [], TURN_CANCEL: [],
  };
  return {
    on<K extends TurnEvent>(event: K, handler: K extends 'TURN_ERROR' ? (ev: { error: string }) => void : () => void) {
      // Lazily create the bucket for event names outside the fixed TurnEvent
      // union (e.g. the structurally-consumed STREAM_RETRY/STREAM_STALL,
      // see stream-event-wiring.ts), a real event bus does not throw when
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
    TOOL_RECEIVED: [], TOOL_EXECUTING: [], TOOL_SUCCEEDED: [], TOOL_FAILED: [], TOOL_CANCELLED: [],
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
    activeToolStartedAtMs: undefined, activeToolName: undefined, activeToolCallId: undefined,
    toolArgsByCallId: new Map(),
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
    fallbackLog: [] as readonly { readonly from: string; readonly to: string; readonly reason: string; readonly ts: number }[],
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
    // events is consumed structurally here (only .turns/.tools/.providers are ever
    // read, see stream-event-wiring.ts's own LooseTurnEventFeed comment for the
    // same rationale); this mirrors the existing convention in
    // failover-wiring.test.ts for the identical WireStreamEventMetricsOptions field.
    events: { turns: turnBus, tools: toolBus } as unknown as WireStreamEventMetricsOptions['events'],
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

describe('wireStreamEventMetrics: onErrorSurfaced', () => {
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
    // true = the turn really was re-submitted (main.ts's contract): a failover
    // that cannot retry is not a successful one and DOES surface its error.
    const retryTurn = mock(() => true);
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
    const retryTurn = mock(() => true);
    const optimizer = makeOptimizer({
      enabled: true,
      chain: [
        // Only the current provider, no alternative capable node
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
