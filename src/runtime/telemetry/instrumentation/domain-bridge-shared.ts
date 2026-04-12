import type { RuntimeEventBus, RuntimeEventEnvelope } from '../../events/index.ts';
import type { RuntimeTracer } from '../tracer.ts';
import type { Span } from '../types.ts';

export type Env<T extends { type: string }> = RuntimeEventEnvelope<T['type'], T>;
export type SpanMap = Map<string, Span>;

export interface DomainBridgeHelpers {
  readonly tracer: RuntimeTracer;
  readonly safe: (action: () => void) => void;
  readonly withSpan: (map: SpanMap, key: string, action: (span: Span) => void) => void;
  readonly closeSpan: (map: SpanMap, key: string, action: (span: Span) => void) => void;
}

export interface DomainBridgeAttachmentInput {
  readonly bus: RuntimeEventBus;
  readonly helpers: DomainBridgeHelpers;
}
