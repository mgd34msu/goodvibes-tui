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
} from '@pellux/goodvibes-sdk/platform/runtime/health/types';
export { createCascadeAppliedEvent } from '@pellux/goodvibes-sdk/platform/runtime/health/types';

export { RuntimeHealthAggregator } from '@pellux/goodvibes-sdk/platform/runtime/health/aggregator';
export { CascadeEngine } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-engine';
export { CASCADE_RULES } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-rules';
export { HealthStoreWiring } from './wiring.ts';
export { handleCascadeEffect } from './effect-handlers.ts';
export type { EffectHandlerContext } from './effect-handlers.ts';
export { CascadeTimer, deriveCascadeSeverity } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-timing';
export type { CascadeSeverity, TimedCascadeResult, TimedEvaluateResult } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-timing';
export { CASCADE_PLAYBOOK_MAP, ALL_CASCADE_RULE_IDS } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-playbook-map';

import { RuntimeHealthAggregator } from '@pellux/goodvibes-sdk/platform/runtime/health/aggregator';
import { CascadeEngine } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-engine';
import { CASCADE_RULES } from '@pellux/goodvibes-sdk/platform/runtime/health/cascade-rules';
import { HealthStoreWiring } from './wiring.ts';

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

/**
 * Factory function that creates a fully wired health monitoring system
 * with error propagation connected to the event bus.
 *
 * @param eventBus - The RuntimeEventBus to receive CASCADE_APPLIED events.
 * @returns aggregator, cascadeEngine, and the wiring controller.
 */
export function createWiredHealthSystem(eventBus: import('../events/index.ts').RuntimeEventBus): {
  aggregator: RuntimeHealthAggregator;
  cascadeEngine: CascadeEngine;
  wiring: HealthStoreWiring;
} {
  const aggregator = new RuntimeHealthAggregator();
  const cascadeEngine = new CascadeEngine(CASCADE_RULES, aggregator);
  const wiring = new HealthStoreWiring(aggregator, cascadeEngine, eventBus);
  return { aggregator, cascadeEngine, wiring };
}
