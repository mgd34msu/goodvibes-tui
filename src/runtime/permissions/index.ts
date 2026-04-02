/**
 * Permissions v2 — Public API barrel.
 *
 * Exports the LayeredPolicyEvaluator, all types, rule evaluators, safety checks,
 * and the createPermissionsV2() factory function.
 *
 * Feature flag: `permissions-v2` must be enabled to use this module in production.
 */

export { LayeredPolicyEvaluator } from './evaluator.ts';
export { DecisionLog } from './decision-log.ts';
export { runSafetyChecks } from './safety-checks.ts';

export type {
  PermissionMode,
  CommandClassification,
  DecisionReason,
  SourceLayer,
  EvaluationStep,
  PermissionDecision,
  PolicyRule,
  PrefixRule,
  ArgShapeRule,
  PathScopeRule,
  NetworkScopeRule,
  ModeConstraintRule,
  RuleOrigin,
  PermissionsV2Config,
} from './types.ts';

export type { DecisionLogEntry, DecisionLogQuery } from './decision-log.ts';
export type { SafetyCheckResult } from './safety-checks.ts';

export {
  evaluatePrefixRule,
  evaluateArgShapeRule,
  evaluatePathScopeRule,
  evaluateNetworkScopeRule,
  evaluateModeConstraintRule,
} from './rules/index.ts';

// ── Factory ──────────────────────────────────────────────────────────────────────

import { LayeredPolicyEvaluator } from './evaluator.ts';
import type { PermissionsV2Config } from './types.ts';

/**
 * createPermissionsV2 — Factory function for the v2 permission evaluator.
 *
 * Returns a LayeredPolicyEvaluator configured with the given options.
 * Designed as the primary entry point for integrating Permissions v2.
 *
 * The returned evaluator exposes:
 *   - `evaluate(toolName, args)` — perform a full layered evaluation
 *   - `recordSessionOverride(...)` — cache a user prompt response
 *   - `log` — DecisionLog for audit queries
 *   - `getMode()` — inspect the active mode
 *
 * @example
 * ```ts
 * const perms = createPermissionsV2({ mode: 'default', rules: [] });
 * const decision = perms.evaluate('write', { path: '/tmp/out.txt' });
 * if (!decision.allowed) {
 *   console.error('denied:', decision.reason);
 * }
 * ```
 *
 * @param config — Optional configuration; all fields have safe defaults.
 */
export function createPermissionsV2(
  config: PermissionsV2Config = {},
): LayeredPolicyEvaluator {
  return new LayeredPolicyEvaluator(config);
}
