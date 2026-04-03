/**
 * CascadeTimer — timing instrumentation for cascade rule evaluations.
 *
 * Wraps CascadeEngine.evaluate() to measure evaluation latency and attach
 * timing metadata (latencyMs, severity, remediationPlaybookIds) to each
 * CascadeResult before returning them to callers.
 *
 * The timer is transparent to the cascade engine — it delegates evaluation
 * and annotates results without modifying engine state.
 */

import type { HealthDomain, HealthStatus, CascadeResult, EvaluateResult } from './types.ts';
import type { CascadeEngine } from './cascade-engine.ts';
import { CASCADE_PLAYBOOK_MAP } from './cascade-playbook-map.ts';

/**
 * Severity tier derived from cascaded effect type and recovery state.
 *
 * - 'critical': session unrecoverable or all-domain block
 * - 'high':     blocking or cancellation effects without recovery first
 * - 'medium':   blocking effects with recovery exhausted
 * - 'low':      emit-only or informational effects
 */
export type CascadeSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Derive a severity level from a cascade result's effect type and recovery state.
 */
export function deriveCascadeSeverity(result: CascadeResult): CascadeSeverity {
  const { effect, target } = result;

  // Session unrecoverable cascades to ALL — always critical
  if (effect.type === 'EMIT_EVENT' && effect.eventType === 'SESSION_UNRECOVERABLE') {
    return 'critical';
  }
  if (target === 'ALL') {
    return 'critical';
  }

  switch (effect.type) {
    case 'CANCEL_INFLIGHT':
    case 'BLOCK_NEW':
      return 'high';

    case 'BLOCK_DISPATCH':
      return result.recoveryExhausted ? 'medium' : 'high';

    case 'MARK_CHILDREN':
      return 'high';

    case 'DEREGISTER_TOOLS':
      return 'medium';

    case 'EMIT_EVENT':
      return 'low';

    default:
      return 'low';
  }
}

/**
 * A CascadeResult annotated with timing and remediation metadata.
 */
export interface TimedCascadeResult extends CascadeResult {
  /** Wall-clock latency of the cascade rule evaluation in milliseconds. */
  readonly latencyMs: number;
  /** Severity tier derived from the cascade effect and recovery state. */
  readonly severity: CascadeSeverity;
  /** Playbook IDs that provide remediation for this cascade type. */
  readonly remediationPlaybookIds: readonly string[];
}

/**
 * EvaluateResult variant where all results carry timing metadata.
 */
export interface TimedEvaluateResult {
  readonly cascades: TimedCascadeResult[];
  readonly pendingRecovery: TimedCascadeResult[];
  /** Total wall-clock latency of the full evaluation in milliseconds. */
  readonly totalLatencyMs: number;
}

/**
 * Annotate a CascadeResult with timing and remediation metadata.
 */
function annotate(result: CascadeResult, latencyMs: number): TimedCascadeResult {
  return {
    ...result,
    latencyMs,
    severity: deriveCascadeSeverity(result),
    remediationPlaybookIds: CASCADE_PLAYBOOK_MAP.get(result.ruleId) ?? [],
  };
}

/**
 * CascadeTimer — instruments CascadeEngine.evaluate() with latency tracking.
 *
 * Wrap the cascade engine with this class to get TimedCascadeResult objects
 * that include per-result latency, severity, and remediation playbook IDs.
 *
 * @example
 * ```ts
 * const timer = new CascadeTimer(cascadeEngine);
 * const { cascades, totalLatencyMs } = timer.evaluate('mcp', 'failed');
 * // cascades[0].latencyMs — evaluation latency
 * // cascades[0].severity  — 'high' | 'critical' etc.
 * // cascades[0].remediationPlaybookIds — ['reconnect-failure']
 * ```
 */
export class CascadeTimer {
  constructor(
    private readonly engine: CascadeEngine,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Evaluate cascade rules for a domain health transition, measuring latency.
   *
   * Each returned result is annotated with:
   * - `latencyMs`: wall-clock cost of evaluating this specific domain+status pair
   * - `severity`: derived criticality tier
   * - `remediationPlaybookIds`: playbook IDs mapped for this rule
   *
   * @param domain - The domain whose health changed.
   * @param newStatus - The new health status.
   * @param sourceContext - Optional entity context (e.g. `{ pluginId }`).
   */
  evaluate(
    domain: HealthDomain,
    newStatus: HealthStatus,
    sourceContext?: Record<string, string>,
  ): TimedEvaluateResult {
    const start = this.clock();
    const result: EvaluateResult = this.engine.evaluate(domain, newStatus, sourceContext);
    const end = this.clock();
    const totalLatencyMs = end - start;

    return {
      cascades: result.cascades.map((r) => annotate(r, totalLatencyMs)),
      pendingRecovery: result.pendingRecovery.map((r) => annotate(r, totalLatencyMs)),
      totalLatencyMs,
    };
  }
}
