/**
 * Runtime store — Zustand vanilla store for goodvibes-tui.
 *
 * Uses `createStore` from `zustand/vanilla` (NOT the React `create` hook)
 * because goodvibes-tui is a terminal app with no React renderer.
 *
 * Store invariants:
 * - No ad hoc direct `set` from arbitrary modules.
 * - All mutations go through typed DomainDispatch APIs.
 * - Transition logic remains pure.
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand';
import type { RuntimeState } from './state.ts';
import { createInitialRuntimeState } from './state.ts';
import type { TurnEvent } from '../events/turn.ts';
import type { ToolEvent } from '../events/tools.ts';
import type { PartialToolCall } from '../../providers/interface.ts';
import type { PermissionEvent } from '../events/permissions.ts';
import type { TaskEvent } from '../events/tasks.ts';
import type { AgentEvent } from '../events/agents.ts';
import type { PluginEvent } from '../events/plugins.ts';
import type { McpEvent } from '../events/mcp.ts';
import type { TransportEvent } from '../events/transport.ts';
import type {
  ConversationDomainState,
  ActiveToolCall,
  ToolExecutionState,
} from './domains/conversation.ts';
import type { PermissionDomainState, PermissionDecisionMachineState } from './domains/permissions.ts';
import type { TaskDomainState, RuntimeTask, TaskLifecycleState } from './domains/tasks.ts';
import type { AgentDomainState, RuntimeAgent, AgentLifecycleState } from './domains/agents.ts';
import type { PluginDomainState, RuntimePlugin, PluginLifecycleState } from './domains/plugins.ts';
import type { McpDomainState, McpServerRecord, McpServerLifecycleState } from './domains/mcp.ts';
import type { AcpDomainState, AcpTransportState } from './domains/acp.ts';
import type { DaemonDomainState, DaemonTransportState } from './domains/daemon.ts';

// ---------------------------------------------------------------------------
// Store type
// ---------------------------------------------------------------------------

/**
 * RuntimeStore — Zustand StoreApi wrapping RuntimeState.
 *
 * Consumers call `store.getState()` to read and `store.subscribe()` to
 * subscribe. Mutations go through DomainDispatch, never direct `.setState()`
 * from feature modules.
 */
export type RuntimeStore = StoreApi<RuntimeState>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a new RuntimeStore with all domains initialized
 * to their default values.
 *
 * Typically called once at application startup.
 *
 * @example
 * ```ts
 * const store = createRuntimeStore();
 * const state = store.getState();
 * console.log(state.session.status); // 'initializing'
 * ```
 */
