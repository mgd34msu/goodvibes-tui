export interface EventEnvelope<TType extends string, TPayload> {
  readonly type: TType;
  readonly ts: number;
  readonly traceId: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly source: string;
  readonly payload: TPayload;
}

export interface EventEnvelopeContext {
  readonly sessionId: string;
  readonly source: string;
  readonly traceId?: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
}

function generateTraceId(): string {
  return crypto.randomUUID();
}

export function createEventEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  context: EventEnvelopeContext,
): EventEnvelope<TType, TPayload> {
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
