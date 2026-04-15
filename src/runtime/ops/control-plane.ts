/**
 * OpsControlPlane — central dispatch point for all operator interventions.
 *
 * All task and agent control actions flow through this class. It:
 * - Validates that the requested action is legal given the current state
 * - Dispatches through the TaskManager (for task ops) or store (for agent ops)
 * - Emits typed audit events via the RuntimeEventBus for every intervention
 *
 * This is the single integration point for the /ops commands and Ctrl+O panel.
 */
import { randomUUID } from 'node:crypto';
import type { TaskManager } from '@pellux/goodvibes-sdk/platform/runtime/tasks/types';
import type { RuntimeEventBus } from '../events/index.ts';
import { createDomainDispatch } from '../store/index.ts';
import type { RuntimeStore, DomainDispatch } from '../store/index.ts';
import type { TaskLifecycleState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import type { AgentLifecycleState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/agents';
import { canTransition } from '@pellux/goodvibes-sdk/platform/runtime/tasks/lifecycle';
import {
  emitOpsTaskCancelled,
  emitOpsTaskPaused,
  emitOpsTaskResumed,
  emitOpsTaskRetried,
  emitOpsAgentCancelled,
} from '../emitters/ops.ts';
import type { OpsInterventionReason } from '@pellux/goodvibes-sdk/platform/runtime/events/ops';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when an ops action is rejected because the state machine disallows it. */
export class OpsIllegalActionError extends Error {
  public readonly targetId: string;
  public readonly action: string;
  public readonly currentState: string;

  public constructor(targetId: string, action: string, currentState: string) {
    super(
      `[OpsControlPlane] Action '${action}' is illegal for ${targetId} in state '${currentState}'`
    );
    this.name = 'OpsIllegalActionError';
    this.targetId = targetId;
    this.action = action;
    this.currentState = currentState;
  }
}

/** Thrown when the target task or agent is not found. */
export class OpsTargetNotFoundError extends Error {
  public readonly targetId: string;
  public readonly targetKind: 'task' | 'agent';

  public constructor(targetId: string, targetKind: 'task' | 'agent') {
    super(`[OpsControlPlane] ${targetKind} not found: ${targetId}`);
    this.name = 'OpsTargetNotFoundError';
    this.targetId = targetId;
    this.targetKind = targetKind;
  }
}

// ---------------------------------------------------------------------------
// OpsControlPlane
// ---------------------------------------------------------------------------

/**
 * Task states from which a retry is permitted.
 */
const RETRYABLE_STATES: ReadonlySet<TaskLifecycleState> = new Set(['failed', 'cancelled']);

/**
 * Terminal agent lifecycle states — agents in these states cannot be cancelled.
 */
const TERMINAL_AGENT_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Agent states from which cancellation is permitted.
 */
const CANCELLABLE_AGENT_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  'spawning',
  'running',
  'awaiting_message',
  'awaiting_tool',
  'finalizing',
]);

export class OpsControlPlane {
  private readonly _taskManager: TaskManager;
  private readonly _bus: RuntimeEventBus;
  private readonly _store: RuntimeStore;
  private readonly _dispatch: DomainDispatch;
  private readonly _sessionId: string;

  public constructor(
    taskManager: TaskManager,
    bus: RuntimeEventBus,
    store: RuntimeStore,
    sessionId: string
  ) {
    this._taskManager = taskManager;
    this._bus = bus;
    this._store = store;
    this._dispatch = createDomainDispatch(store);
    this._sessionId = sessionId;
  }

  // ── Task actions ──────────────────────────────────────────────────────────