export function createRuntimeStore(): RuntimeStore {
  return createStore<RuntimeState>(() => createInitialRuntimeState());
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function now(): number {
  return Date.now();
}

function updateDomainMetadata<T extends { revision: number; lastUpdatedAt: number; source: string }>(
  domain: T,
  source: string,
): T {
  return {
    ...domain,
    revision: domain.revision + 1,
    lastUpdatedAt: now(),
    source,
  };
}

function isTerminalTurnState(state: ConversationDomainState['turnState']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function canStartNewTurn(domain: ConversationDomainState): boolean {
  return domain.turnState === 'idle' || isTerminalTurnState(domain.turnState);
}

function isCurrentTurnEvent(domain: ConversationDomainState, turnId: string): boolean {
  return domain.currentTurnId !== undefined && domain.currentTurnId === turnId;
}

function formatPartialToolPreview(toolCalls?: PartialToolCall[]): string | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const last = toolCalls[toolCalls.length - 1] as { name?: unknown; arguments?: unknown };
  const name = typeof last.name === 'string' ? last.name : '';
  const args = typeof last.arguments === 'string'
    ? last.arguments
    : last.arguments !== undefined
      ? JSON.stringify(last.arguments)
      : '';
  if (!name) return undefined;
  const preview = args.length > 60 ? `${args.slice(0, 57)}...` : args;
  return `${name}(${preview})`;
}

function resetStreamState(): ConversationDomainState['stream'] {
  return {
    accumulated: '',
    reasoningAccumulated: '',
    partialToolPreview: undefined,
    deltaCount: 0,
    firstDeltaAt: undefined,
    lastDeltaAt: undefined,
  };
}

function updateConversationState(
  domain: ConversationDomainState,
  event: TurnEvent | ToolEvent,
): ConversationDomainState {
  const source = event.type;
  if ('callId' in event) {
    if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) {
      return domain;
    }
    const activeToolCalls = new Map(domain.activeToolCalls);
    const existing = activeToolCalls.get(event.callId);
    const stateByEvent: Partial<Record<ToolEvent['type'], ToolExecutionState>> = {
      TOOL_RECEIVED: 'received',
      TOOL_VALIDATED: 'validated',
      TOOL_PREHOOKED: 'prehooked',
      TOOL_PERMISSIONED: 'permissioned',
      TOOL_EXECUTING: 'executing',
      TOOL_MAPPED: 'mapped',
      TOOL_POSTHOOKED: 'posthooked',
      TOOL_SUCCEEDED: 'succeeded',
      TOOL_FAILED: 'failed',
      TOOL_CANCELLED: 'cancelled',
      BUDGET_EXCEEDED_MS: 'failed',
      BUDGET_EXCEEDED_TOKENS: 'failed',
      BUDGET_EXCEEDED_COST: 'failed',
    };
    const nextState = stateByEvent[event.type];
    const timestamp = now();
    const nextRecord: ActiveToolCall = {
      callId: event.callId,
      toolName: event.tool,
      args: existing?.args ?? ('args' in event ? JSON.stringify(event.args) : '{}'),
      state: nextState ?? existing?.state ?? 'received',
      stateEnteredAt: 'startedAt' in event ? event.startedAt : timestamp,
      phaseTimestamps: {
        ...(existing?.phaseTimestamps ?? {}),
        ...(nextState ? { [nextState]: timestamp } : {}),
      },
      error:
        'error' in event
          ? event.error
          : event.type === 'BUDGET_EXCEEDED_MS'
            ? `${event.phase} exceeded ${event.limitMs}ms budget`
            : event.type === 'BUDGET_EXCEEDED_TOKENS'
              ? `${event.phase} exceeded ${event.limitTokens} token budget`
              : event.type === 'BUDGET_EXCEEDED_COST'
                ? `${event.phase} exceeded $${event.limitCostUsd} cost budget`
                : existing?.error,
    };
    activeToolCalls.set(event.callId, nextRecord);
    return {
      ...updateDomainMetadata(domain, source),
      activeToolCalls,
      currentTurnId: domain.currentTurnId ?? event.turnId,
      toolCallsThisTurn: event.type === 'TOOL_RECEIVED' ? domain.toolCallsThisTurn + 1 : domain.toolCallsThisTurn,
    };
  }

  switch (event.type) {
    case 'TURN_SUBMITTED':
      if (!canStartNewTurn(domain)) {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        turnState: 'preflight',
        currentTurnId: event.turnId,
        turnStartedAt: now(),
        turnEndedAt: undefined,
        lastTurnError: undefined,
        lastTurnStopReason: undefined,
        lastTurnResponse: undefined,
        lastPreflightFailure: undefined,
        stream: resetStreamState(),
        activeToolCalls: new Map(),
        toolCallsThisTurn: 0,
        lastToolReconciliation: undefined,
      };
    case 'PREFLIGHT_OK':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'preflight') {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'preflight',
      };
    case 'PREFLIGHT_FAIL':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'preflight') {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'failed',
        turnEndedAt: now(),
        lastTurnError: event.reason,
        lastTurnStopReason: event.stopReason,
        lastPreflightFailure: event.reason,
        stream: resetStreamState(),
      };
    case 'STREAM_START':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'preflight') {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'streaming',
        stream: resetStreamState(),
      };
    case 'STREAM_DELTA':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'streaming') {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'streaming',
        stream: {
          accumulated: event.accumulated,
          reasoningAccumulated: `${domain.stream.reasoningAccumulated}${event.reasoning ?? ''}`,
          partialToolPreview: formatPartialToolPreview(event.toolCalls),
          deltaCount: domain.stream.deltaCount + 1,
          firstDeltaAt: domain.stream.firstDeltaAt ?? now(),
          lastDeltaAt: now(),
        },
      };
    case 'STREAM_END':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'streaming') {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        stream: {
          ...domain.stream,
          partialToolPreview: undefined,
        },
      };
    case 'LLM_RESPONSE_RECEIVED':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
      };
    case 'TOOL_BATCH_READY':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'streaming') {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'tool_dispatch',
      };
    case 'TOOLS_DONE':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'tool_dispatch') {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'post_hooks',
      };
    case 'POST_HOOKS_DONE':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'post_hooks') {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'post_hooks',
      };
    case 'TOOL_RECONCILED':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        lastToolReconciliation: {
          count: event.count,
          callIds: [...event.callIds],
          toolNames: [...event.toolNames],
          reason: event.reason,
          timestamp: event.timestamp,
          isMalformed: event.isMalformed ?? false,
        },
      };
    case 'TURN_COMPLETED':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'completed',
        turnEndedAt: now(),
        lastTurnStopReason: event.stopReason,
        lastTurnResponse: event.response,
        stream: {
          ...domain.stream,
          partialToolPreview: undefined,
        },
        totalTurns: domain.totalTurns + 1,
      };
    case 'TURN_ERROR':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'failed',
        turnEndedAt: now(),
        lastTurnError: event.error,
        lastTurnStopReason: event.stopReason,
        stream: {
          ...domain.stream,
          partialToolPreview: undefined,
        },
      };
    case 'TURN_CANCEL':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) {
        return domain;
      }
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'cancelled',
        turnEndedAt: now(),
        lastTurnError: event.reason,
        lastTurnStopReason: event.stopReason,
        stream: {
          ...domain.stream,
          partialToolPreview: undefined,
        },
      };
    default:
      return updateDomainMetadata(domain, source);
  }
}

