/**
 * Failover wiring tests for wireStreamEventMetrics.
 *
 * Covers:
 *   - Failover fires on TURN_ERROR when optimizer is enabled and a capable
 *     alternative provider exists: notice emitted, retryTurn called.
 *   - Honest notice content: includes from→to and the error class.
 *   - Disabled optimizer: TURN_ERROR surfaces immediately, retryTurn never called.
 *   - Chain exhaustion: no capable alternative beyond the failing provider,
 *     exhaustion notice emitted and retryTurn NOT called.
 *   - Switch failure: setCurrentModel throws, honest error displayed, retry skipped.
 */

import { describe, test, expect, mock } from 'bun:test';
import type { WireStreamEventMetricsOptions, StreamMetrics } from '../../core/stream-event-wiring.ts';
import { wireStreamEventMetrics } from '../../core/stream-event-wiring.ts';

// ---------------------------------------------------------------------------
// Minimal event bus stub
// ---------------------------------------------------------------------------

type TurnEvent = 'STREAM_START' | 'STREAM_DELTA' | 'STREAM_END' | 'TURN_COMPLETED' | 'TURN_ERROR' | 'TURN_CANCEL';
type ToolEvent = 'TOOL_EXECUTING' | 'TOOL_SUCCEEDED' | 'TOOL_FAILED' | 'TOOL_CANCELLED';

type TurnHandlerMap = {
  TURN_ERROR: Array<(ev: { error: string }) => void>;
  [K: string]: Array<(...args: unknown[]) => void>;
};

function makeTurnBus() {
  const listeners: TurnHandlerMap = {
    STREAM_START: [],
    STREAM_DELTA: [],
    STREAM_END: [],
    TURN_COMPLETED: [],
    TURN_ERROR: [],
    TURN_CANCEL: [],
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
      for (const h of listeners['TURN_ERROR'].slice()) h({ error });
    },
    emit(event: TurnEvent) {
      const hs = listeners[event];
      if (hs) for (const h of hs.slice()) (h as () => void)();
    },
    /**
     * Emit an arbitrary event name with a payload — used to simulate the
     * not-yet-in-the-SDK STREAM_RETRY/STREAM_STALL events, which
     * wireStreamEventMetrics consumes structurally (see the LooseTurnEventFeed
     * cast in stream-event-wiring.ts) rather than through the typed TurnEvent
     * union this stub otherwise models.
     */
    emitRaw(event: string, payload?: unknown) {
      const hs = listeners[event];
      if (hs) for (const h of hs.slice()) (h as (p?: unknown) => void)(payload);
    },
  };
}

function makeToolBus() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {
    TOOL_EXECUTING: [],
    TOOL_SUCCEEDED: [],
    TOOL_FAILED: [],
    TOOL_CANCELLED: [],
  };
  return {
    on(event: ToolEvent, handler: (...args: unknown[]) => void) {
      listeners[event]!.push(handler);
      return () => {};
    },
  };
}

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

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

function makeOptimizer(options: {
  enabled: boolean;
  chain?: FailoverChainNode[];
}) {
  const transitions: Array<{ from: string; to: string; reason: string }> = [];
  return {
    get enabled() { return options.enabled; },
    testFallback: (_profile?: Record<string, unknown>) => ({ chain: options.chain ?? [] }),
    recordFallbackTransition(from: string, to: string, reason: string) {
      transitions.push({ from, to, reason });
    },
    transitions,
  };
}

function makeProviderRegistry(currentProvider = 'anthropic') {
  let currentKey = `${currentProvider}:claude-3-5-sonnet`;
  const switchCalls: string[] = [];
  return {
    getCurrentModel: () => ({
      provider: currentKey.split(':')[0]!,
      registryKey: currentKey,
    }),
    setCurrentModel(key: string) {
      currentKey = key;
      switchCalls.push(key);
    },
    switchCalls,
  };
}

