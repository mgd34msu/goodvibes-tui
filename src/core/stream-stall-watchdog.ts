/**
 * StreamStallWatchdog — detects gaps of silence (no STREAM_DELTA) longer than
 * a configurable threshold, whether the gap is at the start of a turn or in
 * the middle of an otherwise-flowing stream, and emits a low-priority hint
 * each time a gap crosses the threshold.
 *
 * Design:
 *   - Arm on STREAM_START: reset the episode counter, set a timeout for
 *     STALL_THRESHOLD_MS.
 *   - Re-arm on STREAM_DELTA: every byte received resets the no-delta clock,
 *     so a stall that begins mid-stream (after tokens were already flowing)
 *     is caught just as reliably as a stall at turn start. This is the fix
 *     for the "silence after the first delta never re-triggers" gap: the
 *     previous behaviour disarmed permanently on the first STREAM_DELTA,
 *     which meant a multi-minute stall after output had already started
 *     produced zero indication.
 *   - Disarm on STREAM_END / TURN_COMPLETED / TURN_ERROR / TURN_CANCEL:
 *     clear the timeout (turn finished normally or with error).
 *   - If the timeout fires: emit ONE hint for that episode (do not repeat
 *     while the same gap continues), then wait for the gap to close (another
 *     STREAM_DELTA/STREAM_START) before a further silence can fire again —
 *     each such re-arm-then-timeout cycle is a new "stall episode" and the
 *     episode counter passed to onStall increments each time.
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
   * Called once per stall episode when the no-delta threshold is exceeded.
   * Receives the provider display name and a 1-based episode counter that
   * increments each time a new silence (after a re-arm) crosses the
   * threshold within the same turn — so a second mid-stream stall after a
   * recovery is distinguishable from the first.
   */
  onStall: (providerName: string, episode: number) => void;
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
  let hintFiredForEpisode = false;
  let episodeCount = 0;

  function arm(): void {
    disarm();
    hintFiredForEpisode = false;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!hintFiredForEpisode) {
        hintFiredForEpisode = true;
        episodeCount++;
        const provider = getProviderName ? getProviderName() : 'provider';
        onStall(provider, episodeCount);
      }
    }, thresholdMs);
  }

  function disarm(): void {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function onStreamStart(): void {
    episodeCount = 0;
    arm();
  }

  const unsubs: Array<() => void> = [
    events.on('STREAM_START', onStreamStart),
    // Re-arm (not disarm) on every delta: the no-delta clock must reset on
    // each byte so a stall that starts mid-stream is still caught, not just
    // a stall before the first byte.
    events.on('STREAM_DELTA', arm),
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
