import type { ConversationManager } from '../core/conversation.ts';
import type { HookDispatcher } from '../hooks/index.ts';
import type { HookCategory, HookEventPath, HookPhase } from '@pellux/goodvibes-sdk/platform/hooks/types';
import type { MutableRuntimeState } from './context.ts';
import type { AgentEvent, OpsEvent, RuntimeEventBus, WorkflowEvent } from './events/index.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { emitSessionResumed } from './emitters/index.ts';
import { HelperModel } from '../config/helper-model.ts';
import type { ConfigManager } from '../config/manager.ts';
import { formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from './session-return-context.ts';
import type { SharedSessionBroker } from '../control-plane/index.ts';
import type { SessionManager } from '../sessions/manager.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

interface FireHookOptions {
  readonly hookDispatcher: HookDispatcher;
  readonly runtime: MutableRuntimeState;
}

function fireHook(
  options: FireHookOptions,
  path: HookEventPath,
  phase: HookPhase,
  category: HookCategory,
  specific: string,
  payload: Record<string, unknown>,
): void {
  options.hookDispatcher.fire({
    path,
    phase,
    category,
    specific,
    sessionId: options.runtime.sessionId,
    timestamp: Date.now(),
    payload,
  }).catch((err: unknown) => logger.debug('Hook bridge fire error', { path, error: summarizeError(err) }));
}

export interface ResumeSessionOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtime: MutableRuntimeState;
  readonly conversation: ConversationManager;
  readonly requestRender: () => void;
  readonly onSessionIdChanged?: (sessionId: string) => void;
  readonly sharedSessionBroker: Pick<SharedSessionBroker, 'reopenSession'>;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly hookDispatcher: HookDispatcher;
  readonly sessionManager: SessionManager;
  readonly panelManager: PanelManager;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'get' | 'getCurrentModel' | 'getForModel'>;
}

export function createResumeSessionHandler(options: ResumeSessionOptions): (sessionId: string) => void {
  const fireOptions: FireHookOptions = {
    hookDispatcher: options.hookDispatcher,
    runtime: options.runtime,
  };
  return (sessionId: string): void => {
    try {
      const { messages, meta } = options.sessionManager.load(sessionId);
      emitSessionResumed(options.runtimeBus, {
        sessionId: options.runtime.sessionId,
        traceId: `${options.runtime.sessionId}:session-resume:${sessionId}`,
        source: 'bootstrap',
      }, {
        sessionId,
        turnCount: messages.length,
      });
      options.conversation.fromJSON({
        messages: messages as Parameters<typeof options.conversation.fromJSON>[0]['messages'],
        title: meta.title,
        titleSource: meta.titleSource,
      });
      options.runtime.sessionId = sessionId;
      options.onSessionIdChanged?.(sessionId);
      if (meta?.model) options.runtime.model = meta.model;
      if (meta?.provider) options.runtime.provider = meta.provider;
      options.writeLastSessionPointer(sessionId);
      void options.sharedSessionBroker.reopenSession(sessionId).catch(() => {});
      options.conversation.log(`Resumed session: ${sessionId}`, { fg: '135' });
      const reopenedPanels: string[] = [];
      if (meta.returnContext?.openPanels?.length) {
        for (const panelId of meta.returnContext.openPanels.slice(0, 4)) {
          try {
            options.panelManager.open(panelId);
            reopenedPanels.push(panelId);
          } catch {
            // Ignore unavailable panels during restore.
          }
        }
        if (reopenedPanels.length > 0) options.panelManager.show();
      }
      const returnContextMode = getReturnContextMode(options.configManager);
      if (returnContextMode !== 'off' && meta.returnContext) {
        for (const line of formatReturnContextForDisplay(meta.returnContext)) {
          options.conversation.log(`Resume: ${line}`, { fg: '244' });
        }
        if (reopenedPanels.length > 0) {
          options.conversation.log(`Resume: Reopened panels: ${reopenedPanels.join(', ')}`, { fg: '244' });
        }
        if ((meta.returnContext.remoteRunners?.length ?? 0) > 0) {
          options.conversation.log(`Resume: Remote re-entry -> /remote recover ${meta.returnContext.remoteRunners![0]}`, { fg: '244' });
        }
        if ((meta.returnContext.worktreePaths?.length ?? 0) > 0) {
          options.conversation.log('Resume: Worktree re-entry -> /worktree review', { fg: '244' });
        }
        if (returnContextMode === 'assisted') {
          const helperModel = new HelperModel({
            configManager: options.configManager,
            providerRegistry: options.providerRegistry,
          });
          void maybeAssistReturnContextSummary(options.configManager, helperModel, meta.returnContext).then((assisted) => {
            if (!assisted.assistedNarrative) return;
            options.conversation.log(`Resume: ${assisted.assistedNarrative}`, { fg: '244' });
            options.requestRender();
          });
        }
      }
      fireHook(fireOptions, 'Lifecycle:session:load', 'Lifecycle', 'session', 'load', { sessionId });
    } catch (error) {
      logger.debug('resumeSession failed', { error: summarizeError(error) });
      options.conversation.log('Failed to resume session.', { fg: '#ef4444' });
    }
    options.requestRender();
  };
}

