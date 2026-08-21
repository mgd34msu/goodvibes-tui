/**
 * retry-affordance.ts, the one-key retry/switch-model affordance shown
 * right after a user-visible TURN_ERROR: 'r' re-submits on the current
 * provider, 'm' opens the model picker, any other key disarms it silently.
 *
 * Rendered as a transient FOOTER status line (see retryAffordanceHint,
 * wired into ShellFooterBuildOptions.retryHint in shell-surface.ts) rather
 * than a permanent transcript message, it disappears the moment it's
 * disarmed, instead of sitting in the scrollback claiming an affordance
 * that no longer does anything. Extracted from main.ts to keep the
 * entrypoint under the architecture line cap.
 *
 * The affordance is also time-bounded: arming starts a disarm timer so a
 * stray 'r' hours later can never fire a real, paid retry against the
 * provider. The timer's window is exactly what the footer hint's visibility
 * implies, when it fires, the state disarms AND retryAffordanceHint(state)
 * goes back to null in the same tick, so the key dies at the same moment
 * the hint disappears.
 */

/** How long the affordance stays armed with no keypress before it silently expires. */
export const RETRY_AFFORDANCE_WINDOW_MS = 60_000;

/** Timer primitives injectable for tests, so arming doesn't require a real 60s wait. */
export interface RetryAffordanceSchedule {
  readonly setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const REAL_SCHEDULE: RetryAffordanceSchedule = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface RetryAffordanceState {
  armed: boolean;
  exhausted: boolean;
  /** Internal: the pending disarm timer's handle, or null while unarmed. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Internal: injected timer primitives, real setTimeout/clearTimeout in production. */
  readonly schedule: RetryAffordanceSchedule;
  /** Internal: the disarm window in ms. */
  readonly windowMs: number;
  /** Internal: invoked after the timer disarms the state, so the render loop can repaint the footer. */
  readonly onExpire?: () => void;
}

export interface CreateRetryAffordanceStateOptions {
  /** Overridable for tests; defaults to RETRY_AFFORDANCE_WINDOW_MS (60s). */
  readonly windowMs?: number;
  /** Overridable for tests so the disarm timer doesn't require a real 60s wait. */
  readonly schedule?: RetryAffordanceSchedule;
  /** Called once the window elapses with no keypress and the state has been disarmed, main.ts hooks this to its render loop so the footer hint clears the instant the key goes dead. */
  readonly onExpire?: () => void;
}

export function createRetryAffordanceState(options: CreateRetryAffordanceStateOptions = {}): RetryAffordanceState {
  return {
    armed: false,
    exhausted: false,
    timer: null,
    schedule: options.schedule ?? REAL_SCHEDULE,
    windowMs: options.windowMs ?? RETRY_AFFORDANCE_WINDOW_MS,
    onExpire: options.onExpire,
  };
}

function clearPendingTimer(state: RetryAffordanceState): void {
  if (state.timer !== null) {
    state.schedule.clearTimeout(state.timer);
    state.timer = null;
  }
}

/** Arm the affordance, call only when a retry is actually possible (a live retryCtx).
 *  Starts (or restarts, if already armed) the disarm timer. */
export function armRetryAffordance(state: RetryAffordanceState, exhausted: boolean): void {
  clearPendingTimer(state);
  state.armed = true;
  state.exhausted = exhausted;
  const timer = state.schedule.setTimeout(() => {
    state.timer = null;
    state.armed = false;
    state.onExpire?.();
  }, state.windowMs);
  // Never let this timer hold the process open, a background retry-window
  // countdown is not a reason to keep the event loop alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  state.timer = timer;
}

/** Disarm the affordance, any key other than the ones it recognizes disarms it,
 *  and cancels the pending disarm timer so it never fires on a state that's
 *  already been reset (or re-armed by a subsequent error). */
export function disarmRetryAffordance(state: RetryAffordanceState): void {
  clearPendingTimer(state);
  state.armed = false;
}

/** The transient footer hint text while armed; null once disarmed. */
export function retryAffordanceHint(state: RetryAffordanceState): string | null {
  if (!state.armed) return null;
  return state.exhausted
    ? '[Retry] r retry same provider · m switch model'
    : '[Retry] r retry · m switch model';
}

/** Arm the affordance whenever a user-visible error surfaces AND a retry is
 *  actually possible, wired here (not inline in main.ts) to keep the
 *  entrypoint under the architecture line cap. */
export function wireRetryAffordanceOnError(
  onErrorSurfaced: (cb: (exhausted: boolean) => void) => void,
  state: RetryAffordanceState,
  hasRetryCtx: () => boolean,
  render: () => void,
): void {
  onErrorSurfaced((exhausted) => {
    if (hasRetryCtx()) {
      armRetryAffordance(state, exhausted);
      render();
    }
  });
}
