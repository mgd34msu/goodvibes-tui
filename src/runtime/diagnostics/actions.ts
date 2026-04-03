/**
 * Diagnostics action system — action dispatch bindings for diagnostic entries.
 *
 * Defines the action types, permission model, and dispatcher that allow
 * one-click remediation from the diagnostics UI. Actions are attached to
 * high-severity diagnostic entries and dispatched through this system,
 * which validates permissions before delegating to the appropriate handler.
 *
 * Supported action targets:
 *  - Load replay: loads a forensics run into the replay engine
 *  - Run policy simulation: triggers a simulation pass for a tool call
 *  - Jump to task: navigates the UI focus to a related task entry
 *  - Jump to agent: navigates the UI focus to a related agent entry
 *  - Jump to tool call: navigates the UI focus to a related tool call entry
 */
import { logger } from '../../utils/logger.ts';
import type { DeterministicReplayEngine } from '../../core/deterministic-replay.ts';
import type { PermissionSimulator } from '../permissions/simulation.ts';
import type { OpsControlPlane } from '../ops/control-plane.ts';

// ── Action type union ─────────────────────────────────────────────────────────

/**
 * Discriminated union of all action kinds that can be attached to a
 * diagnostic entry.
 */
export type DiagnosticActionType =
  | 'load-replay'
  | 'run-policy-simulation'
  | 'jump-to-task'
  | 'jump-to-agent'
  | 'jump-to-tool-call'
  | 'retry-task'
  | 'cancel-task'
  | 'cancel-agent';

// ── Permission tiers ──────────────────────────────────────────────────────────

/**
 * Permission tier required to dispatch an action.
 *
 * - `read` — read-only navigation; no state mutation.
 * - `operator` — state-mutating actions available to operators.
 * - `admin` — destructive or sensitive actions requiring elevated access.
 */
export type DiagnosticActionPermission = 'read' | 'operator' | 'admin';

// ── Action payload shapes ─────────────────────────────────────────────────────

export interface LoadReplayPayload {
  readonly runId: string;
}