function inferPermissionCategory(toolName: string): import('../../permissions/manager.ts').PermissionCategory {
  if (toolName === 'agent' || toolName === 'delegate') return 'delegate';
  if (toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch') return 'write';
  if (toolName === 'exec' || toolName === 'precision_exec' || toolName === 'bash') return 'execute';
  return 'read';
}

function permissionMachineStateForEvent(event: PermissionEvent): PermissionDecisionMachineState {
  switch (event.type) {
    case 'PERMISSION_REQUESTED':
      return 'collect_rules';
    case 'RULES_COLLECTED':
      return 'normalize_input';
    case 'INPUT_NORMALIZED':
      return 'evaluate_policy';
    case 'POLICY_EVALUATED':
      return 'evaluate_runtime_mode';
    case 'MODE_EVALUATED':
      return 'evaluate_session_override';
    case 'SESSION_OVERRIDE_EVALUATED':
      return 'final_safety_checks';
    case 'SAFETY_CHECKED':
    case 'DECISION_EMITTED':
      return 'decision_emitted';
  }
}

function updatePermissionState(
  domain: PermissionDomainState,
  event: PermissionEvent,
): PermissionDomainState {
  const base = updateDomainMetadata(domain, event.type);
  switch (event.type) {
    case 'PERMISSION_REQUESTED':
      return {
        ...base,
        awaitingDecision: true,
        decisionMachineState: permissionMachineStateForEvent(event),
        totalChecks: domain.totalChecks + 1,
      };
    case 'RULES_COLLECTED':
    case 'INPUT_NORMALIZED':
    case 'POLICY_EVALUATED':
    case 'MODE_EVALUATED':
    case 'SESSION_OVERRIDE_EVALUATED':
    case 'SAFETY_CHECKED':
      return {
        ...base,
        awaitingDecision: true,
        decisionMachineState: permissionMachineStateForEvent(event),
      };
    case 'DECISION_EMITTED':
      return {
        ...base,
        awaitingDecision: false,
        decisionMachineState: permissionMachineStateForEvent(event),
        approvalCount: domain.approvalCount + (event.approved ? 1 : 0),
        denialCount: domain.denialCount + (event.approved ? 0 : 1),
        lastDecision: {
          callId: event.callId,
          toolName: event.tool,
          category: inferPermissionCategory(event.tool),
          machineState: 'decision_emitted',
          outcome: event.approved ? 'approved' : 'denied',
          reason: event.approved ? 'user_approved' : 'user_denied',
          sourceLayer: event.source === 'user_prompt' ? 'user_prompt' : 'config_policy',
          persisted: false,
          decidedAt: now(),
        },
      };
  }
}

function updateTaskIndexes(tasks: Map<string, RuntimeTask>) {
  const queuedIds: string[] = [];
  const runningIds: string[] = [];
  const blockedIds: string[] = [];
  for (const [taskId, task] of tasks.entries()) {
    if (task.status === 'queued') queuedIds.push(taskId);
    if (task.status === 'running') runningIds.push(taskId);
    if (task.status === 'blocked') blockedIds.push(taskId);
  }
  return { queuedIds, runningIds, blockedIds };
}

function updateTaskState(domain: TaskDomainState, event: TaskEvent): TaskDomainState {
  const tasks = new Map(domain.tasks);
  const existing = tasks.get(event.taskId);
  const timestamp = now();
  const task: RuntimeTask =
    existing ??
    {
      id: event.taskId,
      kind: 'agentId' in event && event.agentId ? 'agent' : 'exec',
      title: 'description' in event ? event.description : `task:${event.taskId}`,
      status: 'queued',
      owner: event.agentId ?? 'runtime',
      cancellable: true,
      childTaskIds: [],
      queuedAt: timestamp,
    };
  switch (event.type) {
    case 'TASK_CREATED':
      tasks.set(event.taskId, task);
      break;
    case 'TASK_STARTED':
      tasks.set(event.taskId, { ...task, status: 'running', startedAt: task.startedAt ?? timestamp });
      break;
    case 'TASK_BLOCKED':
      tasks.set(event.taskId, { ...task, status: 'blocked', error: event.reason });
      break;
    case 'TASK_PROGRESS':
      tasks.set(event.taskId, { ...task, description: event.message ?? task.description });
      break;
    case 'TASK_COMPLETED':
      tasks.set(event.taskId, { ...task, status: 'completed', endedAt: timestamp, result: { durationMs: event.durationMs } });
      break;
    case 'TASK_FAILED':
      tasks.set(event.taskId, { ...task, status: 'failed', endedAt: timestamp, error: event.error });
      break;
    case 'TASK_CANCELLED':
      tasks.set(event.taskId, { ...task, status: 'cancelled', endedAt: timestamp, error: event.reason });
      break;
  }
  const indexes = updateTaskIndexes(tasks);
  return {
    ...updateDomainMetadata(domain, event.type),
    tasks,
    ...indexes,
    totalCreated: domain.totalCreated + (event.type === 'TASK_CREATED' ? 1 : 0),
    totalCompleted: domain.totalCompleted + (event.type === 'TASK_COMPLETED' ? 1 : 0),
    totalFailed: domain.totalFailed + (event.type === 'TASK_FAILED' ? 1 : 0),
    totalCancelled: domain.totalCancelled + (event.type === 'TASK_CANCELLED' ? 1 : 0),
  };
}

function updateTaskDomainFromRecord(
  domain: TaskDomainState,
  task: RuntimeTask,
  source: string,
): TaskDomainState {
  const tasks = new Map(domain.tasks);
  const previous = tasks.get(task.id);
  tasks.set(task.id, task);
  const indexes = updateTaskIndexes(tasks);

  let { totalCreated, totalCompleted, totalFailed, totalCancelled } = domain;
  if (!previous) {
    totalCreated += 1;
  }
  if (previous?.status !== task.status) {
    if (task.status === 'completed') totalCompleted += 1;
    else if (task.status === 'failed') totalFailed += 1;
    else if (task.status === 'cancelled') totalCancelled += 1;
  }

  return {
    ...updateDomainMetadata(domain, source),
    tasks,
    ...indexes,
    totalCreated,
    totalCompleted,
    totalFailed,
    totalCancelled,
  };
}

function transitionTaskDomainRecord(
  domain: TaskDomainState,
  taskId: string,
  status: TaskLifecycleState,
  patch: Partial<RuntimeTask> | undefined,
  source: string,
): TaskDomainState {
  const existing = domain.tasks.get(taskId);
  if (!existing) return domain;
  return updateTaskDomainFromRecord(
    domain,
    {
      ...existing,
      ...patch,
      status,
    },
    source,
  );
}

function updateAgentState(domain: AgentDomainState, event: AgentEvent): AgentDomainState {
  const agents = new Map(domain.agents);
  const timestamp = now();
  const existing = agents.get(event.agentId);
  const statusMap: Partial<Record<AgentEvent['type'], AgentLifecycleState>> = {
    AGENT_SPAWNING: 'spawning',
    AGENT_RUNNING: 'running',
    AGENT_PROGRESS: 'running',
    AGENT_STREAM_DELTA: 'running',
    AGENT_AWAITING_MESSAGE: 'awaiting_message',
    AGENT_AWAITING_TOOL: 'awaiting_tool',
    AGENT_FINALIZING: 'finalizing',
    AGENT_COMPLETED: 'completed',
    AGENT_FAILED: 'failed',
    AGENT_CANCELLED: 'cancelled',
  };
  const agent: RuntimeAgent =
    existing ??
    {
      id: event.agentId,
      label: 'task' in event ? event.task : event.agentId,
      role: 'subagent',
      status: statusMap[event.type] ?? 'running',
      providerId: 'unknown',
      modelId: 'unknown',
      childAgentIds: [],
      taskId: event.taskId,
      turnCount: 0,
      toolCallCount: 0,
      latestOutput: '',
      spawnedAt: timestamp,
    };
  agents.set(event.agentId, {
    ...agent,
    status: statusMap[event.type] ?? agent.status,
    taskId: event.taskId ?? agent.taskId,
    latestProgress:
      event.type === 'AGENT_PROGRESS'
        ? event.progress
        : event.type === 'AGENT_AWAITING_TOOL'
          ? `${event.tool}:${event.callId}`
          : agent.latestProgress,
    latestOutput:
      event.type === 'AGENT_STREAM_DELTA'
        ? event.accumulated
        : event.type === 'AGENT_COMPLETED' && event.output !== undefined
          ? event.output
          : agent.latestOutput,
    endedAt:
      event.type === 'AGENT_COMPLETED' || event.type === 'AGENT_FAILED' || event.type === 'AGENT_CANCELLED'
        ? timestamp
        : agent.endedAt,
    error: event.type === 'AGENT_FAILED' ? event.error : agent.error,
    toolCallCount:
      event.type === 'AGENT_COMPLETED' && event.toolCallsMade !== undefined
        ? event.toolCallsMade
        : agent.toolCallCount,
    result:
      event.type === 'AGENT_COMPLETED'
        ? {
            durationMs: event.durationMs,
            ...(event.output !== undefined ? { output: event.output } : {}),
            ...(event.toolCallsMade !== undefined ? { toolCallsMade: event.toolCallsMade } : {}),
          }
        : agent.result,
  });
  const activeAgentIds = [...agents.values()]
    .filter((value) => !['completed', 'failed', 'cancelled'].includes(value.status))
    .map((value) => value.id);
  return {
    ...updateDomainMetadata(domain, event.type),
    agents,
    activeAgentIds,
    totalSpawned: domain.totalSpawned + (event.type === 'AGENT_SPAWNING' ? 1 : 0),
    totalCompleted: domain.totalCompleted + (event.type === 'AGENT_COMPLETED' ? 1 : 0),
    totalFailed: domain.totalFailed + (event.type === 'AGENT_FAILED' ? 1 : 0),
    peakConcurrency: Math.max(domain.peakConcurrency, activeAgentIds.length),
  };
}

function transitionAgentDomainRecord(
  domain: AgentDomainState,
  agentId: string,
  status: AgentLifecycleState,
  patch: Partial<RuntimeAgent> | undefined,
  source: string,
): AgentDomainState {
  const existing = domain.agents.get(agentId);
  if (!existing) return domain;

  const agents = new Map(domain.agents);
  agents.set(agentId, {
    ...existing,
    ...patch,
    status,
  });
  const activeAgentIds = [...agents.values()]
    .filter((value) => !['completed', 'failed', 'cancelled'].includes(value.status))
    .map((value) => value.id);

  return {
    ...updateDomainMetadata(domain, source),
    agents,
    activeAgentIds,
    totalCompleted: domain.totalCompleted + (existing.status !== 'completed' && status === 'completed' ? 1 : 0),
    totalFailed: domain.totalFailed + (existing.status !== 'failed' && status === 'failed' ? 1 : 0),
    peakConcurrency: Math.max(domain.peakConcurrency, activeAgentIds.length),
  };
}

function pluginStatusForEvent(event: PluginEvent): PluginLifecycleState {
  switch (event.type) {
    case 'PLUGIN_DISCOVERED':
      return 'discovered';
    case 'PLUGIN_LOADING':
      return 'loading';
    case 'PLUGIN_LOADED':
      return 'loaded';
    case 'PLUGIN_ACTIVE':
      return 'active';
    case 'PLUGIN_DEGRADED':
      return 'degraded';
    case 'PLUGIN_ERROR':
      return 'error';
    case 'PLUGIN_UNLOADING':
      return 'unloading';
    case 'PLUGIN_DISABLED':
      return 'disabled';
  }
}

function updatePluginState(domain: PluginDomainState, event: PluginEvent): PluginDomainState {
  const plugins = new Map(domain.plugins);
  const existing = plugins.get(event.pluginId);
  const timestamp = now();
  const plugin: RuntimePlugin =
    existing ??
    {
      name: event.pluginId,
      displayName: event.pluginId,
      version: 'version' in event ? event.version : 'unknown',
      description: 'path' in event ? event.path : '',
      status: pluginStatusForEvent(event),
      enabled: true,
      active: false,
      toolCount: 'capabilities' in event ? event.capabilities.length : 0,
      config: {},
      hookInvocations: 0,
    };
  const next: RuntimePlugin = {
    ...plugin,
    status: pluginStatusForEvent(event),
    version: 'version' in event ? event.version : plugin.version,
    description: 'path' in event ? event.path : plugin.description,
    active: event.type === 'PLUGIN_ACTIVE' ? true : event.type === 'PLUGIN_DISABLED' ? false : plugin.active,
    enabled: event.type === 'PLUGIN_DISABLED' ? false : plugin.enabled,
    toolCount: 'capabilities' in event ? event.capabilities.length : plugin.toolCount,
    error:
      event.type === 'PLUGIN_ERROR'
        ? event.error
        : event.type === 'PLUGIN_DEGRADED'
          ? event.reason
          : plugin.error,
    loadedAt:
      event.type === 'PLUGIN_LOADED' || event.type === 'PLUGIN_ACTIVE'
        ? timestamp
        : plugin.loadedAt,
    errorAt:
      event.type === 'PLUGIN_ERROR' || event.type === 'PLUGIN_DEGRADED'
        ? timestamp
        : plugin.errorAt,
  };
  plugins.set(event.pluginId, next);
  const activePluginNames = [...plugins.values()].filter((value) => value.active).map((value) => value.name);
  const erroredPluginNames = [...plugins.values()]
    .filter((value) => value.status === 'error' || value.status === 'degraded')
    .map((value) => value.name);
  return {
    ...updateDomainMetadata(domain, event.type),
    plugins,
    activePluginNames,
    erroredPluginNames,
    totalDiscovered: domain.totalDiscovered + (event.type === 'PLUGIN_DISCOVERED' ? 1 : 0),
    totalActive: activePluginNames.length,
    totalToolsContributed: [...plugins.values()].reduce((sum, value) => sum + (value.active ? value.toolCount : 0), 0),
    initialLoadComplete: domain.initialLoadComplete || event.type === 'PLUGIN_LOADED' || event.type === 'PLUGIN_ACTIVE',
    reloadInProgress: event.type === 'PLUGIN_LOADING' || event.type === 'PLUGIN_UNLOADING',
  };
}

function mcpStatusForEvent(event: McpEvent): McpServerLifecycleState {
  switch (event.type) {
    case 'MCP_CONFIGURED':
      return 'configured';
    case 'MCP_CONNECTING':
      return 'connecting';
    case 'MCP_CONNECTED':
      return 'connected';
    case 'MCP_DEGRADED':
    case 'MCP_SCHEMA_QUARANTINED':
    case 'MCP_SCHEMA_QUARANTINE_APPROVED':
      return 'degraded';
    case 'MCP_AUTH_REQUIRED':
      return 'auth_required';
    case 'MCP_RECONNECTING':
      return 'reconnecting';
    case 'MCP_DISCONNECTED':
      return 'disconnected';
  }
}

function updateMcpState(domain: McpDomainState, event: McpEvent): McpDomainState {
  const servers = new Map(domain.servers);
  const existing = servers.get(event.serverId);
  const timestamp = now();
  const server: McpServerRecord =
    existing ??
    {
      name: event.serverId,
      displayName: event.serverId,
      status: mcpStatusForEvent(event),
      transport: event.type === 'MCP_CONFIGURED' && event.transport === 'http' ? 'http' : 'stdio',
      toolCount: 0,
      toolNames: [],
      callCount: 0,
      errorCount: 0,
      reconnectAttempts: 0,
    };
  servers.set(event.serverId, {
    ...server,
    status: mcpStatusForEvent(event),
    transport:
      event.type === 'MCP_CONFIGURED'
        ? event.transport === 'sse' || event.transport === 'http'
          ? event.transport
          : 'stdio'
        : server.transport,
    toolCount: event.type === 'MCP_CONNECTED' ? event.toolCount : server.toolCount,
    connectedAt: event.type === 'MCP_CONNECTED' ? timestamp : server.connectedAt,
    reconnectAttempts: event.type === 'MCP_RECONNECTING' ? event.attempt : server.reconnectAttempts,
    lastError:
      event.type === 'MCP_DEGRADED'
        ? event.reason
        : event.type === 'MCP_DISCONNECTED'
          ? event.reason
          : event.type === 'MCP_SCHEMA_QUARANTINED'
            ? event.detail ?? String(event.reason)
            : server.lastError,
  });
  const connectedServerNames = [...servers.values()]
    .filter((value) => value.status === 'connected')
    .map((value) => value.name);
  return {
    ...updateDomainMetadata(domain, event.type),
    servers,
    connectedServerNames,
    availableToolCount: [...servers.values()].reduce(
      (sum, value) => sum + (value.status === 'connected' ? value.toolCount : 0),
      0,
    ),
    totalErrors:
      domain.totalErrors +
      (event.type === 'MCP_DEGRADED' || event.type === 'MCP_DISCONNECTED' || event.type === 'MCP_SCHEMA_QUARANTINED'
        ? 1
        : 0),
  };
}

function transportStateForEvent(event: TransportEvent): DaemonTransportState {
  switch (event.type) {
    case 'TRANSPORT_INITIALIZING':
      return 'initializing';
    case 'TRANSPORT_AUTHENTICATING':
      return 'authenticating';
    case 'TRANSPORT_CONNECTED':
      return 'connected';
    case 'TRANSPORT_SYNCING':
      return 'syncing';
    case 'TRANSPORT_DEGRADED':
      return 'degraded';
    case 'TRANSPORT_RECONNECTING':
      return 'reconnecting';
    case 'TRANSPORT_DISCONNECTED':
      return 'disconnected';
    case 'TRANSPORT_TERMINAL_FAILURE':
      return 'terminal_failure';
  }
}

function updateTransportState(
  acp: AcpDomainState,
  daemon: DaemonDomainState,
  event: TransportEvent,
): Pick<RuntimeState, 'acp' | 'daemon'> {
  const nextTransportState = transportStateForEvent(event);
  const isAcp = event.transportId.startsWith('acp');
  const nextAcp = isAcp
    ? {
        ...updateDomainMetadata(acp, event.type),
        managerTransportState: nextTransportState as AcpTransportState,
        initialized: acp.initialized || event.type === 'TRANSPORT_INITIALIZING',
      }
    : acp;
  const nextDaemon = !isAcp
    ? {
        ...updateDomainMetadata(daemon, event.type),
        transportState: nextTransportState,
        isRunning: event.type === 'TRANSPORT_CONNECTED' ? true : event.type === 'TRANSPORT_DISCONNECTED' ? false : daemon.isRunning,
        reconnectAttempts: event.type === 'TRANSPORT_RECONNECTING' ? event.attempt : daemon.reconnectAttempts,
        lastConnectedAt: event.type === 'TRANSPORT_CONNECTED' ? now() : daemon.lastConnectedAt,
        lastError:
          event.type === 'TRANSPORT_DEGRADED'
            ? event.reason
            : event.type === 'TRANSPORT_DISCONNECTED'
              ? event.reason
              : event.type === 'TRANSPORT_TERMINAL_FAILURE'
                ? event.error
                : daemon.lastError,
      }
    : daemon;
  return { acp: nextAcp, daemon: nextDaemon };
}

function mutateRuntimeStore(
  store: RuntimeStore,
  updater: (state: RuntimeState) => RuntimeState,
): void {
  store.setState(updater);
}

export function createDomainDispatch(store: RuntimeStore): DomainDispatch {
  return {
    dispatchTurnEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        conversation: updateConversationState(state.conversation, event),
      }));
    },
    dispatchToolEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        conversation: updateConversationState(state.conversation, event),
      }));
    },
    dispatchPermissionEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        permissions: updatePermissionState(state.permissions, event),
      }));
    },
    dispatchTaskEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        tasks: updateTaskState(state.tasks, event),
      }));
    },
    dispatchAgentEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        agents: updateAgentState(state.agents, event),
      }));
    },
    dispatchPluginEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        plugins: updatePluginState(state.plugins, event),
      }));
    },
    dispatchMcpEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        mcp: updateMcpState(state.mcp, event),
      }));
    },
    dispatchTransportEvent(event) {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        ...updateTransportState(state.acp, state.daemon, event),
      }));
    },
    syncRuntimeTask(task, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        tasks: updateTaskDomainFromRecord(state.tasks, task, source),
      }));
    },
    transitionRuntimeTask(taskId, status, patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        tasks: transitionTaskDomainRecord(state.tasks, taskId, status, patch, source),
      }));
    },
    transitionRuntimeAgent(agentId, status, patch, source = 'domain-dispatch') {
      mutateRuntimeStore(store, (state) => ({
        ...state,
        agents: transitionAgentDomainRecord(state.agents, agentId, status, patch, source),
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// DomainDispatch interface
// ---------------------------------------------------------------------------

/**
 * DomainDispatch — the typed mutation API for all runtime domains.
 *
 * All state mutations must go through this interface.
 * Implementations will be provided by the domain dispatch layer (Tier 1+).
 *
 * The dispatch functions accept domain-specific events; implementations
 * use pure reducer logic to derive the next state.
 */
export interface DomainDispatch {
  /**
   * Dispatch a turn lifecycle event (TURN_SUBMITTED, PREFLIGHT_OK, etc.).
   * Transitions the conversation domain's turn state machine.
   */
  dispatchTurnEvent(event: TurnEvent): void;

  /**
   * Dispatch a tool execution event (received, validated, permissioned, etc.).
   * Updates the active tool call record in the conversation domain.
   */
  dispatchToolEvent(event: ToolEvent): void;

  /**
   * Dispatch a permission decision machine event.
   * Transitions the permissions domain's decision state machine.
   */
  dispatchPermissionEvent(event: PermissionEvent): void;

  /**
   * Dispatch a task lifecycle event (queued, running, blocked, etc.).
   * Updates the tasks domain's task registry.
   */
  dispatchTaskEvent(event: TaskEvent): void;

  /**
   * Dispatch an agent lifecycle event (spawning, running, completed, etc.).
   * Updates the agents domain's agent registry.
   */
  dispatchAgentEvent(event: AgentEvent): void;

  /**
   * Dispatch a plugin lifecycle event (discovered, loading, active, etc.).
   * Updates the plugins domain's plugin registry.
   */
  dispatchPluginEvent(event: PluginEvent): void;

  /**
   * Dispatch an MCP server lifecycle event (connecting, connected, etc.).
   * Updates the mcp domain's server registry.
   */
  dispatchMcpEvent(event: McpEvent): void;

  /**
   * Dispatch an ACP/daemon transport lifecycle event.
   * Updates the acp and daemon domains' transport state machines.
   */
  dispatchTransportEvent(event: TransportEvent): void;

  /**
   * Upsert a concrete runtime task record through the store mutation layer.
   */
  syncRuntimeTask(task: RuntimeTask, source?: string): void;

  /**
   * Transition an existing runtime task record through the store mutation layer.
   */
  transitionRuntimeTask(
    taskId: string,
    status: TaskLifecycleState,
    patch?: Partial<RuntimeTask>,
    source?: string,
  ): void;

  /**
   * Transition an existing runtime agent record through the store mutation layer.
   */
  transitionRuntimeAgent(
    agentId: string,
    status: AgentLifecycleState,
    patch?: Partial<RuntimeAgent>,
    source?: string,
  ): void;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { RuntimeState } from './state.ts';
export { createInitialRuntimeState } from './state.ts';
export * from './selectors/index.ts';
export * from './domains/index.ts';
