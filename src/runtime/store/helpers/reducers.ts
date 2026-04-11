import type { TurnEvent } from '../../events/turn.ts';
import type { ToolEvent } from '../../events/tools.ts';
import type { PermissionEvent } from '../../events/permissions.ts';
import type { TaskEvent } from '../../events/tasks.ts';
import type { AgentEvent } from '../../events/agents.ts';
import type { OrchestrationEvent } from '../../events/orchestration.ts';
import type { CommunicationEvent } from '../../events/communication.ts';
import type { PluginEvent } from '../../events/plugins.ts';
import type { McpEvent } from '../../events/mcp.ts';
import type { TransportEvent } from '../../events/transport.ts';
import type { CompactionEvent } from '../../events/compaction.ts';
import type { PartialToolCall } from '../../../providers/interface.ts';
import type { RuntimeState } from '../state.ts';
import type {
  ConversationDomainState,
  ActiveToolCall,
  ToolExecutionState,
} from '../domains/conversation.ts';
import type { SessionDomainState } from '../domains/session.ts';
import type {
  PermissionDomainState,
  PermissionDecisionMachineState,
  PermissionDecision,
} from '../domains/permissions.ts';
import type { TaskDomainState, RuntimeTask, TaskLifecycleState } from '../domains/tasks.ts';
import type { AgentDomainState, RuntimeAgent, AgentLifecycleState } from '../domains/agents.ts';
import type {
  OrchestrationDomainState,
  OrchestrationGraphRecord,
  OrchestrationNodeRecord,
} from '../domains/orchestration.ts';
import type {
  CommunicationDomainState,
  RuntimeCommunicationRecord,
} from '../domains/communication.ts';
import type { PluginDomainState, RuntimePlugin, PluginLifecycleState } from '../domains/plugins.ts';
import type { McpDomainState, McpServerRecord, McpServerLifecycleState } from '../domains/mcp.ts';
import type { AcpDomainState, AcpTransportState } from '../domains/acp.ts';
import type { DaemonDomainState, DaemonTransportState } from '../domains/daemon.ts';
import type {
  IntegrationDomainState,
  IntegrationRecord,
  IntegrationStatus,
} from '../domains/integrations.ts';
import type { AutomationDomainState } from '../domains/automation.ts';
import type { RoutesDomainState } from '../domains/routes.ts';
import type { ControlPlaneDomainState, ControlPlaneClientRecord } from '../domains/control-plane.ts';
import type { DeliveryDomainState } from '../domains/deliveries.ts';
import type { WatcherDomainState, WatcherRecord } from '../domains/watchers.ts';
import type { SurfaceDomainState, SurfaceRecord } from '../domains/surfaces.ts';
import type { AutomationJob } from '../../../automation/jobs.ts';
import type { AutomationRun } from '../../../automation/runs.ts';
import type { AutomationSourceRecord } from '../../../automation/sources.ts';
import type { AutomationRouteBinding } from '../../../automation/routes.ts';
import type { AutomationSurfaceKind } from '../../../automation/types.ts';
import type { AutomationDeliveryAttempt } from '../../../automation/delivery.ts';

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function now(): number {
  return Date.now();
}

