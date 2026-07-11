import type { Orchestrator } from '../core/orchestrator.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { SessionLineageTracker } from '@pellux/goodvibes-sdk/platform/core';
import type { ContextAccountingSource } from '@pellux/goodvibes-sdk/platform/tools';

/**
 * Minimal runtime-bus surface this module needs: subscribe by event type.
 * A narrow structural type (not the full RuntimeEventBus) so this module
 * doesn't pull in `runtime/index.ts` — bootstrap.ts imports this module
 * directly, and index.ts re-exports bootstrap.ts, so a barrel import here
 * would be a 3-file cycle (see check-architecture.ts's cycle detector).
 */
export interface CompactionActivityBus {
  on(eventType: string, callback: () => void): () => void;
}

/**
 * Builds the interactive session's ContextAccountingSource — the honest
 * backing for the SDK's `context_accounting` tool. Bound onto
 * `RuntimeServices.contextAccountingHolder` once, at bootstrap (see
 * bootstrap.ts, right after the live Orchestrator is constructed).
 *
 * Every field here reads a REAL, already-tracked value:
 *  - getTurnInjections()  → Orchestrator.getTurnInjections() (the same bounded
 *    ring `/recall injections` renders from).
 *  - getTokenState()      → Orchestrator.usage / lastInputTokens (the same
 *    counters the footer's context bar and CostTrackerPanel read), plus the
 *    current model's context window from the provider registry.
 *  - getCompactionState()  → compactionCount from SessionLineageTracker (the
 *    same counter session-maintenance and /compact read); isCompacting is
 *    tracked from real 'compaction' domain lifecycle events on the runtime
 *    bus, since the Orchestrator has no public accessor for it — NOT
 *    fabricated. Without a runtime bus (headless/test callers), isCompacting
 *    honestly stays false rather than guessing.
 */
export interface ContextAccountingSourceDeps {
  readonly orchestrator: Pick<Orchestrator, 'getTurnInjections' | 'usage' | 'lastInputTokens'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getContextWindowForModel'>;
  readonly sessionLineageTracker: Pick<SessionLineageTracker, 'getCompactionCount'>;
  readonly runtimeBus?: CompactionActivityBus | null | undefined;
  readonly sessionId: string;
  /** Human-readable scope label, e.g. "main session". Defaults to 'main session'. */
  readonly scope?: string | undefined;
}

/** Events that mark a compaction run starting. */
const COMPACTION_START_EVENT_TYPES = [
  'COMPACTION_AUTOCOMPACT',
  'COMPACTION_REACTIVE',
  'COMPACTION_MICROCOMPACT',
  'COMPACTION_COLLAPSE',
] as const;

/** Events that mark a compaction run ending (successfully, rejected, or failed). */
const COMPACTION_END_EVENT_TYPES = [
  'COMPACTION_DONE',
  'COMPACTION_FAILED',
  'COMPACTION_RECEIPT',
] as const;

export interface ContextAccountingSourceHandle {
  readonly source: ContextAccountingSource;
  /** Unsubscribe the compaction-activity listeners. Call on session teardown. */
  readonly dispose: () => void;
}

export function createContextAccountingSource(deps: ContextAccountingSourceDeps): ContextAccountingSourceHandle {
  let isCompacting = false;
  const unsubs: Array<() => void> = [];
  if (deps.runtimeBus) {
    const bus = deps.runtimeBus;
    for (const type of COMPACTION_START_EVENT_TYPES) {
      unsubs.push(bus.on(type, () => { isCompacting = true; }));
    }
    for (const type of COMPACTION_END_EVENT_TYPES) {
      unsubs.push(bus.on(type, () => { isCompacting = false; }));
    }
  }

  const source: ContextAccountingSource = {
    scope: deps.scope ?? 'main session',
    sessionId: deps.sessionId,
    getTurnInjections: () => deps.orchestrator.getTurnInjections(),
    getTokenState: () => {
      const currentModel = deps.providerRegistry.getCurrentModel();
      const contextWindow = deps.providerRegistry.getContextWindowForModel(currentModel);
      return {
        measured: { ...deps.orchestrator.usage },
        lastInputTokens: deps.orchestrator.lastInputTokens,
        contextWindow: contextWindow > 0 ? contextWindow : null,
      };
    },
    getCompactionState: () => ({
      isCompacting,
      compactionCount: deps.sessionLineageTracker.getCompactionCount(),
    }),
  };

  return {
    source,
    dispose: () => { for (const unsub of unsubs) unsub(); },
  };
}
