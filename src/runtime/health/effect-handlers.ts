/**
 * Health Error Propagation — Effect Handlers
 *
 * Implements concrete actions for each CascadeEffect type produced by the
 * CascadeEngine. Each handler is a pure dispatch function — side effects
 * are performed through the provided aggregator and eventBus context.
 *
 * Callers (e.g. HealthStoreWiring) are responsible for iterating over
 * CascadeResult arrays and invoking this function for each result.
 *
 * @module health/effect-handlers
 */

import type { CascadeEffect, CascadeResult } from './types.ts';
import { createCascadeAppliedEvent } from './types.ts';
import type { RuntimeHealthAggregator } from './aggregator.ts';
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../events/index.ts';
import { createEventEnvelope } from '../events/index.ts';
import type { AnyRuntimeEvent } from '../events/index.ts';

/**
 * Emits a synthetic health event on the bus.
 *
 * Health events (e.g. CASCADE_APPLIED) are not part of AnyRuntimeEvent — they live
 * outside the typed domain-event union. This helper centralises the necessary
 * cross-domain cast in a single, documented location rather than duplicating it
 * at each call site.
 */
/**
 * GC-ARCH-002 allowlist: This file is explicitly permitted to call
 * RuntimeEventBus.emit() directly because it emits synthetic health events
 * (CASCADE_APPLIED, EMIT_EVENT effects) that are intentionally outside the
 * AnyRuntimeEvent typed union. The necessary cast is isolated here to avoid
 * duplicating it at every effect-handler call site.
 *
 * Do NOT copy this pattern elsewhere — use typed emitters from
 * src/runtime/emitters/ for all standard domain events.
 */
function emitHealthEvent(
  bus: RuntimeEventBus,
  envelope: RuntimeEventEnvelope<string, unknown>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bus.emit('session', envelope as unknown as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>);
}

/** Context injected into each effect handler. */
export interface EffectHandlerContext {
  /** The health aggregator — used to mark domain state changes. */
  readonly aggregator: RuntimeHealthAggregator;
  /** The event bus — used to emit CASCADE_APPLIED and domain events. */
  readonly eventBus: RuntimeEventBus;
}

/**
 * Dispatches the appropriate runtime action for a given CascadeEffect.
 *
 * Handles all six CascadeEffect variants:
 * - `CANCEL_INFLIGHT` — cancels in-flight operations in the given scope
 * - `BLOCK_DISPATCH` — blocks new dispatch in the given scope (optionally queues)
 * - `MARK_CHILDREN` — marks child tasks/agents as failed or blocked
 * - `DEREGISTER_TOOLS` — deregisters tools, scoped by pluginId from sourceContext
 * - `EMIT_EVENT` — emits a domain event of the given eventType on the bus
 * - `BLOCK_NEW` — blocks new operations of the given scope
 *
 * After applying the effect, emits a `CASCADE_APPLIED` event on the event bus
 * so that other subsystems can observe cascade propagation.
 *
 * @param effect - The CascadeEffect to apply.
 * @param result - The CascadeResult that produced this effect (carries ruleId, source, etc.).
 * @param context - The aggregator and eventBus needed to perform side effects.
 */
export function handleCascadeEffect(
  effect: CascadeEffect,
  result: CascadeResult,
  context: EffectHandlerContext,
): void {
  const { aggregator, eventBus } = context;

  switch (effect.type) {
    case 'CANCEL_INFLIGHT': {
      // Mark the target domain as degraded to signal in-flight cancellation.
      // Actual cancellation of network/async operations is domain-specific;
      // subscribers observing CASCADE_APPLIED will perform the real cancellation.
      if (result.target !== 'ALL') {
        aggregator.updateDomainHealth(result.target, 'degraded', {
          failureReason: `In-flight operations cancelled (scope: ${effect.scope})`,
        });
      }
      break;
    }

    case 'BLOCK_DISPATCH': {
      // Mark the target domain as degraded with the blocked scope noted.
      // If queueable, subscribers may hold and retry; otherwise, they must reject.
      if (result.target !== 'ALL') {
        aggregator.updateDomainHealth(result.target, 'degraded', {
          failureReason: effect.queueable
            ? `Dispatch blocked (scope: ${effect.scope}) — queuing enabled`
            : `Dispatch blocked (scope: ${effect.scope}) — queuing disabled`,
          degradedCapabilities: [effect.scope],
        });
      }
      break;
    }

    case 'MARK_CHILDREN': {
      // Mark child domains as failed or blocked.
      // For 'ALL' target, propagate to tasks and agents as the primary child domains.
      const childDomains =
        result.target === 'ALL'
          ? (['tasks', 'agents'] as const)
          : ([result.target] as const);

      for (const childDomain of childDomains) {
        aggregator.updateDomainHealth(childDomain, 'failed', {
          failureReason: `Marked ${effect.status} by cascade from '${result.source}'${effect.notifyParent ? ' (parent notified)' : ''}`,
        });
      }
      break;
    }

    case 'DEREGISTER_TOOLS': {
      // Signal tool deregistration by marking the toolExecution domain degraded.
      // Subscribers (tool registry) observe CASCADE_APPLIED to perform actual deregistration.
      // If pluginId is in sourceContext, the scope is limited to that plugin's tools.
      const pluginId = result.sourceContext?.['pluginId'];
      const scope = pluginId ? `plugin:${pluginId}` : 'all-plugins';

      if (result.target !== 'ALL') {
        aggregator.updateDomainHealth(result.target, 'degraded', {
          failureReason: `Tools deregistered (${scope})`,
          degradedCapabilities: [`tool-dispatch:${scope}`],
        });
      }
      break;
    }

    case 'EMIT_EVENT': {
      // Emit the specified event type on the bus as a synthetic health event.
      // Since CASCADE_APPLIED is not in AnyRuntimeEvent, we use a cast to
      // emit on the 'session' domain (the most general available routing domain).
      const syntheticEnvelope = createEventEnvelope(
        effect.eventType,
        {
          type: effect.eventType,
          ruleId: result.ruleId,
          source: result.source,
          target: result.target,
          timestamp: result.timestamp,
          sourceContext: result.sourceContext,
        },
        {
          sessionId: result.sourceContext?.['sessionId'] ?? 'runtime',
          source: 'health/effect-handlers',
        },
      );
      emitHealthEvent(eventBus, syntheticEnvelope);
      break;
    }

    case 'BLOCK_NEW': {
      // Block new operations in the given scope by marking target domain degraded.
      if (result.target !== 'ALL') {
        aggregator.updateDomainHealth(result.target, 'degraded', {
          failureReason: `New operations blocked (scope: ${effect.scope})`,
          degradedCapabilities: [effect.scope],
        });
      }
      break;
    }

    default: {
      const _exhaustive: never = effect;
      throw new Error(`Unhandled cascade effect type: ${(effect as { type: string }).type}`);
    }
  }

  // Emit CASCADE_APPLIED event for observability
  const appliedEvent = createCascadeAppliedEvent(result);
  const appliedEnvelope = createEventEnvelope(
    'CASCADE_APPLIED',
    appliedEvent,
    {
      sessionId: result.sourceContext?.['sessionId'] ?? 'runtime',
      source: 'health/effect-handlers',
    },
  );
  emitHealthEvent(eventBus, appliedEnvelope);
}
