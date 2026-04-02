/**
 * Agent emitters — typed emission wrappers for AgentEvent domain.
 */
import { createEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { EmitterContext } from './index.ts';

/** Emit AGENT_SPAWNING when an agent is being initialised. */
export function emitAgentSpawning(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { agentId: string; taskId?: string; task: string }
): void {
  bus.emit('agents', createEventEnvelope('AGENT_SPAWNING', { type: 'AGENT_SPAWNING', ...data }, ctx));
}

/** Emit AGENT_RUNNING when an agent starts active execution. */
export function emitAgentRunning(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { agentId: string; taskId?: string }
): void {
  bus.emit('agents', createEventEnvelope('AGENT_RUNNING', { type: 'AGENT_RUNNING', ...data }, ctx));
}

/** Emit AGENT_AWAITING_MESSAGE when an agent is waiting to send to LLM. */
export function emitAgentAwaitingMessage(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { agentId: string; taskId?: string }
): void {
  bus.emit('agents', createEventEnvelope('AGENT_AWAITING_MESSAGE', { type: 'AGENT_AWAITING_MESSAGE', ...data }, ctx));
}

/** Emit AGENT_AWAITING_TOOL when an agent is waiting for a tool call. */
export function emitAgentAwaitingTool(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { agentId: string; taskId?: string; callId: string; tool: string }
): void {
  bus.emit('agents', createEventEnvelope('AGENT_AWAITING_TOOL', { type: 'AGENT_AWAITING_TOOL', ...data }, ctx));
}

/** Emit AGENT_FINALIZING when an agent is assembling its final output. */
export function emitAgentFinalizing(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { agentId: string; taskId?: string }
): void {
  bus.emit('agents', createEventEnvelope('AGENT_FINALIZING', { type: 'AGENT_FINALIZING', ...data }, ctx));
}

/** Emit AGENT_COMPLETED when an agent finishes successfully. */
export function emitAgentCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { agentId: string; taskId?: string; durationMs: number }
): void {
  bus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', ...data }, ctx));
}

/** Emit AGENT_FAILED when an agent fails. */
export function emitAgentFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { agentId: string; taskId?: string; error: string; durationMs: number }
): void {
  bus.emit('agents', createEventEnvelope('AGENT_FAILED', { type: 'AGENT_FAILED', ...data }, ctx));
}

/** Emit AGENT_CANCELLED when an agent is cancelled. */
export function emitAgentCancelled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { agentId: string; taskId?: string; reason?: string }
): void {
  bus.emit('agents', createEventEnvelope('AGENT_CANCELLED', { type: 'AGENT_CANCELLED', ...data }, ctx));
}
