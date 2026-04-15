/**
 * Runtime permissions public API barrel.
 *
 * Exports the LayeredPolicyEvaluator, all types, rule evaluators, safety checks,
 * and the createPermissionEvaluator() factory function.
 *
 * Feature flag: `permissions-policy-engine` must be enabled to use this module in production.
 */

export { LayeredPolicyEvaluator } from '@pellux/goodvibes-sdk/platform/runtime/permissions/evaluator';
export { DecisionLog } from '@pellux/goodvibes-sdk/platform/runtime/permissions/decision-log';
export { runSafetyChecks } from '@pellux/goodvibes-sdk/platform/runtime/permissions/safety-checks';
export { PermissionSimulator, SimulationEnforcementError } from '@pellux/goodvibes-sdk/platform/runtime/permissions/simulation';
export { buildDefaultPolicySimulationScenarios, runPolicySimulationScenarios } from '@pellux/goodvibes-sdk/platform/runtime/permissions/simulation-scenarios';
export { lintPolicyConfig } from '@pellux/goodvibes-sdk/platform/runtime/permissions/lint';
export { buildPolicyPreflightReview } from './preflight.ts';
export { buildPermissionRuleSuggestions } from './rule-suggestions.ts';
// Policy signing
export { signBundle, verifyBundle, canonicalise } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-signer';
export { loadPolicyBundle, createUnsignedBundle, PolicySignatureError } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-loader';

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
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/types';

export type { DecisionLogEntry, DecisionLogQuery } from '@pellux/goodvibes-sdk/platform/runtime/permissions/decision-log';
export type { SafetyCheckResult } from '@pellux/goodvibes-sdk/platform/runtime/permissions/safety-checks';
export type { PolicyLintFinding, PolicyLintSeverity } from '@pellux/goodvibes-sdk/platform/runtime/permissions/lint';
export type { PermissionRuleSuggestion } from './rule-suggestions.ts';
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
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/simulation-scenarios';
// Policy signing
export type {
  PolicyBundleId,
  SignatureStatus,
  ProvenanceSource,
  SignedPolicyBundle,
  VerifyResult,
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-signer';
export type {
  PolicyBundlePayload,
  BundleProvenance,
  PolicyLoadResult,
  PolicyLoaderOptions,
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-loader';

export {
  evaluatePrefixRule,
  evaluateArgShapeRule,
  evaluatePathScopeRule,
  evaluateNetworkScopeRule,
  evaluateModeConstraintRule,
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/rules/index';

// Divergence dashboard
export {
  DivergenceDashboard,
  DivergenceGateError,
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/divergence-dashboard';
export type {
  DivergenceTrendEntry,
  EnforceGateStatus,
  EnforceGateResult,
  DivergenceDashboardSnapshot,
  DivergenceDashboardConfig,
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/divergence-dashboard';

// Policy-as-Code
export { PolicyRegistry } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-registry';
export {
  PolicyRuntimeState,
} from './policy-runtime.ts';
export type {
  BundleLifecycleState,
  PolicyBundleVersion,
  PolicyDiffResult,
  PromoteResult,
  RollbackResult,
  PolicyRegistryConfig,
} from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-registry';

// ── Factory ──────────────────────────────────────────────────────────────────────

import { LayeredPolicyEvaluator } from '@pellux/goodvibes-sdk/platform/runtime/permissions/evaluator';
import { PermissionSimulator } from '@pellux/goodvibes-sdk/platform/runtime/permissions/simulation';
import type { PermissionsConfig, SimulationMode, PermissionSimulatorConfig } from '@pellux/goodvibes-sdk/platform/runtime/permissions/types';
import type { FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/manager';
import type { BundleProvenance } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-loader';

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
