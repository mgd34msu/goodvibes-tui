/**
 * Permissions domain state — tracks the permission mode, session approvals,
 * and the most recent permission decision with full audit trail.
 */

import type { PermissionCategory } from '../../../permissions/manager.ts';

/** Permission evaluation modes (maps to PermissionsToolConfig). */
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'allow-all'
  | 'custom'
  | 'background-restricted';

/** States for the permission decision machine. */
export type PermissionDecisionMachineState =
  | 'collect_rules'
  | 'normalize_input'
  | 'evaluate_policy'
  | 'evaluate_runtime_mode'
  | 'evaluate_session_override'
  | 'final_safety_checks'
  | 'decision_emitted';

/** The outcome of a permission decision. */
export type PermissionDecisionOutcome = 'approved' | 'denied' | 'deferred';

/** Source layer that determined the permission outcome. */
export type PermissionSourceLayer =
  | 'config_policy'
  | 'runtime_mode'
  | 'session_override'
  | 'safety_check'
  | 'user_prompt';

/** Reason codes for a permission decision. */
export type PermissionDecisionReason =
  | 'config_allow'
  | 'config_deny'
  | 'mode_allow_all'
  | 'mode_plan_deny'
  | 'mode_background_restricted'
  | 'session_cached_approval'
  | 'session_cached_denial'
  | 'safety_guardrail'
  | 'user_approved'
  | 'user_denied';

/** Full record of the most recent permission decision. */
export interface PermissionDecision {
  /** Tool call ID this decision is for. */
  callId: string;
  /** Tool name. */
  toolName: string;
  /** Permission category. */
  category: PermissionCategory;
  /** State machine state when the decision was emitted. */
  machineState: PermissionDecisionMachineState;
  /** Final outcome. */
  outcome: PermissionDecisionOutcome;
  /** Primary reason code. */
  reason: PermissionDecisionReason;
  /** Source layer that yielded the decision. */
  sourceLayer: PermissionSourceLayer;
  /** Whether the decision was persisted to session approvals. */
  persisted: boolean;
  /** Epoch ms when the decision was emitted. */
  decidedAt: number;
}

/**
 * PermissionDomainState — permission configuration and decision state.
 */
export interface PermissionDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Mode ───────────────────────────────────────────────────────────────────
  /** Current global permission mode. */
  mode: PermissionMode;
  /** Whether the user is currently being prompted for a permission decision. */
  awaitingDecision: boolean;
  /** Current state of the decision state machine (while a decision is in flight). */
  decisionMachineState?: PermissionDecisionMachineState;

  // ── Session approvals ──────────────────────────────────────────────────────
  /**
   * Per-session tool approval cache.
   * Key format: "<toolName>:<argsHash>" → boolean (approved/denied).
   */
  sessionApprovals: Map<string, boolean>;
  /** Number of approvals granted this session. */
  approvalCount: number;
  /** Number of denials issued this session. */
  denialCount: number;

  // ── Last decision ──────────────────────────────────────────────────────────
  /** The most recent permission decision record. */
  lastDecision?: PermissionDecision;

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Total permission checks performed this session. */
  totalChecks: number;
  /** Total checks that were served from session cache. */
  cachedChecks: number;
}

/**
 * Returns the default initial state for the permissions domain.
 */
export function createInitialPermissionsState(): PermissionDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    mode: 'default',
    awaitingDecision: false,
    decisionMachineState: undefined,
    sessionApprovals: new Map(),
    approvalCount: 0,
    denialCount: 0,
    lastDecision: undefined,
    totalChecks: 0,
    cachedChecks: 0,
  };
}
