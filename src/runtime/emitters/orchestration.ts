/**
 * Orchestration emitters — typed emission wrappers for OrchestrationEvent domain.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '../events/index.ts';
import type { OrchestrationTaskContract } from '@pellux/goodvibes-sdk/platform/runtime/events/orchestration';
import type { EmitterContext } from './index.ts';

export function emitOrchestrationGraphCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; title: string; mode: 'single-worker' | 'parallel-workers' | 'review-loop' | 'graph-execute' },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_GRAPH_CREATED', { type: 'ORCHESTRATION_GRAPH_CREATED', ...data }, ctx));
}

export function emitOrchestrationNodeAdded(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; nodeId: string; title: string; role: 'planner' | 'engineer' | 'reviewer' | 'fixer' | 'verifier' | 'researcher' | 'integrator'; parentNodeId?: string; dependsOn?: string[]; taskId?: string; agentId?: string; contract?: OrchestrationTaskContract },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_NODE_ADDED', { type: 'ORCHESTRATION_NODE_ADDED', ...data }, ctx));
}

export function emitOrchestrationNodeReady(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; nodeId: string },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_NODE_READY', { type: 'ORCHESTRATION_NODE_READY', ...data }, ctx));
}

export function emitOrchestrationNodeStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; nodeId: string; taskId?: string; agentId?: string },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_NODE_STARTED', { type: 'ORCHESTRATION_NODE_STARTED', ...data }, ctx));
}

export function emitOrchestrationNodeProgress(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; nodeId: string; message: string },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_NODE_PROGRESS', { type: 'ORCHESTRATION_NODE_PROGRESS', ...data }, ctx));
}

export function emitOrchestrationNodeBlocked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; nodeId: string; reason: string },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_NODE_BLOCKED', { type: 'ORCHESTRATION_NODE_BLOCKED', ...data }, ctx));
}

export function emitOrchestrationNodeCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; nodeId: string; summary?: string },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_NODE_COMPLETED', { type: 'ORCHESTRATION_NODE_COMPLETED', ...data }, ctx));
}

export function emitOrchestrationNodeFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; nodeId: string; error: string },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_NODE_FAILED', { type: 'ORCHESTRATION_NODE_FAILED', ...data }, ctx));
}

export function emitOrchestrationNodeCancelled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; nodeId: string; reason?: string },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_NODE_CANCELLED', { type: 'ORCHESTRATION_NODE_CANCELLED', ...data }, ctx));
}

export function emitOrchestrationRecursionGuardTriggered(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { graphId: string; nodeId?: string; depth: number; activeAgents: number; reason: string },
): void {
  bus.emit('orchestration', createEventEnvelope('ORCHESTRATION_RECURSION_GUARD_TRIGGERED', { type: 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED', ...data }, ctx));
}
