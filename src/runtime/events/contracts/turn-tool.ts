import { validateEventFields } from './shared.ts';
import type { ContractResult } from './shared.ts';

export function validateTurnStarted(v: unknown): ContractResult {
  return validateEventFields('TURN_STARTED', v, [
    { key: 'turnId', kind: 'string' },
    { key: 'prompt', kind: 'string' },
  ]);
}

export function validateTurnStreaming(v: unknown): ContractResult {
  return validateEventFields('TURN_STREAMING', v, [
    { key: 'turnId', kind: 'string' },
    { key: 'delta', kind: 'string' },
    { key: 'deltaIndex', kind: 'number' },
  ]);
}

export function validateTurnCompleted(v: unknown): ContractResult {
  return validateEventFields('TURN_COMPLETED', v, [
    { key: 'turnId', kind: 'string' },
    { key: 'durationMs', kind: 'number' },
  ]);
}

export function validateTurnFailed(v: unknown): ContractResult {
  return validateEventFields('TURN_FAILED', v, [
    { key: 'turnId', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}

export function validateTurnCancelled(v: unknown): ContractResult {
  return validateEventFields('TURN_CANCELLED', v, [
    { key: 'turnId', kind: 'string' },
  ]);
}

export function validateToolReceived(v: unknown): ContractResult {
  return validateEventFields('TOOL_RECEIVED', v, [
    { key: 'callId', kind: 'string' },
    { key: 'turnId', kind: 'string' },
    { key: 'toolName', kind: 'string' },
    { key: 'args', kind: 'object' },
  ]);
}

export function validateToolSucceeded(v: unknown): ContractResult {
  return validateEventFields('TOOL_SUCCEEDED', v, [
    { key: 'callId', kind: 'string' },
    { key: 'turnId', kind: 'string' },
    { key: 'durationMs', kind: 'number' },
  ]);
}

export function validateToolFailed(v: unknown): ContractResult {
  return validateEventFields('TOOL_FAILED', v, [
    { key: 'callId', kind: 'string' },
    { key: 'turnId', kind: 'string' },
    { key: 'error', kind: 'string' },
  ]);
}
