/**
 * Emitters barrel — re-exports all typed emission wrappers and the EmitterContext.
 *
 * The EmitterContext is the minimal context required by all emitter functions.
 * Construct one from the current session/turn/agent context and pass it through.
 *
 * Usage:
 * ```ts
 * import { emitTurnSubmitted } from '../runtime/emitters/index.ts';
 * import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
 *
 * const bus = new RuntimeEventBus();
 * const ctx: EmitterContext = { sessionId: '...', traceId: '...', source: 'orchestrator' };
 * emitTurnSubmitted(bus, ctx, { turnId: '...', prompt: 'Hello' });
 * ```
 */
import type { EnvelopeContext } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';

/**
 * Emitter context passed to all emission wrapper functions.
 *
 * Extends EnvelopeContext by narrowing `traceId` from optional to required.
 * Emitter callsites always possess a trace context (e.g. from the active turn
 * or session), so requiring it here prevents accidental fallback to a generated
 * UUID that breaks cross-boundary trace correlation. Compare to EnvelopeContext
 * where `traceId` is optional to support low-level envelope construction without
 * a pre-existing trace.
 */
export interface EmitterContext extends EnvelopeContext {
  /** Required trace identifier — must be supplied by the caller at emission time. */
  readonly traceId: string;
}

export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/session';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/turn';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/providers';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/tools';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/tasks';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/agents';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/workflows';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/orchestration';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/communication';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/planner';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/permissions';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/plugins';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/mcp';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/transport';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/compaction';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/ui';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/ops';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/forensics';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/security';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/automation';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/routes';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/control-plane';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/deliveries';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/watchers';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/surfaces';
export * from '@pellux/goodvibes-sdk/platform/runtime/emitters/knowledge';