export interface RunPolicySimulationPayload {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

export interface JumpToTaskPayload {
  readonly taskId: string;
}

export interface JumpToAgentPayload {
  readonly agentId: string;
}

export interface JumpToToolCallPayload {
  readonly callId: string;
}

export interface RetryTaskPayload {
  readonly taskId: string;
  readonly note?: string;
}

export interface CancelTaskPayload {
  readonly taskId: string;
  readonly note?: string;
}

export interface CancelAgentPayload {
  readonly agentId: string;
  readonly note?: string;
}

export type DiagnosticActionPayload =
  | LoadReplayPayload
  | RunPolicySimulationPayload
  | JumpToTaskPayload
  | JumpToAgentPayload
  | JumpToToolCallPayload
  | RetryTaskPayload
  | CancelTaskPayload
  | CancelAgentPayload;

// ── Action binding ────────────────────────────────────────────────────────────

/** Load-replay action. */
export interface LoadReplayAction {
  readonly type: 'load-replay';
  readonly permission: DiagnosticActionPermission;
  readonly label: string;
  readonly payload: LoadReplayPayload;
}

/** Run-policy-simulation action. */
export interface RunPolicySimulationAction {
  readonly type: 'run-policy-simulation';
  readonly permission: DiagnosticActionPermission;
  readonly label: string;
  readonly payload: RunPolicySimulationPayload;
}

/** Jump-to-task action. */
export interface JumpToTaskAction {
  readonly type: 'jump-to-task';
  readonly permission: DiagnosticActionPermission;
  readonly label: string;
  readonly payload: JumpToTaskPayload;
}

/** Jump-to-agent action. */
export interface JumpToAgentAction {
  readonly type: 'jump-to-agent';
  readonly permission: DiagnosticActionPermission;
  readonly label: string;
  readonly payload: JumpToAgentPayload;
}

/** Jump-to-tool-call action. */
export interface JumpToToolCallAction {
  readonly type: 'jump-to-tool-call';
  readonly permission: DiagnosticActionPermission;
  readonly label: string;
  readonly payload: JumpToToolCallPayload;
}

/** Retry-task action. */
export interface RetryTaskAction {
  readonly type: 'retry-task';
  readonly permission: DiagnosticActionPermission;
  readonly label: string;
  readonly payload: RetryTaskPayload;
}

/** Cancel-task action. */
export interface CancelTaskAction {
  readonly type: 'cancel-task';
  readonly permission: DiagnosticActionPermission;
  readonly label: string;
  readonly payload: CancelTaskPayload;
}

/** Cancel-agent action. */
export interface CancelAgentAction {
  readonly type: 'cancel-agent';
  readonly permission: DiagnosticActionPermission;
  readonly label: string;
  readonly payload: CancelAgentPayload;
}

/**
 * Discriminated union of all actionable bindings that can be attached to a
 * diagnostic entry. TypeScript narrows the payload type via the `type`
 * discriminant, eliminating the need for unsafe `as` casts in the dispatcher.
 */
export type DiagnosticAction =
  | LoadReplayAction
  | RunPolicySimulationAction
  | JumpToTaskAction
  | JumpToAgentAction
  | JumpToToolCallAction
  | RetryTaskAction
  | CancelTaskAction
  | CancelAgentAction;

// ── High-severity diagnostic entry ───────────────────────────────────────────

/**
 * A high-severity diagnostic entry with attached remediation actions.
 *
 * The acceptance criterion requires every high-severity diagnostic to have
 * at least one remediation action. Callers that produce `HighSeverityDiagnostic`
 * values must always supply a non-empty `actions` array.
 */
export interface HighSeverityDiagnostic {
  /** Unique entry identifier (correlation ID). */
  readonly id: string;
  /** Short human-readable description of the problem. */
  readonly summary: string;
  /** Domain this diagnostic originates from. */
  readonly domain: string;
  /** Severity — always 'error' or 'warn' for high-severity entries. */
  readonly severity: 'error' | 'warn';
  /** Epoch ms when this diagnostic was produced. */
  readonly ts: number;
  /** Session identifier for correlation. */
  readonly sessionId: string;
  /** Trace identifier for correlation. */
  readonly traceId: string;
  /**
   * Ordered list of remediation actions.
   * Must be non-empty for high-severity entries.
   */
  readonly actions: readonly [DiagnosticAction, ...DiagnosticAction[]];
}

// ── Action result ─────────────────────────────────────────────────────────────

/**
 * Result returned by the dispatcher after attempting to execute an action.
 */
export interface ActionResult {
  /** Whether the action executed successfully. */
  readonly success: boolean;
  /** Human-readable message describing the outcome. */
  readonly message: string;
  /**
   * Whether the failure was due to a permission check (as opposed to a
   * runtime error in the handler).
   */
  readonly permissionDenied?: boolean;
}

// ── Dispatch context ──────────────────────────────────────────────────────────

/**
 * Navigation callback invoked when a jump action targets a panel entry.
 * The UI registers this callback to implement panel-switching and focus.
 */
export type NavigateToEntryCallback = (
  target: 'task' | 'agent' | 'tool-call',
  id: string,
) => void;

/**
 * Caller-supplied permission check.
 *
 * Receives the required permission tier and returns `true` if the current
 * session/user satisfies that tier. Defaults to allowing 'read' and
 * 'operator' and denying 'admin'.
 */
export type PermissionChecker = (
  required: DiagnosticActionPermission,
) => boolean;

/**
 * Configuration for DiagnosticActionDispatcher.
 *
 * All handler fields are optional. When a handler is absent, dispatching
 * an action of the corresponding type returns a graceful failure result
 * rather than throwing.
 */
export interface DiagnosticActionDispatcherConfig {
  /**
   * Replay engine for 'load-replay' actions.
   * When absent, load-replay actions return an error result.
   */
  readonly replayEngine?: DeterministicReplayEngine;
  /**
   * Permission simulator for 'run-policy-simulation' actions.
   * When absent, policy simulation actions return an error result.
   */
  readonly simulator?: PermissionSimulator;
  /**
   * Ops control plane for 'retry-task', 'cancel-task', 'cancel-agent'.
   * When absent, those actions return an error result.
   */
  readonly controlPlane?: OpsControlPlane;
  /**
   * Navigation callback for 'jump-to-*' actions.
   * When absent, jump actions return a success result with a warning note.
   */
  readonly navigateTo?: NavigateToEntryCallback;
  /**
   * Permission checker invoked before dispatching each action.
   * Defaults to: read=allow, operator=allow, admin=deny.
   */
  readonly checkPermission?: PermissionChecker;
}

// ── Default permission checker ────────────────────────────────────────────────

const DEFAULT_PERMISSION_CHECKER: PermissionChecker = (required) => {
  return required !== 'admin';
};

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * DiagnosticActionDispatcher — executes diagnostic entry actions.
 *
 * Routes incoming DiagnosticAction values to the appropriate handler,
 * performing a permission check before dispatch. All errors are caught
 * and converted to ActionResult failures so callers never receive thrown
 * exceptions from this API.
 *
 * Usage:
 * ```ts
 * const dispatcher = new DiagnosticActionDispatcher({
 *   replayEngine,
 *   simulator,
 *   controlPlane,
 *   navigateTo: (target, id) => focusPanel(target, id),
 * });
 *
 * const result = await dispatcher.dispatch(action);
 * if (!result.success) {
 *   showError(result.message);
 * }
 * ```
 */
export class DiagnosticActionDispatcher {
  private readonly _replayEngine: DeterministicReplayEngine | undefined;
  private readonly _simulator: PermissionSimulator | undefined;
  private readonly _controlPlane: OpsControlPlane | undefined;
  private readonly _navigateTo: NavigateToEntryCallback | undefined;
  private readonly _checkPermission: PermissionChecker;

