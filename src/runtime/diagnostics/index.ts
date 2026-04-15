/**
 * Diagnostics system — barrel re-exports and factory.
 *
 * This module provides the public API for the runtime diagnostics system.
 * Import from here to access types, providers, and the factory function.
 *
 * Usage:
 * ```ts
 * import { createDiagnosticsProvider } from '../runtime/diagnostics/index.ts';
 *
 * const provider = createDiagnosticsProvider({
 *   eventBus,
 *   healthAggregator,
 *   domains: [...],
 * });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  DiagnosticFilter,
  DiagnosticLevel,
  PanelConfig,
  ToolCallEntry,
  ToolCallPhase,
  ToolCallPermission,
  AgentEntry,
  AgentDiagnosticState,
  TaskEntry,
  EventEntry,
  DomainStateEntry,
  RuntimeStateSnapshot,
  DomainHealthSummary,
  HealthDashboardData,
} from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/types';
export { DEFAULT_BUFFER_LIMIT, DEFAULT_PANEL_CONFIG, applyFilter, appendBounded } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/types';

// ── Action system ────────────────────────────────────────────────────────────
export type {
  DiagnosticActionType,
  DiagnosticActionPermission,
  DiagnosticActionPayload,
  DiagnosticAction,
  HighSeverityDiagnostic,
  ActionResult,
  NavigateToEntryCallback,
  PermissionChecker,
  DiagnosticActionDispatcherConfig,
  LoadReplayPayload,
  RunPolicySimulationPayload,
  JumpToTaskPayload,
  JumpToAgentPayload,
  JumpToToolCallPayload,
  RetryTaskPayload,
  CancelTaskPayload,
  CancelAgentPayload,
} from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/actions';
export {
  DiagnosticActionDispatcher,
  buildLoadReplayAction,
  buildRunPolicySimulationAction,
  buildJumpToTaskAction,
  buildJumpToAgentAction,
  buildJumpToToolCallAction,
  buildRetryTaskAction,
  buildCancelTaskAction,
  buildCancelAgentAction,
  diagnosticFromTaskFailure,
  diagnosticFromAgentFailure,
  diagnosticFromToolContractViolation,
  diagnosticFromForensicsRun,
} from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/actions';

// ── Panel data providers ─────────────────────────────────────────────────────
export { ToolCallsPanel } from './panels/tool-calls.ts';
export { AgentsPanel } from './panels/agents.ts';
export { TasksPanel } from './panels/tasks.ts';
export { EventsPanel } from './panels/events.ts';
export { StateInspectorPanel } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/panels/state-inspector';
export type { InspectableDomain } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/panels/state-inspector';
export { HealthPanel } from './panels/health.ts';

// ── Provider ─────────────────────────────────────────────────────────────────
export { DiagnosticsProvider } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/provider';
export type { DiagnosticsProviderConfig, DiagnosticPanelName } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/provider';

// ── Factory ───────────────────────────────────────────────────────────────────
import { DiagnosticsProvider, type DiagnosticsProviderConfig } from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/provider';

/**
 * Factory function that creates a fully wired DiagnosticsProvider.
 *
 * @param config - Configuration including the event bus, health aggregator,
 *   optional domain adapters, and optional per-panel buffer config.
 * @returns A ready-to-use DiagnosticsProvider.
 */
export function createDiagnosticsProvider(config: DiagnosticsProviderConfig): DiagnosticsProvider {
  return new DiagnosticsProvider(config);
}
