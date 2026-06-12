import type { UiRuntimeEvents } from '@/runtime/index.ts';
import { createStreamStallWatchdog } from './stream-stall-watchdog.ts';
import { formatUserFacingErrorLine } from './format-user-error.ts';

/**
 * Live stream and tool-execution metrics maintained by wireStreamEventMetrics.
 * The object is mutated in place by event handlers; callers declare it before
 * render() and pass it in, so render() can read the fields without copying.
 */
export interface StreamMetrics {
  /** Epoch ms when the most recent STREAM_START fired; 0 when idle. */
  startTime: number;
  /** Number of STREAM_DELTA events received since the last STREAM_START. */
  deltaCount: number;
  /** Computed tokens-per-second at the last STREAM_DELTA; 0 when idle. */
  tokenSpeed: number;
  /** Elapsed ms from STREAM_START to first STREAM_DELTA (time-to-first-token). */
  ttftMs: number | undefined;
  /** Whether TTFT has been recorded for the current turn. */
  ttftRecorded: boolean;
  /** Epoch ms when the most recent TOOL_EXECUTING event fired; undefined when idle. */
  activeToolStartedAtMs: number | undefined;
  /** Name of the currently executing tool; cleared when execution completes. */
  activeToolName: string | undefined;
}

/** Minimal orchestrator surface required for stream token-speed calculation. */
interface StreamOrchestrator {
  readonly streamingOutputTokens: number;
}

/** Minimal provider surface required for the stream stall watchdog. */
interface StreamProviderRegistry {
  getCurrentModel(): { readonly provider: string };
}

/** Minimal system-message surface required for user-visible notifications. */
interface StreamSystemMessageRouter {
  high(message: string): void;
  low(message: string): void;
}

export interface WireStreamEventMetricsOptions {
  /** The UI runtime event bus (turns + tools sub-buses). */
  readonly events: UiRuntimeEvents;
  /** Orchestrator reference used to read real output token counts. */
  readonly orchestrator: StreamOrchestrator;
  /** Provider registry used by the stall watchdog to name the current provider. */
  readonly providerRegistry: StreamProviderRegistry;
  /** System message router for turn-error and stall notifications. */
  readonly systemMessageRouter: StreamSystemMessageRouter;
  /** Trigger a UI repaint after a state mutation. */
  readonly render: () => void;
  /**
   * Caller-owned metrics object to mutate in place.  Declared before render()
   * so the render closure can read it without a forward-reference issue.
   */
  readonly metrics: StreamMetrics;
}

/**
 * Wire STREAM_* and TOOL_* runtime events to the provided StreamMetrics object
 * and install the stream-stall watchdog.  The caller owns the metrics object
 * and declares it before render() so both the render closure and the returned
 * event handlers share the same reference.
 *
 * Returns an array of unsubscribe functions; push them into the parent unsubs
 * array so they are cleaned up on exit.
 *
 * Responsibilities:
 *   - Track stream start time, delta count, token speed, and TTFT
 *   - Track the currently executing tool name and start time
 *   - Display TURN_ERROR messages via systemMessageRouter
 *   - Emit a stall hint when STREAM_START has no delta within the watchdog threshold
 */
export function wireStreamEventMetrics(
  options: WireStreamEventMetricsOptions,
): ReadonlyArray<() => void> {
  const { events, metrics, orchestrator, providerRegistry, systemMessageRouter, render } = options;

  const unsubs: Array<() => void> = [];

  unsubs.push(events.turns.on('STREAM_START', () => {
    metrics.startTime = Date.now();
    metrics.deltaCount = 0;
    metrics.tokenSpeed = 0;
    metrics.ttftMs = undefined;
    metrics.ttftRecorded = false;
  }));

  unsubs.push(events.turns.on('STREAM_DELTA', () => {
    metrics.deltaCount++;
    const elapsed = (Date.now() - metrics.startTime) / 1000;
    // Record TTFT on the first delta of each turn.
    if (!metrics.ttftRecorded) {
      metrics.ttftMs = Date.now() - metrics.startTime;
      metrics.ttftRecorded = true;
    }
    // Use real output token count for accurate tok/s; fall back to delta count.
    const tokenCount = orchestrator.streamingOutputTokens > 0
      ? orchestrator.streamingOutputTokens
      : metrics.deltaCount;
    metrics.tokenSpeed = elapsed > 0 ? tokenCount / elapsed : 0;
  }));

  unsubs.push(events.turns.on('TURN_ERROR', (event) => {
    const errVal: string = event.error;
    const formatted = formatUserFacingErrorLine(errVal);
    systemMessageRouter.high(`[Error] ${formatted}`);
    render();
  }));

  // --- Stream stall watchdog: emit one low hint if STREAM_START has no delta within 30s ---
  const stallWatchdog = createStreamStallWatchdog({
    events: events.turns,
    onStall: (providerName) => {
      systemMessageRouter.low(`Still waiting on ${providerName}… Ctrl+C to cancel`);
      render();
    },
    getProviderName: () => providerRegistry.getCurrentModel().provider,
    // thresholdMs uses the default 30 000
  });
  unsubs.push(() => stallWatchdog.dispose());

  unsubs.push(events.tools.on('TOOL_EXECUTING', (ev) => {
    metrics.activeToolStartedAtMs = ev.startedAt;
    metrics.activeToolName = ev.tool;
    render();
  }));
  unsubs.push(events.tools.on('TOOL_SUCCEEDED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
  }));
  unsubs.push(events.tools.on('TOOL_FAILED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
  }));
  unsubs.push(events.tools.on('TOOL_CANCELLED', () => {
    metrics.activeToolStartedAtMs = undefined;
    metrics.activeToolName = undefined;
  }));

  return unsubs;
}