  constructor(config: DiagnosticActionDispatcherConfig = {}) {
    this._replayEngine = config.replayEngine;
    this._simulator = config.simulator;
    this._controlPlane = config.controlPlane;
    this._navigateTo = config.navigateTo;
    this._checkPermission = config.checkPermission ?? DEFAULT_PERMISSION_CHECKER;
  }

  /**
   * Dispatch a diagnostic action.
   *
   * Performs a permission check, then delegates to the appropriate handler.
   * All handler errors are caught and returned as failure ActionResults.
   *
   * @param action - The action to execute.
   * @returns An ActionResult describing the outcome.
   */
  public async dispatch(action: DiagnosticAction): Promise<ActionResult> {
    // Permission gate
    if (!this._checkPermission(action.permission)) {
      logger.debug('[DiagnosticActionDispatcher] permission denied', {
        type: action.type,
        required: action.permission,
      });
      return {
        success: false,
        message: `Permission denied: '${action.permission}' access required for action '${action.type}'.`,
        permissionDenied: true,
      };
    }

    try {
      return await this._route(action);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('[DiagnosticActionDispatcher] action error', {
        type: action.type,
        err: message,
      });
      return {
        success: false,
        message: `Action '${action.type}' failed: ${message}`,
      };
    }
  }

  private async _route(action: DiagnosticAction): Promise<ActionResult> {
    switch (action.type) {
      case 'load-replay':
        return this._handleLoadReplay(action.payload);

      case 'run-policy-simulation':
        return this._handlePolicySimulation(action.payload);

      case 'jump-to-task':
        return this._handleJump('task', action.payload.taskId);

      case 'jump-to-agent':
        return this._handleJump('agent', action.payload.agentId);

      case 'jump-to-tool-call':
        return this._handleJump('tool-call', action.payload.callId);

      case 'retry-task':
        return this._handleRetryTask(action.payload);

      case 'cancel-task':
        return this._handleCancelTask(action.payload);

      case 'cancel-agent':
        return this._handleCancelAgent(action.payload);

      default: {
        // Exhaustiveness guard — TypeScript will error if a case is missing.
        const exhaustive: never = action;
        return {
          success: false,
          message: `Unknown action type: ${String(exhaustive)}`,
        };
      }
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private _handleLoadReplay(payload: LoadReplayPayload): ActionResult {
    if (!this._replayEngine) {
      return {
        success: false,
        message: 'Replay engine is not available. Attach a DeterministicReplayEngine to the dispatcher.',
      };
    }

    // Reset the engine to 'idle'. The caller is expected to then fetch
    // ledger entries for the given runId and call engine.load(). The
    // ReplayPanel will surface the updated state via subscriber notifications.
    this._replayEngine.reset();

    logger.debug('[DiagnosticActionDispatcher] load-replay requested', {
      runId: payload.runId,
    });

    return {
      success: true,
      message: `Replay engine reset for run '${payload.runId}'. Load the ledger entries to begin stepping.`,
    };
  }

  private _handlePolicySimulation(
    payload: RunPolicySimulationPayload,
  ): ActionResult {
    if (!this._simulator) {
      return {
        success: false,
        message: 'Policy simulator is not available. Attach a PermissionSimulator to the dispatcher.',
      };
    }

    const result = this._simulator.evaluate(payload.toolName, payload.args);

    const diverged = result.diverged;
    const actual = result.actualDecision.allowed ? 'allowed' : 'denied';
    const simulated = result.simulatedDecision.allowed ? 'allowed' : 'denied';

    logger.debug('[DiagnosticActionDispatcher] policy simulation complete', {
      toolName: payload.toolName,
      diverged,
      actual,
      simulated,
    });

    if (diverged) {
      return {
        success: true,
        message: `Policy simulation diverged for '${payload.toolName}': actual=${actual}, simulated=${simulated}.`,
      };
    }

    return {
      success: true,
      message: `Policy simulation for '${payload.toolName}': both evaluators returned ${actual}.`,
    };
  }

  private _handleJump(
    target: 'task' | 'agent' | 'tool-call',
    id: string,
  ): ActionResult {
    if (!this._navigateTo) {
      return {
        success: true,
        message: `Jump to ${target} '${id}' requested but no navigation handler is registered.`,
      };
    }

    this._navigateTo(target, id);

    return {
      success: true,
      message: `Navigated to ${target} '${id}'.`,
    };
  }

  private _handleRetryTask(payload: RetryTaskPayload): ActionResult {
    if (!this._controlPlane) {
      return {
        success: false,
        message: 'Ops control plane is not available. Attach an OpsControlPlane to the dispatcher.',
      };
    }

    if (!this._controlPlane.canRetryTask(payload.taskId)) {
      return {
        success: false,
        message: `Task '${payload.taskId}' cannot be retried in its current state.`,
      };
    }

    this._controlPlane.retryTask(payload.taskId, payload.note);

    return {
      success: true,
      message: `Task '${payload.taskId}' queued for retry.`,
    };
  }

  private _handleCancelTask(payload: CancelTaskPayload): ActionResult {
    if (!this._controlPlane) {
      return {
        success: false,
        message: 'Ops control plane is not available. Attach an OpsControlPlane to the dispatcher.',
      };
    }

    if (!this._controlPlane.canCancelTask(payload.taskId)) {
      return {
        success: false,
        message: `Task '${payload.taskId}' cannot be cancelled in its current state.`,
      };
    }

    this._controlPlane.cancelTask(payload.taskId, payload.note);

    return {
      success: true,
      message: `Task '${payload.taskId}' cancelled.`,
    };
  }

  private _handleCancelAgent(payload: CancelAgentPayload): ActionResult {
    if (!this._controlPlane) {
      return {
        success: false,
        message: 'Ops control plane is not available. Attach an OpsControlPlane to the dispatcher.',
      };
    }

    if (!this._controlPlane.canCancelAgent(payload.agentId)) {
      return {
        success: false,
        message: `Agent '${payload.agentId}' cannot be cancelled in its current state.`,
      };
    }

    this._controlPlane.cancelAgent(payload.agentId, payload.note);

    return {
      success: true,
      message: `Agent '${payload.agentId}' cancelled.`,
    };
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/**
 * Build a 'load-replay' action for a forensics run ID.
 */
export function buildLoadReplayAction(runId: string): DiagnosticAction {
  return {
    label: 'Load Replay',
    type: 'load-replay',
    permission: 'operator',
    payload: { runId },
  };
}

/**
 * Build a 'run-policy-simulation' action for a tool call.
 */
export function buildRunPolicySimulationAction(
  toolName: string,
  args: Record<string, unknown>,
): DiagnosticAction {
  return {
    label: 'Run Policy Simulation',
    type: 'run-policy-simulation',
    permission: 'operator',
    payload: { toolName, args },
  };
}

/**
 * Build a 'jump-to-task' action.
 */
export function buildJumpToTaskAction(taskId: string): DiagnosticAction {
  return {
    label: 'Jump to Task',
    type: 'jump-to-task',
    permission: 'read',
    payload: { taskId },
  };
}

/**
 * Build a 'jump-to-agent' action.
 */
export function buildJumpToAgentAction(agentId: string): DiagnosticAction {
  return {
    label: 'Jump to Agent',
    type: 'jump-to-agent',
    permission: 'read',
    payload: { agentId },
  };
}

/**
 * Build a 'jump-to-tool-call' action.
 */
export function buildJumpToToolCallAction(callId: string): DiagnosticAction {
  return {
    label: 'Jump to Tool Call',
    type: 'jump-to-tool-call',
    permission: 'read',
    payload: { callId },
  };
}

/**
 * Build a 'retry-task' action.
 */
export function buildRetryTaskAction(
  taskId: string,
  note?: string,
): DiagnosticAction {
  return {
    label: 'Retry Task',
    type: 'retry-task',
    permission: 'operator',
    payload: { taskId, note },
  };
}

/**
 * Build a 'cancel-task' action.
 */
export function buildCancelTaskAction(
  taskId: string,
  note?: string,
): DiagnosticAction {
  return {
    label: 'Cancel Task',
    type: 'cancel-task',
    permission: 'operator',
    payload: { taskId, note },
  };
}

/**
 * Build a 'cancel-agent' action.
 */
export function buildCancelAgentAction(
  agentId: string,
  note?: string,
): DiagnosticAction {
  return {
    label: 'Cancel Agent',
    type: 'cancel-agent',
    permission: 'operator',
    payload: { agentId, note },
  };
}

/**
 * Create a HighSeverityDiagnostic from a task failure.
 *
 * Attaches retry and jump-to-task actions. Satisfies the acceptance criterion
 * that every high-severity diagnostic has at least one remediation action.
 */
export function diagnosticFromTaskFailure(opts: {
  taskId: string;
  description: string;
  error: string;
  sessionId: string;
  traceId: string;
  ts: number;
}): HighSeverityDiagnostic {
  return {
    id: `task-failure:${opts.taskId}`,
    summary: `Task failed: ${opts.description} — ${opts.error}`,
    domain: 'tasks',
    severity: 'error',
    ts: opts.ts,
    sessionId: opts.sessionId,
    traceId: opts.traceId,
    actions: [
      buildRetryTaskAction(opts.taskId, 'Diagnostic retry'),
      buildJumpToTaskAction(opts.taskId),
    ],
  };
}

/**
 * Create a HighSeverityDiagnostic from an agent failure.
 *
 * Attaches cancel and jump-to-agent actions.
 */
export function diagnosticFromAgentFailure(opts: {
  agentId: string;
  task: string;
  error: string;
  sessionId: string;
  traceId: string;
  ts: number;
}): HighSeverityDiagnostic {
  return {
    id: `agent-failure:${opts.agentId}`,
    summary: `Agent failed: ${opts.task} — ${opts.error}`,
    domain: 'agents',
    severity: 'error',
    ts: opts.ts,
    sessionId: opts.sessionId,
    traceId: opts.traceId,
    actions: [
      buildCancelAgentAction(opts.agentId, 'Diagnostic cancel'),
      buildJumpToAgentAction(opts.agentId),
    ],
  };
}

/**
 * Create a HighSeverityDiagnostic from a tool contract violation.
 *
 * Attaches a policy simulation action and optionally a jump-to-tool-call action.
 */
export function diagnosticFromToolContractViolation(opts: {
  toolName: string;
  message: string;
  callId?: string;
  sessionId: string;
  traceId: string;
  ts: number;
}): HighSeverityDiagnostic {
  const extra: DiagnosticAction[] = opts.callId
    ? [buildJumpToToolCallAction(opts.callId)]
    : [];
  const actions: readonly [DiagnosticAction, ...DiagnosticAction[]] = [
    buildRunPolicySimulationAction(opts.toolName, {}),
    ...extra,
  ];

  return {
    id: `tool-contract:${opts.toolName}:${opts.ts}`,
    summary: `Tool contract violation: ${opts.toolName} — ${opts.message}`,
    domain: 'tool-contracts',
    severity: 'error',
    ts: opts.ts,
    sessionId: opts.sessionId,
    traceId: opts.traceId,
    actions,
  };
}

/**
 * Create a HighSeverityDiagnostic from a forensics/replay run.
 *
 * Attaches a load-replay action so the operator can step through the run.
 */
export function diagnosticFromForensicsRun(opts: {
  runId: string;
  summary: string;
  sessionId: string;
  traceId: string;
  ts: number;
}): HighSeverityDiagnostic {
  return {
    id: `forensics:${opts.runId}`,
    summary: opts.summary,
    domain: 'forensics',
    severity: 'error',
    ts: opts.ts,
    sessionId: opts.sessionId,
    traceId: opts.traceId,
    actions: [buildLoadReplayAction(opts.runId)],
  };
}
