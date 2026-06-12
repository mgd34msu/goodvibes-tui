/**
 * StreamStallWatchdog — detects STREAM_START events where no STREAM_DELTA
 * arrives within a configurable threshold, and emits a single low-priority
 * hint to the user.
 *
 * Design:
 *   - Arm on STREAM_START: set a timeout for STALL_THRESHOLD_MS.
 *   - Disarm on STREAM_DELTA: clear the pending timeout (stream is alive).
 *   - Disarm on STREAM_END / TURN_COMPLETED / TURN_ERROR / TURN_CANCEL:
 *     clear the timeout (turn finished normally or with error).
 *   - If the timeout fires: emit ONE hint, do NOT repeat until the next turn.
 *   - Re-arm only on the next STREAM_START (next turn).
 *   - dispose(): clears all subscriptions and any pending timeout.
 *
 * @module
 */

/** Milliseconds of silence after STREAM_START before emitting the hint. */
export const STALL_THRESHOLD_MS = 30_000;

/** Events surface subset the watchdog needs. */
export interface WatchdogTurnEvents {
  on(event: 'STREAM_START', handler: () => void): () => void;
  on(event: 'STREAM_DELTA', handler: () => void): () => void;
  on(event: 'STREAM_END', handler: () => void): () => void;
  on(event: 'TURN_COMPLETED', handler: () => void): () => void;
  on(event: 'TURN_ERROR', handler: () => void): () => void;
  on(event: 'TURN_CANCEL', handler: () => void): () => void;
}

export interface StreamStallWatchdogOptions {
  /** The turns event surface to subscribe on. */
  events: WatchdogTurnEvents;
  /**
   * Called once per turn when the stall threshold is exceeded.
   * Receives the provider display name for the hint message.
   */
  onStall: (providerName: string) => void;
  /**
   * Provides the current provider display name at the moment the hint fires.
   * Optional — defaults to 'provider' when not supplied.
   */
  getProviderName?: () => string;
  /**
   * Stall threshold in ms. Defaults to STALL_THRESHOLD_MS (30 000).
   * Exposed for unit tests.
   */
  thresholdMs?: number;
}

export interface StreamStallWatchdog {
  /** Tear down all subscriptions and cancel any pending timeout. */
  dispose(): void;
}

/**
 * Creates and starts a StreamStallWatchdog.
 *
 * Returns a dispose function; add it to the `unsubs` array alongside other
 * event subscriptions so it is cleaned up on exit.
 */
export function createStreamStallWatchdog(opts: StreamStallWatchdogOptions): StreamStallWatchdog {
  const { events, onStall, getProviderName, thresholdMs = STALL_THRESHOLD_MS } = opts;

  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let hintFiredForTurn = false;

  function arm(): void {
    disarm();
    hintFiredForTurn = false;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!hintFiredForTurn) {
        hintFiredForTurn = true;
        const provider = getProviderName ? getProviderName() : 'provider';
        onStall(provider);
      }
    }, thresholdMs);
  }

  function disarm(): void {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  const unsubs: Array<() => void> = [
    events.on('STREAM_START', arm),
    events.on('STREAM_DELTA', disarm),
    events.on('STREAM_END', disarm),
    events.on('TURN_COMPLETED', disarm),
    events.on('TURN_ERROR', disarm),
    events.on('TURN_CANCEL', disarm),
  ];

  return {
    dispose(): void {
      disarm();
      for (const unsub of unsubs) unsub();
    },
  };
}