export interface HookBridgeRegistrationOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly hookDispatcher: HookDispatcher;
  readonly runtime: MutableRuntimeState;
}

export function registerBootstrapHookBridge(
  options: HookBridgeRegistrationOptions,
): Array<() => void> {
  const fireOptions: FireHookOptions = {
    hookDispatcher: options.hookDispatcher,
    runtime: options.runtime,
  };
  const unsubs: Array<() => void> = [];
  const { runtimeBus } = options;

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>>('AGENT_SPAWNING', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:agent:spawned', 'Lifecycle', 'agent', 'spawned', { agentId: payload.agentId, task: payload.task });
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:agent:completed', 'Lifecycle', 'agent', 'completed', {
      agentId: payload.agentId,
      result: {
        durationMs: payload.durationMs,
        ...(payload.output !== undefined ? { output: payload.output } : {}),
        ...(payload.toolCallsMade !== undefined ? { toolCallsMade: payload.toolCallsMade } : {}),
      },
    });
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
    const specific = payload.error === 'Agent cancelled' || payload.error.includes('cancelled') ? 'cancelled' : 'failed';
    fireHook(fireOptions, `Lifecycle:agent:${specific}` as HookEventPath, 'Lifecycle', 'agent', specific, { agentId: payload.agentId, error: payload.error });
  }));

  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_CREATED' }>>('WORKFLOW_CHAIN_CREATED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:workflow:started', 'Lifecycle', 'workflow', 'started', { chainId: payload.chainId, task: payload.task });
  }));
  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:workflow:completed', 'Lifecycle', 'workflow', 'completed', { chainId: payload.chainId });
  }));
  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:workflow:failed', 'Lifecycle', 'workflow', 'failed', { chainId: payload.chainId, reason: payload.reason });
  }));
  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_REVIEW_COMPLETED' }>>('WORKFLOW_REVIEW_COMPLETED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:workflow:reviewed', 'Lifecycle', 'workflow', 'reviewed', {
      chainId: payload.chainId,
      score: payload.score,
      passed: payload.passed,
    });
  }));
  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_FIX_ATTEMPTED' }>>('WORKFLOW_FIX_ATTEMPTED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:workflow:fix-attempted', 'Lifecycle', 'workflow', 'fix-attempted', {
      chainId: payload.chainId,
      attempt: payload.attempt,
      maxAttempts: payload.maxAttempts,
    });
  }));
  unsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_GATE_RESULT' }>>('WORKFLOW_GATE_RESULT', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:workflow:gate-result', 'Lifecycle', 'workflow', 'gate-result', {
      chainId: payload.chainId,
      gate: payload.gate,
      passed: payload.passed,
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/orchestration').OrchestrationEvent, { type: 'ORCHESTRATION_GRAPH_CREATED' }>>('ORCHESTRATION_GRAPH_CREATED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:orchestration:graph-created', 'Lifecycle', 'orchestration', 'graph-created', {
      graphId: payload.graphId,
      title: payload.title,
      mode: payload.mode,
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/orchestration').OrchestrationEvent, { type: 'ORCHESTRATION_NODE_STARTED' }>>('ORCHESTRATION_NODE_STARTED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:orchestration:node-started', 'Lifecycle', 'orchestration', 'node-started', {
      graphId: payload.graphId,
      nodeId: payload.nodeId,
      ...(payload.taskId !== undefined ? { taskId: payload.taskId } : {}),
      ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/orchestration').OrchestrationEvent, { type: 'ORCHESTRATION_NODE_COMPLETED' }>>('ORCHESTRATION_NODE_COMPLETED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:orchestration:node-completed', 'Lifecycle', 'orchestration', 'node-completed', {
      graphId: payload.graphId,
      nodeId: payload.nodeId,
      ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/orchestration').OrchestrationEvent, { type: 'ORCHESTRATION_NODE_FAILED' }>>('ORCHESTRATION_NODE_FAILED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:orchestration:node-failed', 'Lifecycle', 'orchestration', 'node-failed', {
      graphId: payload.graphId,
      nodeId: payload.nodeId,
      error: payload.error,
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/orchestration').OrchestrationEvent, { type: 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED' }>>('ORCHESTRATION_RECURSION_GUARD_TRIGGERED', ({ payload }) => {
    fireHook(fireOptions, 'Change:orchestration:recursion-guard', 'Change', 'orchestration', 'recursion-guard', {
      graphId: payload.graphId,
      ...(payload.nodeId !== undefined ? { nodeId: payload.nodeId } : {}),
      depth: payload.depth,
      activeAgents: payload.activeAgents,
      reason: payload.reason,
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/communication').CommunicationEvent, { type: 'COMMUNICATION_SENT' }>>('COMMUNICATION_SENT', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:communication:sent', 'Lifecycle', 'communication', 'sent', {
      messageId: payload.messageId,
      fromId: payload.fromId,
      toId: payload.toId,
      scope: payload.scope,
      kind: payload.kind,
      ...(payload.fromRole !== undefined ? { fromRole: payload.fromRole } : {}),
      ...(payload.toRole !== undefined ? { toRole: payload.toRole } : {}),
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/communication').CommunicationEvent, { type: 'COMMUNICATION_DELIVERED' }>>('COMMUNICATION_DELIVERED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:communication:delivered', 'Lifecycle', 'communication', 'delivered', {
      messageId: payload.messageId,
      fromId: payload.fromId,
      toId: payload.toId,
      scope: payload.scope,
      kind: payload.kind,
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/communication').CommunicationEvent, { type: 'COMMUNICATION_BLOCKED' }>>('COMMUNICATION_BLOCKED', ({ payload }) => {
    fireHook(fireOptions, 'Change:communication:blocked', 'Change', 'communication', 'blocked', {
      messageId: payload.messageId,
      fromId: payload.fromId,
      toId: payload.toId,
      scope: payload.scope,
      kind: payload.kind,
      reason: payload.reason,
      ...(payload.fromRole !== undefined ? { fromRole: payload.fromRole } : {}),
      ...(payload.toRole !== undefined ? { toRole: payload.toRole } : {}),
    });
  }));
  unsubs.push(runtimeBus.on<Extract<OpsEvent, { type: 'OPS_CONTEXT_WARNING' }>>('OPS_CONTEXT_WARNING', ({ payload: { usage, threshold } }) => {
    const specific = usage >= threshold ? 'exceeded' : 'warning';
    fireHook(fireOptions, `Change:budget:${specific}` as HookEventPath, 'Change', 'budget', specific, { usage, threshold });
  }));

  return unsubs;
}
