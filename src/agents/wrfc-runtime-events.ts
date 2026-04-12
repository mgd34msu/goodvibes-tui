import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { WrfcState } from './wrfc-types.ts';
import {
  emitOrchestrationGraphCreated,
  emitOrchestrationNodeAdded,
  emitOrchestrationNodeCompleted,
  emitOrchestrationNodeFailed,
  emitOrchestrationNodeStarted,
  emitWorkflowAutoCommitted,
  emitWorkflowCascadeAborted,
  emitWorkflowChainCreated,
  emitWorkflowChainPassed,
  emitWorkflowGateResult,
  emitWorkflowStateChanged,
} from '../runtime/emitters/index.ts';

export type WorkflowContext = { sessionId: string; traceId: string; source: string };
export type WrfcNodeRole = 'engineer' | 'reviewer' | 'fixer' | 'verifier';

export function createWrfcWorkflowContext(sessionId: string, chainId: string): WorkflowContext {
  return {
    sessionId,
    traceId: `${sessionId}:workflow:${chainId}`,
    source: 'wrfc-controller',
  };
}

export function createWrfcOrchestrationGraphId(chainId: string): string {
  return `wrfc:${chainId}`;
}

export function emitWrfcStateChanged(
  runtimeBus: RuntimeEventBus,
  sessionId: string,
  chainId: string,
  from: WrfcState,
  to: WrfcState,
): void {
  emitWorkflowStateChanged(runtimeBus, createWrfcWorkflowContext(sessionId, chainId), { chainId, from, to });
}

export function emitWrfcChainCreated(runtimeBus: RuntimeEventBus, sessionId: string, chainId: string, task: string): void {
  emitWorkflowChainCreated(runtimeBus, createWrfcWorkflowContext(sessionId, chainId), { chainId, task });
}

export function emitWrfcGateResult(runtimeBus: RuntimeEventBus, sessionId: string, chainId: string, gate: string, passed: boolean): void {
  emitWorkflowGateResult(runtimeBus, createWrfcWorkflowContext(sessionId, chainId), { chainId, gate, passed });
}

export function emitWrfcChainPassed(runtimeBus: RuntimeEventBus, sessionId: string, chainId: string): void {
  emitWorkflowChainPassed(runtimeBus, createWrfcWorkflowContext(sessionId, chainId), { chainId });
}

export function emitWrfcAutoCommitted(
  runtimeBus: RuntimeEventBus,
  sessionId: string,
  chainId: string,
  commitHash?: string,
): void {
  emitWorkflowAutoCommitted(runtimeBus, createWrfcWorkflowContext(sessionId, chainId), { chainId, commitHash });
}

export function emitWrfcCascadeAbort(
  runtimeBus: RuntimeEventBus,
  sessionId: string,
  chainId: string,
  reason: string,
): void {
  emitWorkflowCascadeAborted(runtimeBus, createWrfcWorkflowContext(sessionId, chainId), { chainId, reason });
}

export function emitWrfcGraphCreated(
  runtimeBus: RuntimeEventBus,
  sessionId: string,
  chainId: string,
  title: string,
): void {
  emitOrchestrationGraphCreated(runtimeBus, createWrfcWorkflowContext(sessionId, chainId), {
    graphId: createWrfcOrchestrationGraphId(chainId),
    title,
    mode: 'review-loop',
  });
}

export function startWrfcOrchestrationNode(
  runtimeBus: RuntimeEventBus,
  sessionId: string,
  chainId: string,
  suffix: string,
  role: WrfcNodeRole,
  title: string,
  agentId?: string,
): string {
  const nodeId = `${chainId}:${suffix}`;
  const context = {
    sessionId,
    traceId: `${sessionId}:orchestration:${chainId}:${suffix}`,
    source: 'wrfc-controller',
    ...(agentId !== undefined ? { agentId } : {}),
  };
  emitOrchestrationNodeAdded(runtimeBus, context, {
    graphId: createWrfcOrchestrationGraphId(chainId),
    nodeId,
    title,
    role,
    ...(agentId !== undefined ? { agentId } : {}),
  });
  emitOrchestrationNodeStarted(runtimeBus, context, {
    graphId: createWrfcOrchestrationGraphId(chainId),
    nodeId,
    ...(agentId !== undefined ? { agentId } : {}),
  });
  return nodeId;
}

export function completeWrfcOrchestrationNode(
  runtimeBus: RuntimeEventBus,
  sessionId: string,
  chainId: string,
  nodeId: string,
  summary?: string,
): void {
  emitOrchestrationNodeCompleted(runtimeBus, {
    sessionId,
    traceId: `${sessionId}:orchestration:${nodeId}:complete`,
    source: 'wrfc-controller',
  }, {
    graphId: createWrfcOrchestrationGraphId(chainId),
    nodeId,
    ...(summary !== undefined ? { summary } : {}),
  });
}

export function failWrfcOrchestrationNode(
  runtimeBus: RuntimeEventBus,
  sessionId: string,
  chainId: string,
  nodeId: string,
  error: string,
): void {
  emitOrchestrationNodeFailed(runtimeBus, {
    sessionId,
    traceId: `${sessionId}:orchestration:${nodeId}:fail`,
    source: 'wrfc-controller',
  }, {
    graphId: createWrfcOrchestrationGraphId(chainId),
    nodeId,
    error,
  });
}
