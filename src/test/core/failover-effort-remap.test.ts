// ---------------------------------------------------------------------------
// failover-effort-remap.test.ts — a failover re-resolves the configured
// reasoning level against the model that is about to serve.
//
// The gap this closes: failover switched the registry to a different model and
// left `provider.reasoningEffort` pointing at a level that model may not
// offer. The request then either got rejected with a provider-side 400 the
// user could not connect to anything they had done, or silently ran at a
// depth nobody chose.
//
// Both halves of a failover go through switchNarrated, so the re-resolution
// hooks in there: the level is snapped DOWN against the serving model and the
// SDK's own sentence explaining the remap is surfaced verbatim.
//
// The retryTurn double below models the REAL rollback (see main.ts): the failed
// turn's transcript is erased and only the notice handed in is re-posted. It
// used to be `() => true`, which swallowed the notice and rolled nothing back —
// and that unrealistic double is exactly why the "rolled-back effort notice"
// defect shipped. The sentence was announced BEFORE retryTurn, so in production
// the rollback deleted it every time while these tests still saw it.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ReasoningEffortSpec } from '@pellux/goodvibes-sdk/platform/providers';
import { wireStreamEventMetrics, type WireStreamEventMetricsOptions } from '../../core/stream-event-wiring.ts';

/** No curated family row matches these ids, so the attached spec governs. */
const CONFIGURED_ID = 'test-only-configured-model';
const FALLBACK_ID = 'test-only-fallback-model';

const SIX_LEVELS: ReasoningEffortSpec = {
  kind: 'effort',
  values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  source: 'catalog',
};

const THREE_LEVELS: ReasoningEffortSpec = {
  kind: 'effort',
  values: ['low', 'medium', 'high'],
  source: 'catalog',
};

const NO_REASONING: ReasoningEffortSpec = { kind: 'unavailable', values: [], source: 'catalog' };

function makeTurnBus(): { on(type: string, listener: (payload: unknown) => void): () => void; emit(type: string, payload: unknown): void } {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    on(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
      return () => {
        const current = listeners.get(type) ?? [];
        listeners.set(type, current.filter((entry) => entry !== listener));
      };
    },
    emit(type, payload) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(payload);
    },
  };
}

/**
 * A registry holding two models with different reasoning specs. Its
 * getCurrentModel returns the id and spec too, which is what lets the failover
 * path resolve against the model that is actually serving.
 */
function makeRegistry(specs: Record<string, ReasoningEffortSpec>) {
  let currentKey = `anthropic:${CONFIGURED_ID}`;
  return {
    getCurrentModel: () => {
      const [provider, id] = [currentKey.split(':')[0]!, currentKey.split(':').slice(1).join(':')];
      return {
        provider,
        registryKey: currentKey,
        id,
        displayName: id,
        ...(specs[id] ? { reasoningEffort: specs[id] } : {}),
      };
    },
    setCurrentModel(key: string) { currentKey = key; },
    get currentKey() { return currentKey; },
  };
}

function wire(options: {
  specs: Record<string, ReasoningEffortSpec>;
  configuredEffort: string | undefined;
}): { messages: string[]; emit: (type: string, payload: unknown) => void } {
  const turns = makeTurnBus();
  const tools = makeTurnBus();
  const messages: string[] = [];
  const registry = makeRegistry(options.specs);
  const wired: WireStreamEventMetricsOptions = {
    events: { turns, tools } as unknown as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 },
    providerRegistry: registry,
    systemMessageRouter: {
      high: (m: string) => messages.push(m),
      low: () => {},
      userReceipt: (m: string) => messages.push(m),
    },
    render: () => {},
    metrics: {
      startTime: 0, deltaCount: 0, tokenSpeed: 0, ttftMs: undefined, ttftRecorded: false,
      activeToolStartedAtMs: undefined, activeToolName: undefined, activeToolCallId: undefined,
    } as unknown as WireStreamEventMetricsOptions['metrics'],
    providerOptimizer: {
      enabled: true,
      testFallback: () => ({
        chain: [{ position: 0, providerId: 'openai', modelId: FALLBACK_ID, capable: true }],
      }),
      recordFallbackTransition: () => {},
    } as unknown as WireStreamEventMetricsOptions['providerOptimizer'],
    // As in main.ts: roll the failed turn's transcript back, then post the
    // notice handed in. Anything announced before this call is gone.
    retryTurn: (notice?: string) => {
      messages.length = 0;
      if (notice) messages.push(notice);
      return true;
    },
    getConfiguredRegistryKey: () => `anthropic:${CONFIGURED_ID}`,
    getConfiguredReasoningEffort: () => options.configuredEffort,
  };
  wireStreamEventMetrics(wired);
  return { messages, emit: (type, payload) => turns.emit(type, payload) };
}

/** A turn error that the failover path treats as provider-side and retryable. */
function emitFailoverTurnError(emit: (type: string, payload: unknown) => void): void {
  emit('TURN_ERROR', { error: new Error('rate limit exceeded (429)') });
}

describe('failover re-resolves reasoning effort against the serving model', () => {
  test('a level the fallback model lacks is announced as snapped down', () => {
    const { messages, emit } = wire({
      specs: { [CONFIGURED_ID]: SIX_LEVELS, [FALLBACK_ID]: THREE_LEVELS },
      configuredEffort: 'xhigh',
    });
    emitFailoverTurnError(emit);

    const note = messages.find((m) => m.includes("Reasoning effort 'xhigh'"));
    expect(note, `expected a remap note, got: ${JSON.stringify(messages)}`).toBeDefined();
    expect(note).toContain(FALLBACK_ID);
    expect(note).toContain("using 'high'");
    expect(note).toContain('[Failover]');
  });

  test('a level the fallback model does offer is not narrated at all', () => {
    const { messages, emit } = wire({
      specs: { [CONFIGURED_ID]: SIX_LEVELS, [FALLBACK_ID]: THREE_LEVELS },
      configuredEffort: 'medium',
    });
    emitFailoverTurnError(emit);

    expect(messages.some((m) => m.includes('Reasoning effort'))).toBe(false);
  });

  test('a fallback model with no configurable reasoning says the level is dropped', () => {
    const { messages, emit } = wire({
      specs: { [CONFIGURED_ID]: SIX_LEVELS, [FALLBACK_ID]: NO_REASONING },
      configuredEffort: 'high',
    });
    emitFailoverTurnError(emit);

    const note = messages.find((m) => m.includes('Reasoning effort'));
    expect(note, `expected a remap note, got: ${JSON.stringify(messages)}`).toBeDefined();
    expect(note).toContain("isn't configurable");
  });

  test('no configured level means nothing is resolved and nothing is said', () => {
    const { messages, emit } = wire({
      specs: { [CONFIGURED_ID]: SIX_LEVELS, [FALLBACK_ID]: THREE_LEVELS },
      configuredEffort: undefined,
    });
    emitFailoverTurnError(emit);

    expect(messages.some((m) => m.includes('Reasoning effort'))).toBe(false);
  });
});