export function updateDomainMetadata<T extends { revision: number; lastUpdatedAt: number; source: string }>(
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
  const args =
    typeof last.arguments === 'string'
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

export function updateConversationState(
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

function inferPermissionCategory(
  toolName: string,
): import('../../../permissions/manager.ts').PermissionCategory {
  if (toolName === 'agent' || toolName === 'delegate') return 'delegate';
  if (toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch') return 'write';
  if (toolName === 'exec' || toolName === 'precision_exec' || toolName === 'bash') return 'execute';
  return 'read';
}

export function updateSessionState(
  domain: SessionDomainState,
  event: CompactionEvent,
): SessionDomainState {
  const base = updateDomainMetadata(domain, event.type);
  switch (event.type) {
    case 'COMPACTION_CHECK':
      return {
        ...base,
        compactionState: 'checking_threshold',
      };
    case 'COMPACTION_MICROCOMPACT':
      return {
        ...base,
        compactionState: 'microcompact',
      };
    case 'COMPACTION_COLLAPSE':
      return {
        ...base,
        compactionState: 'collapse',
        compactionMessageCount: event.messageCount,
      };
    case 'COMPACTION_AUTOCOMPACT':
      return {
        ...base,
        compactionState: 'autocompact',
      };
    case 'COMPACTION_REACTIVE':
      return {
        ...base,
        compactionState: 'reactive_compact',
      };
    case 'COMPACTION_BOUNDARY_COMMIT':
      return {
        ...base,
        compactionState: 'boundary_commit',
      };
    case 'COMPACTION_DONE':
      return {
        ...base,
        compactionState: 'done',
        lastCompactedAt: now(),
      };
    case 'COMPACTION_FAILED':
      return {
        ...base,
        compactionState: 'failed',
        recoveryError: event.error,
      };
    case 'COMPACTION_RESUME_REPAIR':
      return {
        ...base,
        wasRepaired: event.repaired,
        recoveryState: event.safeToResume ? 'ready' : domain.recoveryState,
      };
    case 'COMPACTION_QUALITY_SCORE':
    case 'COMPACTION_STRATEGY_SWITCH':
      return base;
  }
}

export function updatePermissionState(
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
          reason:
            (event.reasonCode as PermissionDecision['reason']) ??
            (event.approved ? 'user_approved' : 'user_denied'),
          sourceLayer:
            (event.sourceLayer as PermissionDecision['sourceLayer']) ??
            (event.source as PermissionDecision['sourceLayer']) ??
            'config_policy',
          persisted: event.persisted ?? false,
          classification: event.classification,
          riskLevel: event.riskLevel as PermissionDecision['riskLevel'],
          summary: event.summary,
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

export function updateTaskState(domain: TaskDomainState, event: TaskEvent): TaskDomainState {
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

export function updateAgentState(domain: AgentDomainState, event: AgentEvent): AgentDomainState {
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

function orchestrationGraphStatus(
  graph: OrchestrationGraphRecord,
): OrchestrationGraphRecord['status'] {
  const nodes = [...graph.nodes.values()];
  if (nodes.length === 0) return 'planning';
  if (nodes.some((node) => node.status === 'failed')) return 'failed';
  if (nodes.some((node) => node.status === 'blocked')) return 'blocked';
  if (nodes.some((node) => node.status === 'running')) return 'running';
  if (nodes.every((node) => node.status === 'cancelled')) return 'cancelled';
  if (nodes.every((node) => node.status === 'completed')) return 'completed';
  if (nodes.every((node) => node.status === 'pending' || node.status === 'ready')) {
    return nodes.some((node) => node.status === 'ready') ? 'ready' : 'planning';
  }
  return 'running';
}

export function updateOrchestrationState(
  domain: OrchestrationDomainState,
  event: OrchestrationEvent,
): OrchestrationDomainState {
  const graphs = new Map(domain.graphs);
  const timestamp = now();
  const existing = 'graphId' in event ? graphs.get(event.graphId) : undefined;

  switch (event.type) {
    case 'ORCHESTRATION_GRAPH_CREATED': {
      graphs.set(event.graphId, {
        id: event.graphId,
        title: event.title,
        mode: event.mode,
        status: 'planning',
        nodeOrder: [],
        nodes: new Map(),
        createdAt: timestamp,
      });
      break;
    }
    case 'ORCHESTRATION_NODE_ADDED': {
      if (!existing) return domain;
      const nodes = new Map(existing.nodes);
      const previousParent = event.parentNodeId ? nodes.get(event.parentNodeId) : undefined;
      const nextNode: OrchestrationNodeRecord = {
        id: event.nodeId,
        title: event.title,
        role: event.role,
        status: 'pending',
        parentNodeId: event.parentNodeId,
        childNodeIds: [],
        dependencyNodeIds: event.dependsOn ?? [],
        ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
        ...(event.contract !== undefined ? { contract: event.contract } : {}),
      };
      nodes.set(event.nodeId, nextNode);
      if (previousParent) {
        nodes.set(event.parentNodeId!, {
          ...previousParent,
          childNodeIds: uniq([...previousParent.childNodeIds, event.nodeId]),
        });
      }
      const graph: OrchestrationGraphRecord = {
        ...existing,
        nodeOrder: uniq([...existing.nodeOrder, event.nodeId]),
        nodes,
      };
      graph.status = orchestrationGraphStatus(graph);
      graphs.set(event.graphId, graph);
      break;
    }
    case 'ORCHESTRATION_NODE_READY':
    case 'ORCHESTRATION_NODE_STARTED':
    case 'ORCHESTRATION_NODE_PROGRESS':
    case 'ORCHESTRATION_NODE_BLOCKED':
    case 'ORCHESTRATION_NODE_COMPLETED':
    case 'ORCHESTRATION_NODE_FAILED':
    case 'ORCHESTRATION_NODE_CANCELLED':
    case 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED': {
      if (!existing) return domain;
      const nodes = new Map(existing.nodes);
      const nodeId = 'nodeId' in event ? event.nodeId : undefined;
      if (nodeId) {
        const node = nodes.get(nodeId);
        if (!node) return domain;
        const updatedNode: OrchestrationNodeRecord =
          event.type === 'ORCHESTRATION_NODE_READY'
            ? { ...node, status: 'ready' }
            : event.type === 'ORCHESTRATION_NODE_STARTED'
              ? {
                  ...node,
                  status: 'running',
                  startedAt: node.startedAt ?? timestamp,
                  ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
                  ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
                }
              : event.type === 'ORCHESTRATION_NODE_PROGRESS'
                ? { ...node, latestMessage: event.message }
                : event.type === 'ORCHESTRATION_NODE_BLOCKED'
                  ? { ...node, status: 'blocked', error: event.reason }
                  : event.type === 'ORCHESTRATION_NODE_COMPLETED'
                    ? {
                        ...node,
                        status: 'completed',
                        endedAt: timestamp,
                        latestMessage: event.summary ?? node.latestMessage,
                      }
                    : event.type === 'ORCHESTRATION_NODE_FAILED'
                      ? { ...node, status: 'failed', endedAt: timestamp, error: event.error }
                      : { ...node, status: 'cancelled', endedAt: timestamp, error: event.reason };
        nodes.set(nodeId, updatedNode);
      }
      const graph: OrchestrationGraphRecord = {
        ...existing,
        nodes,
        ...(event.type === 'ORCHESTRATION_NODE_STARTED' ? { startedAt: existing.startedAt ?? timestamp } : {}),
        ...(event.type === 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED'
          ? {
              lastRecursionGuard: {
                depth: event.depth,
                activeAgents: event.activeAgents,
                reason: event.reason,
                ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
                triggeredAt: timestamp,
              },
            }
          : {}),
      };
      graph.status = orchestrationGraphStatus(graph);
      if (graph.status === 'completed' || graph.status === 'failed' || graph.status === 'cancelled') {
        graph.endedAt = graph.endedAt ?? timestamp;
      }
      graphs.set(graph.id, graph);
      break;
    }
  }

  const activeGraphIds = [...graphs.values()]
    .filter((graph) => !['completed', 'failed', 'cancelled'].includes(graph.status))
    .map((graph) => graph.id);

  return {
    ...updateDomainMetadata(domain, event.type),
    graphs,
    activeGraphIds,
    totalGraphs: graphs.size,
    totalCompletedGraphs: [...graphs.values()].filter((graph) => graph.status === 'completed').length,
    totalFailedGraphs: [...graphs.values()].filter((graph) => graph.status === 'failed').length,
    recursionGuardTrips:
      domain.recursionGuardTrips + (event.type === 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED' ? 1 : 0),
  };
}

export function updateCommunicationState(
  domain: CommunicationDomainState,
  event: CommunicationEvent,
): CommunicationDomainState {
  const timestamp = now();
  const records = new Map(domain.records);
  const base: RuntimeCommunicationRecord | undefined =
    event.type === 'COMMUNICATION_SENT' || event.type === 'COMMUNICATION_BLOCKED'
      ? {
          id: event.messageId,
          fromId: event.fromId,
          toId: event.toId,
          scope: event.scope,
          kind: event.kind,
          content: 'content' in event ? event.content : '',
          timestamp,
          status: event.type === 'COMMUNICATION_BLOCKED' ? 'blocked' : 'sent',
          ...(event.fromRole !== undefined ? { fromRole: event.fromRole } : {}),
          ...(event.toRole !== undefined ? { toRole: event.toRole } : {}),
          ...(event.cohort !== undefined ? { cohort: event.cohort } : {}),
          ...(event.wrfcId !== undefined ? { wrfcId: event.wrfcId } : {}),
          ...(event.parentAgentId !== undefined ? { parentAgentId: event.parentAgentId } : {}),
          ...('reason' in event && event.reason !== undefined ? { reason: event.reason } : {}),
        }
      : undefined;

  if (base) {
    records.set(event.messageId, base);
  } else {
    const existing = records.get(event.messageId);
    if (!existing) return domain;
    records.set(event.messageId, {
      ...existing,
      status: event.type === 'COMMUNICATION_DELIVERED' ? 'delivered' : existing.status,
    });
  }

  const recentRecordIds = uniq([event.messageId, ...domain.recentRecordIds]).slice(0, 200);
  return {
    ...updateDomainMetadata(domain, event.type),
    records,
    recentRecordIds,
    totalSent: domain.totalSent + (event.type === 'COMMUNICATION_SENT' ? 1 : 0),
    totalDelivered: domain.totalDelivered + (event.type === 'COMMUNICATION_DELIVERED' ? 1 : 0),
    totalBlocked: domain.totalBlocked + (event.type === 'COMMUNICATION_BLOCKED' ? 1 : 0),
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

export function updatePluginState(domain: PluginDomainState, event: PluginEvent): PluginDomainState {
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
    totalToolsContributed: [...plugins.values()].reduce(
      (sum, value) => sum + (value.active ? value.toolCount : 0),
      0,
    ),
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
    case 'MCP_POLICY_UPDATED':
      return 'configured';
  }
}

export function updateMcpState(domain: McpDomainState, event: McpEvent): McpDomainState {
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
      trustMode:
        event.type === 'MCP_POLICY_UPDATED'
          ? event.trustMode
          : event.type === 'MCP_CONFIGURED'
            ? event.trustMode ?? 'ask-on-risk'
            : 'ask-on-risk',
      role:
        event.type === 'MCP_POLICY_UPDATED'
          ? event.role
          : event.type === 'MCP_CONFIGURED'
            ? event.role ?? 'general'
            : 'general',
      allowedPaths:
        event.type === 'MCP_POLICY_UPDATED'
          ? [...event.allowedPaths]
          : event.type === 'MCP_CONFIGURED'
            ? [...(event.allowedPaths ?? [])]
            : [],
      allowedHosts:
        event.type === 'MCP_POLICY_UPDATED'
          ? [...event.allowedHosts]
          : event.type === 'MCP_CONFIGURED'
            ? [...(event.allowedHosts ?? [])]
            : [],
      schemaFreshness:
        event.type === 'MCP_SCHEMA_QUARANTINED'
          ? 'quarantined'
          : event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
            ? 'stale'
            : 'unknown',
      quarantineReason: event.type === 'MCP_SCHEMA_QUARANTINED' ? event.reason : undefined,
      quarantineDetail: event.type === 'MCP_SCHEMA_QUARANTINED' ? event.detail : undefined,
      quarantineApprovedBy: event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED' ? event.operatorId : undefined,
    };
  servers.set(event.serverId, {
    ...server,
    status:
      event.type === 'MCP_POLICY_UPDATED' ||
      event.type === 'MCP_SCHEMA_QUARANTINED' ||
      event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
        ? server.status
        : mcpStatusForEvent(event),
    transport:
      event.type === 'MCP_CONFIGURED'
        ? event.transport === 'sse' || event.transport === 'http'
          ? event.transport
          : 'stdio'
        : server.transport,
    toolCount: event.type === 'MCP_CONNECTED' ? event.toolCount : server.toolCount,
    connectedAt: event.type === 'MCP_CONNECTED' ? timestamp : server.connectedAt,
    reconnectAttempts: event.type === 'MCP_RECONNECTING' ? event.attempt : server.reconnectAttempts,
    trustMode: event.type === 'MCP_POLICY_UPDATED'
      ? event.trustMode
      : event.type === 'MCP_CONFIGURED'
        ? event.trustMode ?? server.trustMode
        : server.trustMode,
    role: event.type === 'MCP_POLICY_UPDATED'
      ? event.role
      : event.type === 'MCP_CONFIGURED'
        ? event.role ?? server.role
        : server.role,
    allowedPaths: event.type === 'MCP_POLICY_UPDATED'
      ? [...event.allowedPaths]
      : event.type === 'MCP_CONFIGURED'
        ? [...(event.allowedPaths ?? server.allowedPaths)]
        : server.allowedPaths,
    allowedHosts: event.type === 'MCP_POLICY_UPDATED'
      ? [...event.allowedHosts]
      : event.type === 'MCP_CONFIGURED'
        ? [...(event.allowedHosts ?? server.allowedHosts)]
        : server.allowedHosts,
    schemaFreshness:
      event.type === 'MCP_SCHEMA_QUARANTINED'
        ? 'quarantined'
        : event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
          ? 'stale'
          : event.type === 'MCP_CONNECTED'
            ? 'fresh'
            : server.schemaFreshness,
    quarantineReason:
      event.type === 'MCP_SCHEMA_QUARANTINED'
        ? event.reason
        : server.quarantineReason,
    quarantineDetail:
      event.type === 'MCP_SCHEMA_QUARANTINED'
        ? event.detail
        : server.quarantineDetail,
    quarantineApprovedBy:
      event.type === 'MCP_SCHEMA_QUARANTINE_APPROVED'
        ? event.operatorId
        : server.quarantineApprovedBy,
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

function transportStateForEvent(event: TransportEvent): AcpTransportState | DaemonTransportState {
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

export function updateTransportState(
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
        transportState: nextTransportState as DaemonTransportState,
        isRunning:
          event.type === 'TRANSPORT_CONNECTED'
            ? true
            : event.type === 'TRANSPORT_DISCONNECTED'
              ? false
              : daemon.isRunning,
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

export function updateIntegrationDomainFromRecord(
  domain: IntegrationDomainState,
  record: IntegrationRecord,
  source: string,
): IntegrationDomainState {
  const integrations = new Map(domain.integrations);
  const previous = integrations.get(record.id);
  integrations.set(record.id, record);

  const problemStatuses: IntegrationStatus[] = ['degraded', 'error'];
  const healthyIds = [...integrations.values()]
    .filter((value) => value.status === 'healthy')
    .map((value) => value.id);
  const problemIds = [...integrations.values()]
    .filter((value) => problemStatuses.includes(value.status))
    .map((value) => value.id);

  return {
    ...updateDomainMetadata(domain, source),
    integrations,
    healthyIds,
    problemIds,
    totalOperations:
      domain.totalOperations + ((record.successCount ?? 0) - (previous?.successCount ?? 0)),
    totalErrors: domain.totalErrors + ((record.errorCount ?? 0) - (previous?.errorCount ?? 0)),
  };
}

export function updateAutomationDomainFromSource(
  domain: AutomationDomainState,
  sourceRecord: AutomationSourceRecord,
  source: string,
): AutomationDomainState {
  const sources = new Map(domain.sources);
  sources.set(sourceRecord.id, sourceRecord);
  const sourceIds = [...sources.values()]
    .sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt)
    .map((record) => record.id);
  return {
    ...updateDomainMetadata(domain, source),
    sources,
    sourceIds,
  };
}

export function updateAutomationDomainFromJob(
  domain: AutomationDomainState,
  job: AutomationJob,
  source: string,
): AutomationDomainState {
  const jobs = new Map(domain.jobs);
  const sources = new Map(domain.sources);
  jobs.set(job.id, job);
  sources.set(job.source.id, job.source);
  const allRuns = [...domain.runs.values()];
  const totalDeadLettered = allRuns.reduce(
    (count, run) => count + (run.deliveryAttempts?.filter((attempt) => attempt.status === 'dead_lettered').length ?? 0),
    0,
  );
  return {
    ...updateDomainMetadata(domain, source),
    jobs,
    jobIds: [...jobs.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt)
      .map((record) => record.id),
    sources,
    sourceIds: [...sources.values()]
      .sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt)
      .map((record) => record.id),
    totalJobs: jobs.size,
    totalRuns: allRuns.length,
    totalSucceeded: allRuns.filter((run) => run.status === 'completed').length,
    totalFailed: allRuns.filter((run) => run.status === 'failed').length,
    totalCancelled: allRuns.filter((run) => run.status === 'cancelled').length,
    totalDeadLettered,
  };
}

export function updateAutomationDomainFromRun(
  domain: AutomationDomainState,
  run: AutomationRun,
  source: string,
): AutomationDomainState {
  const runs = new Map(domain.runs);
  const sources = new Map(domain.sources);
  runs.set(run.id, run);
  sources.set(run.triggeredBy.id, run.triggeredBy);
  const allRuns = [...runs.values()];
  const totalDeadLettered = allRuns.reduce(
    (count, record) => count + (record.deliveryAttempts?.filter((attempt) => attempt.status === 'dead_lettered').length ?? 0),
    0,
  );
  return {
    ...updateDomainMetadata(domain, source),
    runs,
    runIds: allRuns
      .sort((a, b) => b.queuedAt - a.queuedAt || a.id.localeCompare(b.id))
      .map((record) => record.id),
    activeRunIds: allRuns
      .filter((record) => record.status === 'queued' || record.status === 'running')
      .map((record) => record.id),
    failedRunIds: allRuns
      .filter((record) => record.status === 'failed')
      .map((record) => record.id),
    sources,
    sourceIds: [...sources.values()]
      .sort((a, b) => a.label.localeCompare(b.label) || a.createdAt - b.createdAt)
      .map((record) => record.id),
    totalJobs: domain.jobs.size,
    totalRuns: allRuns.length,
    totalSucceeded: allRuns.filter((record) => record.status === 'completed').length,
    totalFailed: allRuns.filter((record) => record.status === 'failed').length,
    totalCancelled: allRuns.filter((record) => record.status === 'cancelled').length,
    totalDeadLettered,
  };
}

function buildBindingIdsBySurface(
  bindings: readonly AutomationRouteBinding[],
): Readonly<Record<string, readonly string[]>> {
  const grouped: Record<string, string[]> = {
    slack: [],
    discord: [],
    web: [],
    ntfy: [],
    webhook: [],
    tui: [],
    service: [],
  };
  for (const binding of bindings) {
    grouped[binding.surfaceKind] ??= [];
    grouped[binding.surfaceKind]!.push(binding.id);
  }
  return grouped;
}

export function updateRoutesDomainFromBinding(
  domain: RoutesDomainState,
  binding: AutomationRouteBinding,
  source: string,
): RoutesDomainState {
  const bindings = new Map(domain.bindings);
  bindings.set(binding.id, binding);
  const records = [...bindings.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
  return {
    ...updateDomainMetadata(domain, source),
    bindings,
    bindingIds: records.map((record) => record.id),
    bindingIdsBySurface: buildBindingIdsBySurface(records),
    activeBindingIds: records.map((record) => record.id),
    recentBindingIds: records.slice(0, 20).map((record) => record.id),
    totalBindings: records.length,
    totalResolved: records.filter((record) => record.sessionId || record.jobId || record.runId).length,
  };
}

export function updateRouteFailureState(
  domain: RoutesDomainState,
  _surfaceKind: AutomationSurfaceKind,
  _externalId: string,
  source: string,
): RoutesDomainState {
  return {
    ...updateDomainMetadata(domain, source),
    totalFailures: domain.totalFailures + 1,
  };
}

export function updateControlPlaneDomainFromClient(
  domain: ControlPlaneDomainState,
  client: ControlPlaneClientRecord,
  source: string,
): ControlPlaneDomainState {
  const clients = new Map(domain.clients);
  const previous = clients.get(client.id);
  clients.set(client.id, client);
  const records = [...clients.values()].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id));
  const active = records.filter((record) => record.connected);
  return {
    ...updateDomainMetadata(domain, source),
    clients,
    activeClients: new Map(active.map((record) => [record.id, record])),
    clientIds: records.map((record) => record.id),
    activeClientIds: active.map((record) => record.id),
    isRunning: domain.isRunning || active.length > 0,
    connectionState:
      active.length > 0 ? 'connected' : domain.isRunning ? 'disconnected' : domain.connectionState,
    totalConnections: domain.totalConnections + (client.connected && !previous?.connected ? 1 : 0),
    totalDisconnects: domain.totalDisconnects + (!client.connected && previous?.connected ? 1 : 0),
  };
}

export function patchControlPlaneDomain(
  domain: ControlPlaneDomainState,
  patch: Partial<ControlPlaneDomainState>,
  source: string,
): ControlPlaneDomainState {
  return {
    ...updateDomainMetadata(domain, source),
    ...patch,
    totalFailures:
      patch.connectionState === 'terminal_failure'
        ? domain.totalFailures + 1
        : patch.totalFailures ?? domain.totalFailures,
  };
}

export function updateDeliveryDomainFromAttempt(
  domain: DeliveryDomainState,
  attempt: AutomationDeliveryAttempt,
  source: string,
): DeliveryDomainState {
  const deliveryAttempts = new Map(domain.deliveryAttempts);
  deliveryAttempts.set(attempt.id, attempt);
  const attempts = [...deliveryAttempts.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.id.localeCompare(b.id));
  return {
    ...updateDomainMetadata(domain, source),
    deliveryAttempts,
    attemptIds: attempts.map((record) => record.id),
    pendingAttemptIds: attempts.filter((record) => record.status === 'pending' || record.status === 'sending').map((record) => record.id),
    failedAttemptIds: attempts.filter((record) => record.status === 'failed').map((record) => record.id),
    deadLetterIds: attempts.filter((record) => record.status === 'dead_lettered').map((record) => record.id),
    totalQueued: attempts.length,
    totalStarted: attempts.filter((record) => record.startedAt !== undefined || record.status !== 'pending').length,
    totalSucceeded: attempts.filter((record) => record.status === 'sent').length,
    totalFailed: attempts.filter((record) => record.status === 'failed').length,
    totalDeadLettered: attempts.filter((record) => record.status === 'dead_lettered').length,
  };
}

export function updateSurfaceDomainFromRecord(
  domain: SurfaceDomainState,
  record: SurfaceRecord,
  source: string,
): SurfaceDomainState {
  const surfaces = new Map(domain.surfaces);
  surfaces.set(record.id, record);
  const records = [...surfaces.values()].sort((a, b) => a.label.localeCompare(b.label) || a.configuredAt - b.configuredAt);
  return {
    ...updateDomainMetadata(domain, source),
    surfaces,
    surfaceIds: records.map((entry) => entry.id),
    enabledSurfaceIds: records.filter((entry) => entry.enabled).map((entry) => entry.id),
    problemSurfaceIds: records.filter((entry) => entry.state === 'degraded' || entry.state === 'error').map((entry) => entry.id),
    totalHealthy: records.filter((entry) => entry.state === 'healthy').length,
    totalDegraded: records.filter((entry) => entry.state === 'degraded' || entry.state === 'error').length,
    totalDisabled: records.filter((entry) => !entry.enabled || entry.state === 'disabled').length,
  };
}

export function updateWatcherDomainFromRecord(
  domain: WatcherDomainState,
  record: WatcherRecord,
  source: string,
): WatcherDomainState {
  const watchers = new Map(domain.watchers);
  watchers.set(record.id, record);
  const records = [...watchers.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return {
    ...updateDomainMetadata(domain, source),
    watchers,
    watcherIds: records.map((entry) => entry.id),
    activeWatcherIds: records.filter((entry) => entry.state === 'running' || entry.state === 'starting' || entry.state === 'degraded').map((entry) => entry.id),
    failedWatcherIds: records.filter((entry) => entry.state === 'failed').map((entry) => entry.id),
    totalStarted: records.filter((entry) => entry.state === 'running' || entry.state === 'starting').length,
    totalStopped: records.filter((entry) => entry.state === 'stopped').length,
    totalFailed: records.filter((entry) => entry.state === 'failed').length,
    totalHeartbeats: records.filter((entry) => entry.lastHeartbeatAt !== undefined).length,
    totalDegraded: records.filter((entry) => entry.state === 'degraded' || entry.sourceStatus === 'degraded').length,
    totalLagged: records.filter((entry) => entry.sourceStatus === 'lagging' || entry.sourceStatus === 'stale').length,
  };
}

export function syncSessionStatePatch(
  domain: SessionDomainState,
  patch: Partial<SessionDomainState>,
  source: string,
): SessionDomainState {
  return {
    ...updateDomainMetadata(domain, source),
    ...patch,
  };
}

export {
  transitionTaskDomainRecord,
  updateTaskDomainFromRecord,
  transitionAgentDomainRecord,
};
