/**
 * RuntimeEventEnvelope — the standard envelope wrapping all typed runtime events.
 *
 * Every event emitted through the RuntimeEventBus is wrapped in this envelope,
 * providing tracing, session, and source context alongside the typed payload.
 *
 * **Note on type duplication:** `envelope.type` and `envelope.payload.type` carry the
 * same string value intentionally. `envelope.type` is used for routing and indexing
 * (fast Map lookup in RuntimeEventBus), while `payload.type` enables discriminated
 * union narrowing inside listener callbacks without unwrapping the envelope first.
 */
export interface RuntimeEventEnvelope<TType extends string, TPayload> {
  /** Discriminant event type string (e.g. 'TURN_SUBMITTED'). Used for routing/indexing. */
  readonly type: TType;
  /** Unix timestamp in milliseconds when the event was created. */
  readonly ts: number;
  /** Distributed trace identifier for correlating events across boundaries. */
  readonly traceId: string;
  /** Session identifier for the current user session. */
  readonly sessionId: string;
  /** Optional turn identifier when the event is scoped to a conversation turn. */
  readonly turnId?: string;
  /** Optional agent identifier when the event is scoped to a spawned agent. */
  readonly agentId?: string;
  /** Optional task identifier when the event is scoped to a task. */
  readonly taskId?: string;
  /** Source module or component that emitted the event. */
  readonly source: string;
  /**
   * The typed domain payload for this event.
   * `payload.type` mirrors `envelope.type` to allow discriminated union narrowing
   * inside listener callbacks without unwrapping the envelope.
   */
  readonly payload: TPayload;
}

/** Context object passed to the envelope factory. */
export interface EnvelopeContext {
  readonly sessionId: string;
  readonly source: string;
  readonly traceId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
}

/**
 * Generates a globally unique trace identifier using the Web Crypto API.
 *
 * Format: standard RFC 4122 UUID v4 (e.g. `'110e8400-e29b-41d4-a716-446655440000'`).
 * Used as the default traceId when the caller does not supply one via EnvelopeContext.
 */
function generateTraceId(): string {
  return crypto.randomUUID();
}

/**
 * Creates a fully-formed RuntimeEventEnvelope for a given type and payload.
 *
 * @param type - The event type discriminant string.
 * @param payload - The typed domain payload.
 * @param context - Session, source, and optional trace/turn/agent/task context.
 * @returns A frozen RuntimeEventEnvelope ready for emission.
 */
export function createEventEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  context: EnvelopeContext
): RuntimeEventEnvelope<TType, TPayload> {
  return Object.freeze({
    type,
    ts: Date.now(),
    traceId: context.traceId ?? generateTraceId(),
    sessionId: context.sessionId,
    turnId: context.turnId,
    agentId: context.agentId,
    taskId: context.taskId,
    source: context.source,
    payload,
  });
}
