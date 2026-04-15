/**
 * Health Error Propagation — HealthStoreWiring
 *
 * Wires together the RuntimeHealthAggregator, CascadeEngine, and RuntimeEventBus
 * to form a complete error-propagation pipeline. When a domain health status
 * changes, the wiring evaluates cascade rules and applies their effects.
 *
 * Lifecycle:
 * 1. Call `start()` to subscribe to aggregator health changes.
 * 2. Call `evaluateDomain()` to push a domain health update and trigger cascades.
 * 3. Call `stop()` to unsubscribe and release all listeners.
 *
 * @module health/wiring
 */

import type { HealthDomain, HealthStatus } from '@pellux/goodvibes-sdk/platform/runtime/health/types';
import type { RuntimeHealthAggregator } from '@pellux/goodvibes-sdk/platform/runtime/health/aggregator';
import type { CascadeEngine } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-engine';
import type { RuntimeEventBus } from '../events/index.ts';
import { handleCascadeEffect } from './effect-handlers.ts';

/**
 * Wires the health aggregator, cascade engine, and event bus together.
 *
 * Orchestrates the full error-propagation pipeline:
 * domain health change → cascade evaluation → effect application → event emission.
 */
export class HealthStoreWiring {
  private unsubscribe: (() => void) | null = null;

  /**
   * @param aggregator - Tracks per-domain health; source of health change events.
   * @param cascadeEngine - Evaluates declarative cascade rules against domain health.
   * @param eventBus - Receives CASCADE_APPLIED and synthetic domain events.
   */
  constructor(
    private readonly aggregator: RuntimeHealthAggregator,
    private readonly cascadeEngine: CascadeEngine,
    private readonly eventBus: RuntimeEventBus,
  ) {}

  /**
   * Start listening to aggregator health changes.
   *
   * When any domain health changes (detected via aggregator subscribers),
   * the cascade engine is not automatically re-evaluated for subscriber-driven
   * changes — callers should use `evaluateDomain()` for explicit cascade evaluation.
   *
   * Calling `start()` on an already-started wiring replaces the existing
   * subscription without leaking the old one.
   */
  start(): void {
    // Release any existing subscription before re-subscribing
    this.unsubscribe?.();
    // Subscribe to aggregator for observability (e.g. external monitoring).
    // The primary cascade pipeline is driven by evaluateDomain() calls.
    this.unsubscribe = this.aggregator.subscribe((health) => {
      // Log health state transitions for observability.
      // The primary cascade pipeline is driven by evaluateDomain() calls;
      // this subscription provides a secondary audit trail for monitoring.
      const failed = health.failedDomains;
      const degraded = health.degradedDomains;
      if (failed.length > 0 || degraded.length > 0) {
        // Emit health state to stderr for observability — lightweight, no logger import needed
        process.stderr.write(
          `[health] overall=${health.overall} failed=[${failed.join(',')}] degraded=[${degraded.join(',')}]\n`,
        );
      }
    });
  }

  /**
   * Stop listening to aggregator health changes and release all resources.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Update a domain's health status and evaluate cascade rules.
   *
   * Pipeline:
   * 1. Update the domain health in the aggregator.
   * 2. Evaluate cascade rules for the new domain + status.
   * 3. Apply all actionable cascade effects via effect handlers.
   *    Pending-recovery effects are NOT applied — they await recovery exhaustion.
   *
   * @param domain - The domain whose health has changed.
   * @param status - The new health status for the domain.
   * @param sourceContext - Optional context identifying the triggering entity
   *   (e.g. `{ pluginId: 'my-plugin' }`). Propagated into CascadeResult.
   */
  evaluateDomain(
    domain: HealthDomain,
    status: HealthStatus,
    sourceContext?: Record<string, string>,
  ): void {
    // 1. Update domain health in the aggregator
    this.aggregator.updateDomainHealth(domain, status);

    // 2. Evaluate cascade rules for this domain transition
    const { cascades } = this.cascadeEngine.evaluate(domain, status, sourceContext);

    // 3. Apply each actionable cascade effect
    for (const cascade of cascades) {
      handleCascadeEffect(cascade.effect, cascade, {
        aggregator: this.aggregator,
        eventBus: this.eventBus,
      });
    }
  }
}