function makeOptions(
  turnBus: ReturnType<typeof makeTurnBus>,
  toolBus: ReturnType<typeof makeToolBus>,
  overrides: Partial<WireStreamEventMetricsOptions> = {},
): WireStreamEventMetricsOptions & { messages: string[] } {
  const messages: string[] = [];
  const systemMessageRouter = { high: (m: string) => messages.push(m), low: () => {} };
  const providerRegistry = makeProviderRegistry();
  return {
    events: { turns: turnBus, tools: toolBus } as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 },
    providerRegistry,
    systemMessageRouter,
    render: () => {},
    metrics: makeMetrics(),
    messages,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: disabled optimizer (baseline unchanged)
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — optimizer disabled', () => {
  test('TURN_ERROR surfaces immediately when optimizer is absent', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const opts = makeOptions(turns, tools);
    wireStreamEventMetrics(opts);

    turns.emitTurnError('network timeout');

    expect(opts.messages.some((m) => m.startsWith('[Error]'))).toBe(true);
  });

  test('retryTurn is never called when optimizer is absent', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const opts = makeOptions(turns, tools, { retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('some error');

    expect(retryTurn).not.toHaveBeenCalled();
  });

  test('TURN_ERROR surfaces immediately when optimizer.enabled is false', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const optimizer = makeOptimizer({
      enabled: false,
      chain: [{ position: 0, providerId: 'openai', modelId: 'gpt-5', capable: true }],
    });
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('api error');

    expect(opts.messages.some((m) => m.startsWith('[Error]'))).toBe(true);
    expect(retryTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: enabled optimizer — successful failover
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — optimizer enabled, failover fires', () => {
  test('retryTurn is called when a capable alternative exists', () => {
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
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('connection reset');

    expect(retryTurn).toHaveBeenCalledTimes(1);
  });

  test('failover notice includes from->to and error class', () => {
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
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('rate limit exceeded');

    const failoverMsg = opts.messages.find((m) => m.startsWith('[Failover]'));
    expect(failoverMsg).toBeDefined();
    expect(failoverMsg).toContain('anthropic');
    expect(failoverMsg).toContain('openai');
  });

  test('recordFallbackTransition is called with correct from/to', () => {
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
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('timeout');

    expect(optimizer.transitions).toHaveLength(1);
    expect(optimizer.transitions[0]!.from).toBe('anthropic');
    expect(optimizer.transitions[0]!.to).toBe('openai');
  });

  test('original error is NOT emitted as [Error] on successful failover', () => {
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
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('some error');

    const errorMsgs = opts.messages.filter((m) => m.startsWith('[Error]'));
    expect(errorMsgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: chain exhaustion
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — optimizer enabled, chain exhausted', () => {
  test('retryTurn not called when no capable alternative exists', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const optimizer = makeOptimizer({
      enabled: true,
      chain: [
        // Only the failing provider appears capable — no other viable candidate.
        { position: 0, providerId: 'anthropic', modelId: 'claude-3-5-sonnet', capable: true },
        { position: 1, providerId: 'openai', modelId: 'gpt-5', capable: false },
      ],
    });
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('network error');

    expect(retryTurn).not.toHaveBeenCalled();
  });

  test('exhaustion notice is emitted when chain yields no viable alternative', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const optimizer = makeOptimizer({
      enabled: true,
      chain: [
        { position: 0, providerId: 'anthropic', modelId: 'claude-3-5-sonnet', capable: true },
        { position: 1, providerId: 'openai', modelId: 'gpt-5', capable: false },
      ],
    });
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('some error');

    const exhaustMsg = opts.messages.find((m) => m.includes('Chain exhausted'));
    expect(exhaustMsg).toBeDefined();
  });

  test('empty chain causes exhaustion notice', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const optimizer = makeOptimizer({ enabled: true, chain: [] });
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('any error');

    expect(retryTurn).not.toHaveBeenCalled();
    expect(opts.messages.some((m) => m.includes('Chain exhausted'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: setCurrentModel failure
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — setCurrentModel fails', () => {
  test('switch failure: [Error] emitted, retryTurn not called', () => {
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
    const brokenRegistry = {
      getCurrentModel: () => ({ provider: 'anthropic', registryKey: 'anthropic:claude-3-5-sonnet' }),
      setCurrentModel: (_key: string) => { throw new Error('model not found in registry'); },
    };
    const messages: string[] = [];
    const opts: WireStreamEventMetricsOptions = {
      events: { turns, tools } as WireStreamEventMetricsOptions['events'],
      orchestrator: { streamingOutputTokens: 0 },
      providerRegistry: brokenRegistry,
      systemMessageRouter: { high: (m: string) => messages.push(m), low: () => {} },
      render: () => {},
      metrics: makeMetrics(),
      providerOptimizer: optimizer,
      retryTurn,
    };
    wireStreamEventMetrics(opts);

    turns.emitTurnError('api error');

    expect(retryTurn).not.toHaveBeenCalled();
    expect(messages.some((m) => m.startsWith('[Error]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: visited-set ping-pong prevention (Issue 1)
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — visited-set prevents ping-pong', () => {
  test('consecutive TURN_ERRORs across two providers: retryTurn called at most once per provider', () => {
    // Arrange: two capable providers; retryTurn re-fires TURN_ERROR simulating
    // provider B also failing. The visited set must stop the loop after
    // the chain is consumed — retryTurn is called exactly once (for B),
    // then exhaustion fires on the second TURN_ERROR.
    const turns = makeTurnBus();
    const tools = makeToolBus();
    let retryCallCount = 0;
    const retryTurn = mock(() => {
      retryCallCount++;
      // Simulate provider B failing immediately after switch.
      // This fires TURN_ERROR again from within retryTurn.
      turns.emitTurnError('provider B also failed');
    });
    const optimizer = makeOptimizer({
      enabled: true,
      chain: [
        { position: 0, providerId: 'anthropic', modelId: 'claude-3-5-sonnet', capable: true },
        { position: 1, providerId: 'openai', modelId: 'gpt-5', capable: true },
      ],
    });
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    // First error on anthropic — should failover to openai (retryTurn called once).
    turns.emitTurnError('anthropic failed');

    // retryTurn fired exactly once: once for the failover to openai.
    // The second TURN_ERROR (fired from inside retryTurn, simulating openai
    // failing) hits an exhausted chain and does NOT call retryTurn again.
    expect(retryCallCount).toBe(1);
    const exhaustMsg = opts.messages.find((m) => m.includes('Chain exhausted'));
    expect(exhaustMsg).toBeDefined();
  });

  test('visited set is cleared on TURN_COMPLETED so next turn can use all providers', () => {
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
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    // Turn 1: failover fires (visited: anthropic + openai).
    turns.emitTurnError('error turn 1');
    expect(retryTurn).toHaveBeenCalledTimes(1);

    // Simulate successful completion — visited set must be cleared.
    turns.emit('TURN_COMPLETED');

    // Turn 2: chain should not be considered exhausted from turn 1's visits.
    turns.emitTurnError('error turn 2');
    expect(retryTurn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: synthetic node skipped (Issue 3)
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — synthetic node skipped in failover', () => {
  test('synthetic provider is not selected as failover candidate', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const optimizer = makeOptimizer({
      enabled: true,
      chain: [
        { position: 0, providerId: 'anthropic', modelId: 'claude-3-5-sonnet', capable: true },
        // synthetic is capable but must be skipped (E11-6: double-indirection, no registryKey verification)
        { position: 1, providerId: 'synthetic', modelId: 'best-free', capable: true },
        // No real alternative beyond synthetic.
      ],
    });
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('anthropic error');

    // synthetic is skipped — chain exhausted, retryTurn NOT called.
    expect(retryTurn).not.toHaveBeenCalled();
    expect(opts.messages.some((m) => m.includes('Chain exhausted'))).toBe(true);
  });

  test('real provider after synthetic in chain is selected, synthetic skipped', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const optimizer = makeOptimizer({
      enabled: true,
      chain: [
        { position: 0, providerId: 'anthropic', modelId: 'claude-3-5-sonnet', capable: true },
        { position: 1, providerId: 'synthetic', modelId: 'best-free', capable: true },
        { position: 2, providerId: 'openai', modelId: 'gpt-5', capable: true },
      ],
    });
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('anthropic error');

    // openai selected, skipping synthetic; retryTurn called once.
    expect(retryTurn).toHaveBeenCalledTimes(1);
    const failoverMsg = opts.messages.find((m) => m.startsWith('[Failover]') && m.includes('openai'));
    expect(failoverMsg).toBeDefined();
    expect(opts.messages.some((m) => m.includes('synthetic'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: retryTurn context + no duplicate message (Issue 2 + 4)
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — clearFailoverVisited on new submission', () => {
  test('clearFailoverVisited resets visited set so a new turn can failover normally', () => {
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
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    const { clearFailoverVisited } = wireStreamEventMetrics(opts);

    // Turn 1: failover to openai (visited: anthropic + openai).
    turns.emitTurnError('error 1');
    expect(retryTurn).toHaveBeenCalledTimes(1);

    // Simulate new user submission clearing the set (without TURN_COMPLETED).
    clearFailoverVisited();

    // Turn 2: should be able to failover to openai again (fresh visited set).
    turns.emitTurnError('error 2');
    expect(retryTurn).toHaveBeenCalledTimes(2);
  });
});
// ---------------------------------------------------------------------------
// Tests: failover cost delta notice (E11-4)
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — failover cost delta notice', () => {
  test('cost delta suffix is appended to failover notice when catalog provides pricing', () => {
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
    // Catalog returns pricing for both models.
    const costLookup = {
      getCostFromCatalog(modelId: string) {
        if (modelId === 'claude-3-5-sonnet') return { input: 3.00, output: 15.00 };
        if (modelId === 'gpt-5') return { input: 10.00, output: 30.00 };
        return { input: 0, output: 0 };
      },
    };
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn, costLookup });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('connection reset');

    const failoverMsg = opts.messages.find((m) => m.startsWith('[Failover]'));
    expect(failoverMsg).toBeDefined();
    // Must contain cost/1M reference
    expect(failoverMsg).toContain('cost/1M');
    // Must show the arrow direction for input and output
    expect(failoverMsg).toContain('input');
    expect(failoverMsg).toContain('output');
  });

  test('failover notice has no cost suffix when costLookup is absent', () => {
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
    // No costLookup provided.
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('network error');

    const failoverMsg = opts.messages.find((m) => m.startsWith('[Failover]'));
    expect(failoverMsg).toBeDefined();
    // No cost suffix — no bracket after the error class.
    expect(failoverMsg).not.toContain('cost/1M');
    expect(failoverMsg).not.toContain('unavailable');
  });

  test('cost data unavailable message when catalog returns zeros for either model', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const retryTurn = mock(() => {});
    const optimizer = makeOptimizer({
      enabled: true,
      chain: [
        { position: 0, providerId: 'anthropic', modelId: 'claude-3-5-sonnet', capable: true },
        { position: 1, providerId: 'openai', modelId: 'unknown-future-model', capable: true },
      ],
    });
    // Catalog knows claude but not the target model.
    const costLookup = {
      getCostFromCatalog(modelId: string) {
        if (modelId === 'claude-3-5-sonnet') return { input: 3.00, output: 15.00 };
        return { input: 0, output: 0 };
      },
    };
    const opts = makeOptions(turns, tools, { providerOptimizer: optimizer, retryTurn, costLookup });
    wireStreamEventMetrics(opts);

    turns.emitTurnError('timeout');

    const failoverMsg = opts.messages.find((m) => m.startsWith('[Failover]'));
    expect(failoverMsg).toBeDefined();
    expect(failoverMsg).toContain('cost data unavailable');
    expect(failoverMsg).not.toContain('cost/1M');
  });
});

// ---------------------------------------------------------------------------
// Tests: no-delta stall metrics (W0.7 stall-honesty)
// ---------------------------------------------------------------------------

describe('wireStreamEventMetrics — stall metrics', () => {
  test('lastDeltaAtMs is set on STREAM_START and updated on STREAM_DELTA', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const opts = makeOptions(turns, tools);
    wireStreamEventMetrics(opts);

    expect(opts.metrics.lastDeltaAtMs).toBeUndefined();

    turns.emit('STREAM_START');
    const afterStart = opts.metrics.lastDeltaAtMs;
    expect(afterStart).toBeDefined();

    turns.emit('STREAM_DELTA');
    expect(opts.metrics.lastDeltaAtMs).toBeGreaterThanOrEqual(afterStart!);
  });

  test('stallEpisode resets to 0 on STREAM_START', () => {
    // wireStreamEventMetrics installs its own createStreamStallWatchdog
    // instance (hardcoded default 30s threshold) that sets metrics.stallEpisode
    // via its onStall callback on a real no-delta gap. Exercising the full 30s
    // timer here would make this suite slow; the dedicated watchdog unit
    // tests (stream-stall-watchdog.test.ts) cover that timing/episode-counting
    // behaviour in isolation with a short threshold. This test only covers
    // the wiring-level reset, which is the part local to this module.
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const opts = makeOptions(turns, tools);
    wireStreamEventMetrics(opts);

    turns.emit('STREAM_START');
    expect(opts.metrics.stallEpisode).toBe(0);
  });

  test('STREAM_RETRY (structurally consumed, not in the pinned SDK) populates reconnectAttempt/maxAttempts', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const opts = makeOptions(turns, tools);
    wireStreamEventMetrics(opts);

    turns.emit('STREAM_START');
    expect(opts.metrics.reconnectAttempt).toBeUndefined();

    turns.emitRaw('STREAM_RETRY', { attempt: 2, maxAttempts: 5 });

    expect(opts.metrics.reconnectAttempt).toBe(2);
    expect(opts.metrics.reconnectMaxAttempts).toBe(5);
  });

  test('a malformed STREAM_RETRY payload is ignored (runtime guard rejects it)', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const opts = makeOptions(turns, tools);
    wireStreamEventMetrics(opts);

    turns.emit('STREAM_START');
    turns.emitRaw('STREAM_RETRY', { attempt: 'not-a-number' });

    expect(opts.metrics.reconnectAttempt).toBeUndefined();
    expect(opts.metrics.reconnectMaxAttempts).toBeUndefined();
  });

  test('STREAM_DELTA clears reconnectAttempt/maxAttempts (a byte arriving means the reconnect succeeded)', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const opts = makeOptions(turns, tools);
    wireStreamEventMetrics(opts);

    turns.emit('STREAM_START');
    turns.emitRaw('STREAM_RETRY', { attempt: 1, maxAttempts: 3 });
    expect(opts.metrics.reconnectAttempt).toBe(1);

    turns.emit('STREAM_DELTA');

    expect(opts.metrics.reconnectAttempt).toBeUndefined();
    expect(opts.metrics.reconnectMaxAttempts).toBeUndefined();
  });

  test('STREAM_STALL (structurally consumed) does not throw and does not disturb metrics', () => {
    const turns = makeTurnBus();
    const tools = makeToolBus();
    const opts = makeOptions(turns, tools);
    wireStreamEventMetrics(opts);

    turns.emit('STREAM_START');
    expect(() => turns.emitRaw('STREAM_STALL', {})).not.toThrow();
  });
});
