/**
 * Permission emitters — typed emission wrappers for PermissionEvent domain.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';

/** Emit PERMISSION_REQUESTED when a tool needs a permission decision. */
export function emitPermissionRequested(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    callId: string;
    tool: string;
    args: Record<string, unknown>;
    category: string;
    classification?: string;
    riskLevel?: string;
    summary?: string;
    reasons?: readonly string[];
  }
): void {
  bus.emit('permissions', createEventEnvelope('PERMISSION_REQUESTED', { type: 'PERMISSION_REQUESTED', ...data }, ctx));
}

/** Emit RULES_COLLECTED after all permission rules are gathered. */
export function emitRulesCollected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; tool: string; ruleCount: number }
): void {
  bus.emit('permissions', createEventEnvelope('RULES_COLLECTED', { type: 'RULES_COLLECTED', ...data }, ctx));
}

/** Emit INPUT_NORMALIZED after tool args are normalised for policy evaluation. */
export function emitInputNormalized(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; tool: string }
): void {
  bus.emit('permissions', createEventEnvelope('INPUT_NORMALIZED', { type: 'INPUT_NORMALIZED', ...data }, ctx));
}

/** Emit POLICY_EVALUATED after static policy rules are checked. */
export function emitPolicyEvaluated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; tool: string; result: 'allow' | 'deny' | 'unknown' }
): void {
  bus.emit('permissions', createEventEnvelope('POLICY_EVALUATED', { type: 'POLICY_EVALUATED', ...data }, ctx));
}

/** Emit MODE_EVALUATED after trust mode is checked. */
export function emitModeEvaluated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; tool: string; mode: string; result: 'allow' | 'deny' | 'unknown' }
): void {
  bus.emit('permissions', createEventEnvelope('MODE_EVALUATED', { type: 'MODE_EVALUATED', ...data }, ctx));
}

/** Emit SESSION_OVERRIDE_EVALUATED after session always-allow list is checked. */
export function emitSessionOverrideEvaluated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; tool: string; overrideApplied: boolean }
): void {
  bus.emit('permissions', createEventEnvelope('SESSION_OVERRIDE_EVALUATED', { type: 'SESSION_OVERRIDE_EVALUATED', ...data }, ctx));
}

/** Emit SAFETY_CHECKED after safety validation (path traversal, etc.) runs. */
export function emitSafetyChecked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { callId: string; tool: string; safe: boolean; warnings: string[] }
): void {
  bus.emit('permissions', createEventEnvelope('SAFETY_CHECKED', { type: 'SAFETY_CHECKED', ...data }, ctx));
}

/** Emit DECISION_EMITTED when the final permission decision is made. */
export function emitPermissionDecision(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: {
    callId: string;
    tool: string;
    approved: boolean;
    source: string;
    sourceLayer?: string;
    persisted?: boolean;
    reasonCode?: string;
    classification?: string;
    riskLevel?: string;
    summary?: string;
  }
): void {
  bus.emit('permissions', createEventEnvelope('DECISION_EMITTED', { type: 'DECISION_EMITTED', ...data }, ctx));
}
