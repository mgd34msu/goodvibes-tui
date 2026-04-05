/**
 * Workflow emitters — typed emission wrappers for WRFC workflow events.
 */
import { createEventEnvelope } from '../events/envelope.ts';
import type { RuntimeEventBus } from '../events/index.ts';
import type { WrfcState } from '../../agents/wrfc-types.ts';
import type { EmitterContext } from './index.ts';

export function emitWorkflowChainCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { chainId: string; task: string }
): void {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_CREATED', { type: 'WORKFLOW_CHAIN_CREATED', ...data }, ctx));
}

export function emitWorkflowStateChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { chainId: string; from: WrfcState; to: WrfcState }
): void {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_STATE_CHANGED', { type: 'WORKFLOW_STATE_CHANGED', ...data }, ctx));
}

export function emitWorkflowReviewCompleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { chainId: string; score: number; passed: boolean }
): void {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_REVIEW_COMPLETED', { type: 'WORKFLOW_REVIEW_COMPLETED', ...data }, ctx));
}

export function emitWorkflowFixAttempted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { chainId: string; attempt: number; maxAttempts: number }
): void {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_FIX_ATTEMPTED', { type: 'WORKFLOW_FIX_ATTEMPTED', ...data }, ctx));
}

export function emitWorkflowGateResult(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { chainId: string; gate: string; passed: boolean }
): void {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_GATE_RESULT', { type: 'WORKFLOW_GATE_RESULT', ...data }, ctx));
}

export function emitWorkflowChainPassed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { chainId: string }
): void {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_PASSED', { type: 'WORKFLOW_CHAIN_PASSED', ...data }, ctx));
}

export function emitWorkflowChainFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { chainId: string; reason: string }
): void {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_CHAIN_FAILED', { type: 'WORKFLOW_CHAIN_FAILED', ...data }, ctx));
}

export function emitWorkflowAutoCommitted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { chainId: string; commitHash?: string }
): void {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_AUTO_COMMITTED', { type: 'WORKFLOW_AUTO_COMMITTED', ...data }, ctx));
}

export function emitWorkflowCascadeAborted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { chainId: string; reason: string }
): void {
  bus.emit('workflows', createEventEnvelope('WORKFLOW_CASCADE_ABORTED', { type: 'WORKFLOW_CASCADE_ABORTED', ...data }, ctx));
}
