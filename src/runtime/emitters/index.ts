/**
 * Emitters barrel — re-exports all typed emission wrappers and the EmitterContext.
 *
 * The EmitterContext is the minimal context required by all emitter functions.
 * Construct one from the current session/turn/agent context and pass it through.
 *
 * Usage:
 * ```ts
 * import { emitTurnSubmitted } from '../runtime/emitters/index.ts';
 * import { RuntimeEventBus } from '../runtime/events/index.ts';
 *
 * const bus = new RuntimeEventBus();
 * const ctx: EmitterContext = { sessionId: '...', traceId: '...', source: 'orchestrator' };
 * emitTurnSubmitted(bus, ctx, { turnId: '...', prompt: 'Hello' });
 * ```
 */
import type { EnvelopeContext } from '../events/envelope.ts';

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

export * from './session.ts';
export * from './turn.ts';
export * from './providers.ts';
export * from './tools.ts';
export * from './tasks.ts';
export * from './agents.ts';
export * from './workflows.ts';
export * from './orchestration.ts';
export * from './communication.ts';
export * from './planner.ts';
export * from './permissions.ts';
export * from './plugins.ts';
export * from './mcp.ts';
export * from './transport.ts';
export * from './compaction.ts';
export * from './ops.ts';
export * from './forensics.ts';
