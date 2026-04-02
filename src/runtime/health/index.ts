/**
 * Runtime health monitoring system — barrel exports and factory.
 *
 * Usage:
 * ```ts
 * import { createHealthSystem } from './health/index.ts';
 * const { aggregator, cascadeEngine } = createHealthSystem();
 * ```
 */

export type {
  HealthStatus,
  HealthDomain,
  DomainHealth,
  CompositeHealth,
  CascadeEffect,
  CascadeRule,
  CascadeResult,
  EvaluateResult,
  CascadeAppliedEvent,
} from './types.ts';
export { createCascadeAppliedEvent } from './types.ts';

export { RuntimeHealthAggregator } from './aggregator.ts';
export { CascadeEngine } from './cascade-engine.ts';
export { CASCADE_RULES } from './cascade-rules.ts';

import { RuntimeHealthAggregator } from './aggregator.ts';
import { CascadeEngine } from './cascade-engine.ts';
import { CASCADE_RULES } from './cascade-rules.ts';

/**
 * Factory function that creates a fully wired health monitoring system.
 * The CascadeEngine is pre-loaded with all cascade rules from the rules table.
 *
 * @returns aggregator for tracking domain health, and cascadeEngine for evaluating cascades.
 */
export function createHealthSystem(): {
  aggregator: RuntimeHealthAggregator;
  cascadeEngine: CascadeEngine;
} {
  const aggregator = new RuntimeHealthAggregator();
  const cascadeEngine = new CascadeEngine(CASCADE_RULES, aggregator);
  return { aggregator, cascadeEngine };
}
