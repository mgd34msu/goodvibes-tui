/**
 * Telemetry instrumentation — barrel and factory.
 *
 * Provides `createInstrumentation()` which wires the DomainBridge to
 * a RuntimeEventBus and returns a handle for detaching and cascade recording.
 *
 * @example
 * ```ts
 * import { createInstrumentation } from './instrumentation/index.ts';
 *
 * const { detach, recordCascade } = createInstrumentation(tracer, bus);
 *
 * // When a cascade fires:
 * recordCascade(cascadeAppliedEvent, currentTraceId);
 *
 * // On shutdown:
 * detach();
 * ```
 */
import type { RuntimeTracer } from '../tracer.ts';
import type { RuntimeEventBus } from '../../events/index.ts';
import type { CascadeAppliedEvent } from '../../health/types.ts';
import { DomainBridge } from './domain-bridge.ts';

export { DomainBridge } from './domain-bridge.ts';

/** Handle returned by `createInstrumentation()`. */
export interface InstrumentationHandle {
  /**
   * Detach all event listeners from the bus.
   * Call during graceful shutdown to prevent listener leaks.
   */
  detach: () => void;

  /**
   * Record a health cascade event as a point-in-time span.
   *
   * @param event - The CASCADE_APPLIED event from the CascadeEngine.
   * @param traceId - Trace ID to correlate with the active operational context.
   */
  recordCascade: (event: CascadeAppliedEvent, traceId: string) => void;
}

/**
 * Create and attach domain instrumentation to a RuntimeEventBus.
 *
 * Subscribes to all domain channels (plugin, mcp, transport, task, agent,
 * permission, session, compaction) and creates OTel spans for each
 * lifecycle state machine transition.
 *
 * @param tracer - The RuntimeTracer to use for span creation.
 * @param bus - The RuntimeEventBus to subscribe to.
 * @returns An InstrumentationHandle for cleanup and cascade recording.
 */
export function createInstrumentation(
  tracer: RuntimeTracer,
  bus: RuntimeEventBus
): InstrumentationHandle {
  const bridge = new DomainBridge(tracer);
  const detach = bridge.attach(bus);

  return {
    detach,
    recordCascade: (event: CascadeAppliedEvent, traceId: string) =>
      bridge.recordCascade(event, traceId),
  };
}