  /**
   * Cancel a task. Only legal from states that allow → cancelled transition.
   *
   * @param taskId - Target task ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the task doesn't exist.
   * @throws {OpsIllegalActionError} if the task is in a terminal state.
   */
  public cancelTask(taskId: string, note?: string): void {
    const task = this._taskManager.getTask(taskId);
    if (!task) {
      throw new OpsTargetNotFoundError(taskId, 'task');
    }

    if (!task.cancellable || !canTransition(task.status, 'cancelled')) {
      const err = new OpsIllegalActionError(taskId, 'cancel', task.status);
      emitOpsTaskCancelled(this._bus, this._makeCtx(taskId), {
        taskId,
        reason: 'ops_cancel',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    this._taskManager.cancelTask(taskId, { reason: note ?? 'operator-cancel' });

    emitOpsTaskCancelled(this._bus, this._makeCtx(taskId), {
      taskId,
      reason: 'ops_cancel',
      note,
      outcome: 'success',
    });
  }

  /**
   * Pause a running task (transitions running → blocked).
   *
   * Only legal from the 'running' state.
   *
   * @param taskId - Target task ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the task doesn't exist.
   * @throws {OpsIllegalActionError} if the task is not running.
   */
  public pauseTask(taskId: string, note?: string): void {
    const task = this._taskManager.getTask(taskId);
    if (!task) {
      throw new OpsTargetNotFoundError(taskId, 'task');
    }

    if (!canTransition(task.status, 'blocked')) {
      const err = new OpsIllegalActionError(taskId, 'pause', task.status);
      emitOpsTaskPaused(this._bus, this._makeCtx(taskId), {
        taskId,
        reason: 'ops_pause',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    this._taskManager.blockTask(taskId, note ?? 'operator-pause');

    emitOpsTaskPaused(this._bus, this._makeCtx(taskId), {
      taskId,
      reason: 'ops_pause',
      note,
      outcome: 'success',
    });
  }

  /**
   * Resume a blocked task (transitions blocked → running).
   *
   * Only legal from the 'blocked' state.
   *
   * @param taskId - Target task ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the task doesn't exist.
   * @throws {OpsIllegalActionError} if the task is not blocked.
   */
  public resumeTask(taskId: string, note?: string): void {
    const task = this._taskManager.getTask(taskId);
    if (!task) {
      throw new OpsTargetNotFoundError(taskId, 'task');
    }

    if (!canTransition(task.status, 'running')) {
      const err = new OpsIllegalActionError(taskId, 'resume', task.status);
      emitOpsTaskResumed(this._bus, this._makeCtx(taskId), {
        taskId,
        reason: 'ops_resume',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    this._taskManager.startTask(taskId);

    emitOpsTaskResumed(this._bus, this._makeCtx(taskId), {
      taskId,
      reason: 'ops_resume',
      note,
      outcome: 'success',
    });
  }

  /**
   * Retry a failed task (transitions failed → queued by re-creating as queued).
   *
   * Re-queues the task via TaskManager, which clears terminal-state fields
   * and transitions it back to 'queued'.
   * This is only permitted from 'failed' or 'cancelled' states.
   *
   * @param taskId - Target task ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the task doesn't exist.
   * @throws {OpsIllegalActionError} if the task is not in a retryable state.
   */
  public retryTask(taskId: string, note?: string): void {
    const task = this._taskManager.getTask(taskId);
    if (!task) {
      throw new OpsTargetNotFoundError(taskId, 'task');
    }

    if (!RETRYABLE_STATES.has(task.status)) {
      const err = new OpsIllegalActionError(taskId, 'retry', task.status);
      emitOpsTaskRetried(this._bus, this._makeCtx(taskId), {
        taskId,
        reason: 'ops_retry',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    // Route retry through TaskManager for consistent state management and event emission.
    this._taskManager.retryTask(taskId);

    emitOpsTaskRetried(this._bus, this._makeCtx(taskId), {
      taskId,
      reason: 'ops_retry',
      note,
      outcome: 'success',
    });
  }

  // ── Agent actions ─────────────────────────────────────────────────────────

  /**
   * Cancel a running agent.
   *
   * Only legal for agents in non-terminal states (spawning, running,
   * awaiting_message, awaiting_tool, finalizing).
   *
   * The agent state update is dispatched directly to the store since there is
   * no AgentManager interface with lifecycle methods (agents are managed
   * by their hosting subsystem). The store update signals the UI; the
   * underlying subsystem must observe the store and act accordingly.
   *
   * @param agentId - Target agent ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the agent doesn't exist.
   * @throws {OpsIllegalActionError} if the agent is already in a terminal state.
   */
  public cancelAgent(agentId: string, note?: string): void {
    const state = this._store.getState();
    const agent = state.agents.agents.get(agentId);

    if (!agent) {
      throw new OpsTargetNotFoundError(agentId, 'agent');
    }

    if (!CANCELLABLE_AGENT_STATES.has(agent.status)) {
      const err = new OpsIllegalActionError(agentId, 'cancel', agent.status);
      emitOpsAgentCancelled(this._bus, this._makeCtx(undefined, agentId), {
        agentId,
        reason: 'ops_agent_cancel',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    this._dispatch.transitionRuntimeAgent(
      agentId,
      'cancelled',
      { endedAt: Date.now() },
      'ops-control-plane',
    );

    emitOpsAgentCancelled(this._bus, this._makeCtx(undefined, agentId), {
      agentId,
      reason: 'ops_agent_cancel',
      note,
      outcome: 'success',
    });
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  /**
   * Returns whether a task action is currently legal given its state.
   * Used by the UI to conditionally render action controls.
   */
  public canCancelTask(taskId: string): boolean {
    const task = this._taskManager.getTask(taskId);
    return task != null && task.cancellable && canTransition(task.status, 'cancelled');
  }

  public canPauseTask(taskId: string): boolean {
    const task = this._taskManager.getTask(taskId);
    return task != null && canTransition(task.status, 'blocked');
  }

  public canResumeTask(taskId: string): boolean {
    const task = this._taskManager.getTask(taskId);
    return task != null && canTransition(task.status, 'running');
  }

  public canRetryTask(taskId: string): boolean {
    const task = this._taskManager.getTask(taskId);
    if (!task) return false;
    return task.status === 'failed' || task.status === 'cancelled';
  }

  public canCancelAgent(agentId: string): boolean {
    const state = this._store.getState();
    const agent = state.agents.agents.get(agentId);
    return agent != null && CANCELLABLE_AGENT_STATES.has(agent.status);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _makeCtx(taskId?: string, agentId?: string) {
    return {
      sessionId: this._sessionId,
      source: 'ops-control-plane',
      traceId: randomUUID(),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
    };
  }
}
