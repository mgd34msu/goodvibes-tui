/**
 * Runtime permissions public API barrel.
 *
 * Exports the LayeredPolicyEvaluator, all types, rule evaluators, safety checks,
 * and the createPermissionEvaluator() factory function.
 *
 * Feature flag: `permissions-policy-engine` must be enabled to use this module in production.
 */

export { LayeredPolicyEvaluator } from './evaluator.ts';
export { DecisionLog } from './decision-log.ts';
export { runSafetyChecks } from './safety-checks.ts';
export { PermissionSimulator, SimulationEnforcementError } from './simulation.ts';
export { buildDefaultPolicySimulationScenarios, runPolicySimulationScenarios } from './simulation-scenarios.ts';
export { lintPolicyConfig } from './lint.ts';
export { buildPolicyPreflightReview } from './preflight.ts';
// Policy signing
export { signBundle, verifyBundle, canonicalise } from './policy-signer.ts';
export { loadPolicyBundle, createUnsignedBundle, PolicySignatureError } from './policy-loader.ts';

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
  PermissionsConfig,
  SimulationMode,
  SimulationResult,
  DivergenceType,
  DivergenceRecord,
  DivergenceStats,
  DivergenceReport,
  PermissionSimulatorConfig,
} from './types.ts';

export type { DecisionLogEntry, DecisionLogQuery } from './decision-log.ts';
export type { SafetyCheckResult } from './safety-checks.ts';
export type { PolicyLintFinding, PolicyLintSeverity } from './lint.ts';
export type {
  PolicyPreflightStatus,
  PolicyPreflightServer,
  PolicyPreflightIssue,
  PolicyPreflightReview,
} from './preflight.ts';
export type {
  PolicySimulationScenario,
  PolicySimulationScenarioResult,
  PolicySimulationSummary,
} from './simulation-scenarios.ts';
// Policy signing
export type {
  PolicyBundleId,
  SignatureStatus,
  ProvenanceSource,
  SignedPolicyBundle,
  VerifyResult,
} from './policy-signer.ts';
export type {
  PolicyBundlePayload,
  BundleProvenance,
  PolicyLoadResult,
  PolicyLoaderOptions,
} from './policy-loader.ts';

export {
  evaluatePrefixRule,
  evaluateArgShapeRule,
  evaluatePathScopeRule,
  evaluateNetworkScopeRule,
  evaluateModeConstraintRule,
} from './rules/index.ts';

// Divergence dashboard
export {
  DivergenceDashboard,
  DivergenceGateError,
} from './divergence-dashboard.ts';
export type {
  DivergenceTrendEntry,
  EnforceGateStatus,
  EnforceGateResult,
  DivergenceDashboardSnapshot,
  DivergenceDashboardConfig,
} from './divergence-dashboard.ts';

// Policy-as-Code
export { PolicyRegistry } from './policy-registry.ts';
export {
  PolicyRuntimeState,
  getPolicyRuntimeState,
  resetPolicyRuntimeStateForTests,
} from './policy-runtime.ts';
export type {
  BundleLifecycleState,
  PolicyBundleVersion,
  PolicyDiffResult,
  PromoteResult,
  RollbackResult,
  PolicyRegistryConfig,
} from './policy-registry.ts';

// ── Factory ──────────────────────────────────────────────────────────────────────

import { LayeredPolicyEvaluator } from './evaluator.ts';
import { PermissionSimulator } from './simulation.ts';
import type { PermissionsConfig, SimulationMode, PermissionSimulatorConfig } from './types.ts';
import type { FeatureFlagManager } from '../feature-flags/manager.ts';
import type { BundleProvenance } from './policy-loader.ts';

/**
 * createPermissionEvaluator — Factory function for the runtime permission evaluator.
 *
 * Returns a LayeredPolicyEvaluator configured with the given options.
 * Designed as the primary entry point for integrating the runtime permissions system.
 *
 * The returned evaluator exposes:
 *   - `evaluate(toolName, args)` — perform a full layered evaluation
 *   - `recordSessionOverride(...)` — cache a user prompt response
 *   - `log` — DecisionLog for audit queries
 *   - `getMode()` — inspect the active mode
 *
 * @example
 * ```ts
 * const perms = createPermissionEvaluator({ mode: 'default', rules: [] });
 * const decision = perms.evaluate('write', { path: '/tmp/out.txt' });
 * if (!decision.allowed) {
 *   console.error('denied:', decision.reason);
 * }
 * ```
 *
 * @param config     — Optional configuration; all fields have safe defaults.
 * @param provenance — Optional bundle provenance (GC-PERM-011).
 */
export function createPermissionEvaluator(
  config: PermissionsConfig = {},
  provenance?: BundleProvenance,
): LayeredPolicyEvaluator {
  return new LayeredPolicyEvaluator(config, provenance);
}

/**
 * createPermissionSimulator — Factory for `PermissionSimulator`.
 *
 * Creates a dual-evaluator simulation pipeline for the runtime permissions system that runs
 * both the actual and simulated evaluators in parallel, tracking divergence.
 *
 * Requires the `permissions-simulation` feature flag to be enabled.
 *
 * @param actualConfig    — Config for the authoritative evaluator.
 * @param simulatedConfig — Config for the candidate evaluator.
 * @param simulationMode  — Controls enforcement and warning behaviour.
 * @param config          — Optional tuning: record limit, divergence threshold.
 *
 * @example
 * ```ts
 * const simulator = createPermissionSimulator(
 *   { mode: 'default', rules: currentRules },
 *   { mode: 'default', rules: candidateRules },
 *   'warn-on-divergence',
 * );
 * const result = simulator.evaluate('write', { path: '/tmp/out.txt' });
 * const report = simulator.getDivergenceReport();
 * ```
 */
export function createPermissionSimulator(
  actualConfig: PermissionsConfig,
  simulatedConfig: PermissionsConfig,
  simulationMode: SimulationMode,
  config: PermissionSimulatorConfig = {},
  flagManager?: FeatureFlagManager,
): PermissionSimulator {
  if (flagManager && !flagManager.isEnabled('permissions-simulation')) {
    throw new Error('Feature flag "permissions-simulation" is not enabled');
  }
  return new PermissionSimulator(
    actualConfig,
    simulatedConfig,
    simulationMode,
    config,
  );
}
