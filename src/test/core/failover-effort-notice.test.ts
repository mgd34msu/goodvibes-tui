// ---------------------------------------------------------------------------
// failover-effort-notice.test.ts — the effort-remap sentence survives the retry
// rollback.
//
// The defect this pins: on a failover, switchNarrated() ran
// reconcileEffortWithServingModel(), which ANNOUNCED "Reasoning effort 'xhigh'
// isn't available on <fallback> — using 'medium'" straight into the transcript.
// The very next thing the wiring did was call retryTurn(), and retryTurn rolls
// the conversation back to its pre-submission message count — deleting
// everything the failed turn added, that sentence included. This is the same
// rollback the failover notice itself is handed IN to survive; the effort
// sentence was not, so the user failed over onto a model running at a lower
// reasoning level and was never told, even though the code went to the trouble
// of composing the explanation.
//
// The fix: reconcileEffortWithServingModel RETURNS the sentence, and the
// failover path folds it into the notice it hands to retryTurn. The restore
// path, which has no rollback after it, announces it directly.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { ReasoningEffortSpec } from '@pellux/goodvibes-sdk/platform/providers';
import type { StreamMetrics, WireStreamEventMetricsOptions } from '../../core/stream-event-wiring.ts';
import { wireStreamEventMetrics } from '../../core/stream-event-wiring.ts';
import { createFailoverTurnState } from '../../core/active-model-identity.ts';

const CAPABLE_SPEC: ReasoningEffortSpec = {
  kind: 'effort',
  values: ['low', 'medium', 'high', 'xhigh'],
  source: 'catalog',
};
const CAPPED_SPEC: ReasoningEffortSpec = { kind: 'effort', values: ['low', 'medium'], source: 'catalog' };

const CONFIGURED_KEY = 'anthropic:test-only-capable-reasoner';
const FALLBACK_KEY = 'openai:test-only-capped-reasoner';

const MODELS: Record<string, { id: string; provider: string; displayName: string; registryKey: string; reasoningEffort: ReasoningEffortSpec }> = {
  [CONFIGURED_KEY]: {
    id: 'test-only-capable-reasoner',
    provider: 'anthropic',
    displayName: 'Capable Model',
    registryKey: CONFIGURED_KEY,
    reasoningEffort: CAPABLE_SPEC,
  },
  [FALLBACK_KEY]: {
    id: 'test-only-capped-reasoner',
    provider: 'openai',
    displayName: 'Capped Model',
    registryKey: FALLBACK_KEY,
    reasoningEffort: CAPPED_SPEC,
  },
};

function makeTurnBus() {
  const listeners: Record<string, Array<(payload?: unknown) => void>> = {};
  return {
    on(event: string, handler: (payload?: unknown) => void) {
      (listeners[event] ??= []).push(handler);
      return () => {};
    },
    emitTurnError(error: string) {
      for (const h of (listeners['TURN_ERROR'] ?? []).slice()) h({ error } as never);
    },
    emit(event: string) {
      for (const h of (listeners[event] ?? []).slice()) h();
    },
  };
}

function makeToolBus() {
  return { on() { return () => {}; } };
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

/**
 * Wire the module the way main.ts does, with a retryTurn that reproduces the
 * real transcript rollback: everything the failed turn added is dropped, and
 * only the notice handed in is re-posted afterwards.
 */
function wire(requestedEffort: string | undefined) {
  const turns = makeTurnBus();
  let currentKey = CONFIGURED_KEY;
  const transcript: string[] = [];
  const retryNotices: string[] = [];

  const options: WireStreamEventMetricsOptions = {
    events: { turns, tools: makeToolBus() } as unknown as WireStreamEventMetricsOptions['events'],
    orchestrator: { streamingOutputTokens: 0 } as WireStreamEventMetricsOptions['orchestrator'],
    providerRegistry: {
      getCurrentModel: () => MODELS[currentKey]!,
      setCurrentModel: (key: string) => { currentKey = key; },
    } as unknown as WireStreamEventMetricsOptions['providerRegistry'],
    systemMessageRouter: {
      high: (m: string) => { transcript.push(m); },
      low: () => {},
      userReceipt: (m: string) => { transcript.push(m); },
    } as unknown as WireStreamEventMetricsOptions['systemMessageRouter'],
    render: () => {},
    metrics: makeMetrics(),
    failoverState: createFailoverTurnState(),
    getConfiguredRegistryKey: () => CONFIGURED_KEY,
    getConfiguredReasoningEffort: () => requestedEffort,
    providerOptimizer: {
      enabled: true,
      testFallback: () => ({
        chain: [
          { position: 0, providerId: 'anthropic', modelId: 'test-only-capable-reasoner', capable: true },
          { position: 1, providerId: 'openai', modelId: 'test-only-capped-reasoner', capable: true },
        ],
      }),
      recordFallbackTransition: () => {},
      fallbackLog: [],
    } as unknown as WireStreamEventMetricsOptions['providerOptimizer'],
    // The real rollback: the failed turn's transcript additions are erased,
    // then the notice handed in is posted above the re-submitted prompt.
    retryTurn: (notice?: string) => {
      transcript.length = 0;
      if (notice) {
        retryNotices.push(notice);
        transcript.push(notice);
      }
      return true;
    },
  };

  const result = wireStreamEventMetrics(options);
  return { turns, transcript, retryNotices, result, currentKey: () => currentKey };
}

describe('failover onto a model that caps the requested level', () => {
  test('the effort-remap sentence is still in the transcript after the retry rollback', () => {
    const { turns, transcript } = wire('xhigh');

    turns.emitTurnError('rate limit');

    const text = transcript.join('\n');
    expect(text).toContain('[Failover] anthropic -> openai');
    // The sentence the rollback used to delete.
    expect(text).toContain("Reasoning effort 'xhigh' isn't available on Capped Model");
    expect(text).toContain("using 'medium'");
  });

  test('the sentence rides in on the notice handed to retryTurn, not emitted before it', () => {
    const { turns, retryNotices } = wire('xhigh');

    turns.emitTurnError('rate limit');

    expect(retryNotices).toHaveLength(1);
    expect(retryNotices[0]).toContain("isn't available on Capped Model");
  });

  test('no sentence is invented when the fallback model honours the requested level', () => {
    const { turns, transcript } = wire('medium');

    turns.emitTurnError('rate limit');

    const text = transcript.join('\n');
    expect(text).toContain('[Failover] anthropic -> openai');
    expect(text).not.toContain("isn't available");
  });

  test('the requested level is what gets re-resolved, so restoring gets it back', () => {
    const { turns, transcript, currentKey } = wire('xhigh');

    turns.emitTurnError('rate limit');
    expect(currentKey()).toBe(FALLBACK_KEY);

    // Turn ends: serving goes back to the configured model, and the capable
    // model takes 'xhigh' again with nothing to explain away.
    transcript.length = 0;
    turns.emit('TURN_COMPLETED');

    expect(currentKey()).toBe(CONFIGURED_KEY);
    const text = transcript.join('\n');
    expect(text).toContain(`[Failover] Restored ${CONFIGURED_KEY}`);
    expect(text).not.toContain("isn't available");
  });
});
