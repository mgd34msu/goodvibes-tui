/**
 * AgentTaskAdapter — bridges agent sessions (AgentOrchestrator / WRFC agents)
 * into the unified RuntimeTask registry.
 *
 * Each running agent gets a corresponding RuntimeTask of kind 'agent'. The
 * adapter maps agent lifecycle state strings to task lifecycle transitions.
 */

import { randomUUID } from 'node:crypto';
import { createDomainDispatch } from '../../store/index.ts';
import type { RuntimeStore, DomainDispatch } from '../../store/index.ts';
import type { RuntimeTask } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import type { AgentLifecycleState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/agents';

/** Owner context for an agent task. */
export interface AgentOwner {
  /** Session ID that spawned this agent. */
  sessionId: string;
}

/** Terminal agent lifecycle states that map to terminal task states. */
const TERMINAL_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/** Active (non-terminal, non-queued) agent states that map to 'running'. */
const RUNNING_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  'running',
  'awaiting_message',
  'awaiting_tool',
  'finalizing',
]);

/**
 * Maps an agent lifecycle state string to a RuntimeTask lifecycle state.
 *
 * @param state - Agent lifecycle state from AgentLifecycleState.
 * @returns Corresponding task lifecycle state.
 */
function mapAgentStateToTask(
  state: AgentLifecycleState,
): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
  if (state === 'spawning') return 'queued';
  if (RUNNING_STATES.has(state)) return 'running';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  return 'running'; // fallback for unknown states
}

/**
 * Bridges agent sessions into the RuntimeTask registry.
 *
 * @example
 * ```ts
 * const adapter = new AgentTaskAdapter(store);
 * const taskId = adapter.wrapAgent('agent_1', 'Fix the linting errors', { sessionId: 'sess_1' });
 * adapter.handleAgentStateChange('agent_1', 'running');
 * adapter.handleAgentStateChange('agent_1', 'completed');
 * ```
 */
export class AgentTaskAdapter {
  /** Maps agent ID → task ID. */
  private readonly _agentToTask = new Map<string, string>();
  /** Maps task ID → agent ID. */
  private readonly _taskToAgent = new Map<string, string>();

  private readonly _dispatch: DomainDispatch;

  constructor(private readonly _store: RuntimeStore) {
    this._dispatch = createDomainDispatch(_store);
  }

  // ── Core API ────────────────────────────────────────────────────────────────

  /**
   * Wrap an agent session as a RuntimeTask.
   *
   * @param agentId - Unique agent ID from the agent system.
   * @param task - Human-readable description of what the agent is doing.
   * @param owner - Session that spawned this agent.
   * @returns The new task ID.
   */
  wrapAgent(agentId: string, task: string, owner: AgentOwner): string {
    // Idempotent: return existing task ID if already wrapped
    const existing = this._agentToTask.get(agentId);
    if (existing !== undefined) return existing;

    const taskId = randomUUID();
    const now = Date.now();

    const runtimeTask: RuntimeTask = {
      id: taskId,
      kind: 'agent',
      title: task.length > 80 ? `${task.slice(0, 77)}...` : task,
      description: task,
      status: 'queued',
      owner: agentId,
      cancellable: true,
      childTaskIds: [],
      queuedAt: now,
      correlationId: owner.sessionId,
    };

    this._agentToTask.set(agentId, taskId);
    this._taskToAgent.set(taskId, agentId);

    this._upsertTask(runtimeTask);
    return taskId;
  }

  /**
   * Handle an agent lifecycle state change and transition the task accordingly.
   *
   * @param agentId - The agent whose state changed.
   * @param state - New agent lifecycle state (AgentLifecycleState string).
   */
  handleAgentStateChange(agentId: string, state: AgentLifecycleState): void {
    const taskId = this._agentToTask.get(agentId);
    if (taskId === undefined) return;

    const agentState = state;
    const taskStatus = mapAgentStateToTask(agentState);

    this._transitionTask(taskId, taskStatus, {
      isTerminal: TERMINAL_STATES.has(agentState),
      error: agentState === 'failed' ? `Agent ${agentId} failed` : undefined,
    });

    // Clean up mappings once terminal
    if (TERMINAL_STATES.has(agentState)) {
      this._agentToTask.delete(agentId);
      this._taskToAgent.delete(taskId);
    }
  }

  /**
   * Cancel an agent task by task ID.
   * Marks the task as cancelled in the store. The caller is responsible for
   * actually stopping the agent session.
   *
   * @param taskId - The RuntimeTask ID to cancel.
   */
  cancelAgent(taskId: string): void {
    const agentId = this._taskToAgent.get(taskId);
    if (agentId === undefined) return;

    this._transitionTask(taskId, 'cancelled', { isTerminal: true });
    this._agentToTask.delete(agentId);
    this._taskToAgent.delete(taskId);
  }

  /**
   * Reconcile adapter state with an external agent registry snapshot.
   *
   * @param activeAgents - Current snapshot of active agents: agentId → task description.
   * @param owner - Default owner context for auto-wrapped agents.
   */
  sync(activeAgents: ReadonlyMap<string, string>, owner: AgentOwner = { sessionId: 'system' }): void {
    const liveIds = new Set(activeAgents.keys());

    // Wrap newly discovered agents
    for (const [agentId, task] of activeAgents.entries()) {
      if (!this._agentToTask.has(agentId)) {
        this.wrapAgent(agentId, task, owner);
      }
    }

    // Mark stale tracked agents as cancelled
    const staleAgentIds: string[] = [];
    for (const [agentId] of this._agentToTask.entries()) {
      if (!liveIds.has(agentId)) staleAgentIds.push(agentId);
    }
    for (const agentId of staleAgentIds) {
      const taskId = this._agentToTask.get(agentId)!;
      this._transitionTask(taskId, 'cancelled', { isTerminal: true });
      this._agentToTask.delete(agentId);
      this._taskToAgent.delete(taskId);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _upsertTask(task: RuntimeTask): void {
    this._dispatch.syncRuntimeTask(task, 'agent-adapter');
  }

  private _transitionTask(
    taskId: string,
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
    opts: { isTerminal?: boolean; error?: string },
  ): void {
    const current = this._store.getState().tasks.tasks.get(taskId);
    const timestamp = Date.now();
    this._dispatch.transitionRuntimeTask(
      taskId,
      status,
      {
        startedAt: status === 'running' && current?.startedAt === undefined ? timestamp : current?.startedAt,
        endedAt: opts.isTerminal ? timestamp : current?.endedAt,
        error: opts.error,
      },
      'agent-adapter',
    );
  }
}
