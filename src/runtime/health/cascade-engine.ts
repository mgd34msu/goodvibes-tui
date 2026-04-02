/**
 * CascadeEngine — evaluates declarative cascade rules against live domain health
 * and determines which effects need to be applied when a domain state changes.
 *
 * The engine is read-only with respect to health state — it evaluates and returns
 * CascadeResult objects; callers are responsible for applying effects.
 */

import type {
  HealthDomain,
  HealthStatus,
  CascadeRule,
  CascadeResult,
  EvaluateResult,
} from './types.ts';
import type { RuntimeHealthAggregator } from './aggregator.ts';

/**
 * Evaluates CascadeRules against live domain health changes.
 * Use checkUpstreamHealth to gate dispatch before executing domain operations.
 */
export class CascadeEngine {
  /** Pre-indexed rules by domain for O(1) lookup */
  private readonly ruleIndex: Map<HealthDomain, CascadeRule[]>;

  constructor(
    private readonly rules: CascadeRule[],
    private readonly aggregator: RuntimeHealthAggregator,
    private readonly clock: () => number = Date.now,
  ) {
    // Pre-index rules by source domain for O(1) lookups
    this.ruleIndex = new Map();
    for (const rule of rules) {
      const existing = this.ruleIndex.get(rule.source) ?? [];
      existing.push(rule);
      this.ruleIndex.set(rule.source, existing);
    }
  }

  /**
   * Evaluate all cascade rules for a domain health transition.
   *
   * Returns an EvaluateResult with two separate arrays:
   * - `cascades`: effects that are actionable now and should be applied immediately.
   * - `pendingRecovery`: rules with recoveryFirst where recovery is still possible;
   *    callers should not apply these yet.
   *
   * @param domain - The domain whose health changed.
   * @param newStatus - The new health status of the domain.
   * @param sourceContext - Optional context identifying the entity that triggered
   *   the change (e.g. `{ pluginId: 'my-plugin' }`). Carried into each CascadeResult.
   */
  evaluate(
    domain: HealthDomain,
    newStatus: HealthStatus,
    sourceContext?: Record<string, string>,
  ): EvaluateResult {
    const matchingRules = this.getRulesForDomain(domain, newStatus);
    const cascades: CascadeResult[] = [];
    const pendingRecovery: CascadeResult[] = [];
    const now = this.clock();

    for (const rule of matchingRules) {
      if (rule.recoveryFirst) {
        const domainHealth = this.aggregator.getDomainHealth(domain);
        const exhausted =
          domainHealth.recoveryAttempts >= domainHealth.maxRecoveryAttempts;

        if (!exhausted) {
          // Recovery still possible — do not cascade yet
          pendingRecovery.push({
            ruleId: rule.id,
            source: domain,
            target: rule.target,
            effect: rule.effect,
            timestamp: now,
            recoveryExhausted: false,
            sourceContext,
          });
          continue;
        }

        // Recovery exhausted — cascade now, mark recoveryExhausted: true
        cascades.push({
          ruleId: rule.id,
          source: domain,
          target: rule.target,
          effect: rule.effect,
          timestamp: now,
          recoveryExhausted: true,
          sourceContext,
        });
        continue;
      }

      cascades.push({
        ruleId: rule.id,
        source: domain,
        target: rule.target,
        effect: rule.effect,
        timestamp: now,
        recoveryExhausted: false,
        sourceContext,
      });
    }

    return { cascades, pendingRecovery };
  }

  /**
   * Get all rules that would fire for the given domain + status combination.
   * Uses the pre-indexed rule map for O(1) domain lookup.
   * Pure — no side effects.
   */
  getRulesForDomain(domain: HealthDomain, status: HealthStatus): CascadeRule[] {
    const domainRules = this.ruleIndex.get(domain) ?? [];
    return domainRules.filter((rule) => rule.sourceState === status);
  }

  /**
   * Check whether a domain's upstream dependencies are healthy enough to allow dispatch.
   * Traverses the cascade rules in reverse: finds rules whose TARGET is this domain
   * and whose SOURCE is currently in the triggering state.
   *
   * Returns whether dispatch is healthy, which upstream domains are blocking it,
   * and a human-readable reason if blocked.
   */
  checkUpstreamHealth(
    domain: HealthDomain,
  ): { healthy: boolean; blockedBy?: HealthDomain[]; reason?: string } {
    const blockingDomains: HealthDomain[] = [];

    for (const rule of this.rules) {
      // A rule blocks 'domain' if its target is this domain (or ALL)
      // and the source domain is currently in the rule's triggering state
      const targetsThisDomain =
        rule.target === domain || rule.target === 'ALL';

      if (!targetsThisDomain) continue;

      // Only blocking effects count as upstream blockers
      const isBlockingEffect =
        rule.effect.type === 'BLOCK_DISPATCH' ||
        rule.effect.type === 'CANCEL_INFLIGHT' ||
        rule.effect.type === 'BLOCK_NEW';

      if (!isBlockingEffect) continue;

      const sourceHealth = this.aggregator.getDomainHealth(rule.source);
      if (sourceHealth.status === rule.sourceState) {
        blockingDomains.push(rule.source);
      }
    }

    if (blockingDomains.length === 0) {
      return { healthy: true };
    }

    return {
      healthy: false,
      blockedBy: blockingDomains,
      reason: `Domain '${domain}' is blocked by upstream failure in: ${blockingDomains.join(', ')}`,
    };
  }
}
