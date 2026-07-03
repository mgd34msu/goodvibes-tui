/**
 * render-scheduler.ts — same-tick render coalescing for the TUI shell (WO-208).
 *
 * main.ts fans out its own direct render() calls across turn/stream/input wiring
 * (~14 direct invocation contexts). Each one previously ran a full synchronous
 * Compositor.composite() the instant it was called. When several fire within a
 * single event-loop tick — a streaming burst is the canonical case — only the
 * LAST frame is ever visible; the earlier composites are immediately overwritten.
 * This scheduler collapses every schedule() call made within one tick into a
 * single composite flushed on the microtask queue, so the tick produces exactly
 * one frame. That frame is byte-identical to what the last synchronous render()
 * would have produced, because the coalesced flush runs after all of the tick's
 * synchronous state mutations, reading the same final state the last direct
 * render() would have read.
 *
 * This is deliberately SEPARATE from bootstrap-core's requestRender(), which is a
 * cross-tick, 16ms-throttled (~60fps) coalescer for the panel/input/runtime
 * fan-out — that one caps repaint RATE across ticks. This one collapses the
 * WITHIN-tick burst with no added latency: a microtask flushes at the tail of the
 * current tick, before the event loop yields to I/O, so the frame still lands in
 * the same turn it was requested in.
 *
 * flushNow() preserves a synchronous immediate path for callers that genuinely
 * need the frame composited before they return. Terminal resize is the known
 * case: the resize handler resets the compositor diff and must repaint against
 * the new dimensions synchronously rather than waiting for the microtask.
 * flushNow() also clears any pending coalesced flush, so a resize (or any
 * immediate paint) followed by an already-queued microtask never double-composites.
 */

export interface RenderScheduler {
  /**
   * Coalesced request: schedule a composite for the current tick. N calls within
   * one tick collapse into exactly one composite, flushed on the microtask queue.
   */
  readonly schedule: () => void;
  /**
   * Immediate request: run the composite synchronously right now, and cancel any
   * pending coalesced flush so the tick still composites only once. Use only where
   * a caller genuinely requires synchronous output (terminal resize).
   */
  readonly flushNow: () => void;
}

/**
 * Build a render scheduler around `renderNow` (the synchronous composite closure).
 *
 * `scheduleFlush` is the deferral primitive; it defaults to `queueMicrotask` so
 * bursts coalesce within the current tick. Tests and benchmarks inject a manual
 * queue to flush deterministically.
 */
export function createRenderScheduler(
  renderNow: () => void,
  scheduleFlush: (flush: () => void) => void = queueMicrotask,
): RenderScheduler {
  let scheduled = false;

  const flush = (): void => {
    // A synchronous flushNow() (or a superseding immediate paint) before this
    // microtask ran clears `scheduled`, turning this into a no-op so a single
    // tick never composites twice.
    if (!scheduled) return;
    scheduled = false;
    renderNow();
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    scheduleFlush(flush);
  };

  const flushNow = (): void => {
    // Satisfy any pending coalesced flush, then composite synchronously.
    scheduled = false;
    renderNow();
  };

  return { schedule, flushNow };
}
