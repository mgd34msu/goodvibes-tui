/**
 * SloCollector — collects SLO duration measurements from runtime events.
 *
 * Listens to the RuntimeEventBus and tracks four critical path latencies:
 * - turn_start_ms: TURN_SUBMITTED → first STREAM_DELTA
 * - cancel_ms: TURN_CANCEL → TURN_COMPLETED or TURN_ERROR
 * - reconnect_recovery_ms: TRANSPORT_RECONNECTING → TRANSPORT_CONNECTED
 * - permission_decision_ms: PERMISSION_REQUESTED → DECISION_EMITTED
 *
 * Maintains a capped rolling window of measurements per SLO and exposes
 * p95 values for PerfMonitor integration via `getMetrics()`.
 */

import type { RuntimeEventBus, RuntimeEventEnvelope, AnyRuntimeEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { PerfMetric } from '@pellux/goodvibes-sdk/platform/runtime/perf/types';

/** Metric key constants for each SLO measurement. */
export const SLO_METRICS = {
  TURN_START: 'slo.turn_start.p95',
  CANCEL: 'slo.cancel.p95',
  RECONNECT_RECOVERY: 'slo.reconnect_recovery.p95',
  PERMISSION_DECISION: 'slo.permission_decision.p95',
} as const;

/** Maximum number of samples retained in each rolling window. */
const WINDOW_SIZE = 200;

/**
 * Maximum age for a pending map entry before it is swept as stale.
 * Entries that never receive a follow-up event (e.g. TURN_CANCEL without
 * TURN_COMPLETED due to a connection drop) are evicted after this duration
 * to prevent unbounded memory growth.
 */
const PENDING_TTL_MS = 60_000;

/** Interval between periodic stale-entry sweeps (ms). */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Computes the 95th percentile from a numeric array.
 * Returns 0 for empty arrays.
 */
function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * Appends a sample to a capped rolling window.
 * Evicts the oldest entry when the window exceeds WINDOW_SIZE.
 */
function appendSample(window: number[], sample: number): void {
  window.push(sample);
  if (window.length > WINDOW_SIZE) {
    window.shift();
  }
}

/** Minimal shape for an untyped envelope used for payload extraction. */
type RawEnvelope = RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>;

/**
 * Coerce a strongly-typed bus callback argument to the raw envelope shape.
 *
 * The RuntimeEventBus `on()` callback receives a per-event typed envelope,
 * but SloCollector reads only generic fields (`.ts`, `.payload.*`). The
 * double-cast is intentional: we lose specificity to gain a uniform access
 * pattern, isolated to this single conversion site.
 */
function toRaw(env: unknown): RawEnvelope {
  return env as unknown as RawEnvelope;
}

/**
 * Safely extract a named field from an envelope payload.
 * Returns `undefined` when the field does not exist on the payload.
 */
function getField<T>(envelope: RawEnvelope, key: string): T | undefined {
  const payload = envelope.payload as Record<string, unknown>;
  return payload[key] as T | undefined;
}

/**
 * SloCollector subscribes to RuntimeEventBus events and tracks per-SLO
 * duration samples in rolling windows. Call `getMetrics()` to retrieve
 * current p95 values compatible with PerfMonitor's extraMetrics field.
 *
 * @example
 * ```ts
 * const collector = new SloCollector(bus);
 * const metrics = collector.getMetrics();
 * const report = monitor.evaluate({ uiPerf, extraMetrics: Object.fromEntries(
 *   metrics.map(m => [m.name, m.value])
 * )});
 * collector.dispose();
 * ```
 */
export class SloCollector {
  /** Rolling window of turn_start_ms samples (TURN_SUBMITTED → first STREAM_DELTA). */
  private readonly _turnStartSamples: number[] = [];
  /** Rolling window of cancel_ms samples (TURN_CANCEL → TURN_COMPLETED/ERROR). */
  private readonly _cancelSamples: number[] = [];
  /** Rolling window of reconnect_recovery_ms samples (TRANSPORT_RECONNECTING → TRANSPORT_CONNECTED). */
  private readonly _reconnectSamples: number[] = [];
  /** Rolling window of permission_decision_ms samples (PERMISSION_REQUESTED → DECISION_EMITTED). */
  private readonly _permissionSamples: number[] = [];

  /** Pending turn start timestamps keyed by turnId. */
  private readonly _pendingTurnStart = new Map<string, number>();
  /** Tracks which turnIds have received their first STREAM_DELTA. */
  private readonly _seenFirstDelta = new Set<string>();
  /** Pending cancel timestamps keyed by turnId (set on TURN_CANCEL). */
  private readonly _pendingCancel = new Map<string, number>();
  /** Pending reconnect start timestamp. Only the most recent reconnect attempt is tracked. */
  private _pendingReconnectAt: number | null = null;
  /** Pending permission request timestamps keyed by callId. */
  private readonly _pendingPermission = new Map<string, number>();

  /** Registered unsubscribe functions. */
  private readonly _unsubs: Array<() => void> = [];

  /** Timer handle for the periodic stale-entry sweep. */
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(bus: RuntimeEventBus) {
    this._subscribe(bus);
    this._sweepTimer = setInterval(() => this._sweepPending(), SWEEP_INTERVAL_MS);
  }

  /**
   * Attach all event listeners to the bus.
   */
  private _subscribe(bus: RuntimeEventBus): void {
    // ── turn_start_ms ───────────────────────────────────────────────────────
    this._unsubs.push(
      bus.on('TURN_SUBMITTED', (env) => {
        const e = toRaw(env);
        const turnId = getField<string>(e, 'turnId');
        if (turnId !== undefined) {
          this._pendingTurnStart.set(turnId, e.ts);
          this._seenFirstDelta.delete(turnId);
        }
      })
    );

    this._unsubs.push(
      bus.on('STREAM_DELTA', (env) => {
        const e = toRaw(env);
        const turnId = getField<string>(e, 'turnId');
        if (turnId === undefined) return;
        if (this._seenFirstDelta.has(turnId)) return;
        this._seenFirstDelta.add(turnId);
        const startAt = this._pendingTurnStart.get(turnId);
        if (startAt !== undefined) {
          appendSample(this._turnStartSamples, e.ts - startAt);
          this._pendingTurnStart.delete(turnId);
        }
      })
    );

    // Clean up stale pending turn starts when a turn ends without streaming
    this._unsubs.push(
      bus.on('PREFLIGHT_FAIL', (env) => {
        const e = toRaw(env);
        const turnId = getField<string>(e, 'turnId');
        if (turnId !== undefined) {
          this._pendingTurnStart.delete(turnId);
          this._seenFirstDelta.delete(turnId);
          this._pendingCancel.delete(turnId);
        }
      })
    );

    this._unsubs.push(
      bus.on('TURN_ERROR', (env) => {
        const e = toRaw(env);
        const turnId = getField<string>(e, 'turnId');
        if (turnId !== undefined) {
          this._pendingTurnStart.delete(turnId);
          this._seenFirstDelta.delete(turnId);
          // Resolve cancel if pending
          const cancelAt = this._pendingCancel.get(turnId);
          if (cancelAt !== undefined) {
            appendSample(this._cancelSamples, e.ts - cancelAt);
            this._pendingCancel.delete(turnId);
          }
        }
      })
    );

    this._unsubs.push(
      bus.on('TURN_COMPLETED', (env) => {
        const e = toRaw(env);
        const turnId = getField<string>(e, 'turnId');
        if (turnId !== undefined) {
          this._pendingTurnStart.delete(turnId);
          this._seenFirstDelta.delete(turnId);
          // Resolve cancel if pending
          const cancelAt = this._pendingCancel.get(turnId);
          if (cancelAt !== undefined) {
            appendSample(this._cancelSamples, e.ts - cancelAt);
            this._pendingCancel.delete(turnId);
          }
        }
      })
    );

    // ── cancel_ms ───────────────────────────────────────────────────────────
    this._unsubs.push(
      bus.on('TURN_CANCEL', (env) => {
        const e = toRaw(env);
        const turnId = getField<string>(e, 'turnId');
        if (turnId !== undefined) {
          this._pendingCancel.set(turnId, e.ts);
        }
      })
    );

    // ── reconnect_recovery_ms ───────────────────────────────────────────────
    this._unsubs.push(
      bus.on('TRANSPORT_RECONNECTING', (env) => {
        const e = toRaw(env);
        const attempt = getField<number>(e, 'attempt');
        // Track start of reconnect sequence; use first attempt timestamp
        if (attempt === 1 || this._pendingReconnectAt === null) {
          this._pendingReconnectAt = e.ts;
        }
      })
    );

    this._unsubs.push(
      bus.on('TRANSPORT_CONNECTED', (env) => {
        const e = toRaw(env);
        if (this._pendingReconnectAt !== null) {
          appendSample(this._reconnectSamples, e.ts - this._pendingReconnectAt);
          this._pendingReconnectAt = null;
        }
      })
    );

    // Clear pending reconnect on terminal failure
    this._unsubs.push(
      bus.on('TRANSPORT_TERMINAL_FAILURE', () => {
        this._pendingReconnectAt = null;
      })
    );

    // ── permission_decision_ms ──────────────────────────────────────────────
    this._unsubs.push(
      bus.on('PERMISSION_REQUESTED', (env) => {
        const e = toRaw(env);
        const callId = getField<string>(e, 'callId');
        if (callId !== undefined) {
          this._pendingPermission.set(callId, e.ts);
        }
      })
    );

    this._unsubs.push(
      bus.on('DECISION_EMITTED', (env) => {
        const e = toRaw(env);
        const callId = getField<string>(e, 'callId');
        if (callId !== undefined) {
          const startAt = this._pendingPermission.get(callId);
          if (startAt !== undefined) {
            appendSample(this._permissionSamples, e.ts - startAt);
            this._pendingPermission.delete(callId);
          }
        }
      })
    );
  }

  /**
   * Sweep all pending maps and evict entries older than PENDING_TTL_MS.
   *
   * Called periodically by the sweep timer to prevent unbounded memory growth
   * when expected follow-up events (e.g. TURN_COMPLETED after TURN_CANCEL)
   * never arrive due to connection drops or unexpected process termination.
   */
  private _sweepPending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, ts] of this._pendingTurnStart) {
      if (ts < cutoff) {
        this._pendingTurnStart.delete(key);
        this._seenFirstDelta.delete(key);
      }
    }
    for (const [key, ts] of this._pendingCancel) {
      if (ts < cutoff) this._pendingCancel.delete(key);
    }
    for (const [key, ts] of this._pendingPermission) {
      if (ts < cutoff) this._pendingPermission.delete(key);
    }
    // _pendingReconnectAt is a scalar; clear if stale
    if (this._pendingReconnectAt !== null && this._pendingReconnectAt < cutoff) {
      this._pendingReconnectAt = null;
    }
  }

  /**
   * Returns current p95 values for all four SLO metrics as PerfMetric entries.
   * Metrics with no samples return a value of 0.
   *
   * Intended for use with `PerfMonitor.evaluate()` via the `extraMetrics` field:
   * ```ts
   * const extras = Object.fromEntries(collector.getMetrics().map(m => [m.name, m.value]));
   * monitor.evaluate({ uiPerf, extraMetrics: extras });
   * ```
   */
  public getMetrics(): PerfMetric[] {
    const now = Date.now();
    return [
      {
        name: SLO_METRICS.TURN_START,
        value: p95(this._turnStartSamples),
        unit: 'ms',
        timestamp: now,
      },
      {
        name: SLO_METRICS.CANCEL,
        value: p95(this._cancelSamples),
        unit: 'ms',
        timestamp: now,
      },
      {
        name: SLO_METRICS.RECONNECT_RECOVERY,
        value: p95(this._reconnectSamples),
        unit: 'ms',
        timestamp: now,
      },
      {
        name: SLO_METRICS.PERMISSION_DECISION,
        value: p95(this._permissionSamples),
        unit: 'ms',
        timestamp: now,
      },
    ];
  }

  /**
   * Returns the number of samples collected for each SLO metric.
   * Useful for diagnostics to distinguish "no data yet" from an actual 0ms result.
   */
  public getSampleCounts(): Readonly<Record<string, number>> {
    return {
      [SLO_METRICS.TURN_START]: this._turnStartSamples.length,
      [SLO_METRICS.CANCEL]: this._cancelSamples.length,
      [SLO_METRICS.RECONNECT_RECOVERY]: this._reconnectSamples.length,
      [SLO_METRICS.PERMISSION_DECISION]: this._permissionSamples.length,
    };
  }

  /**
   * Unsubscribes all event listeners and releases resources.
   * The collector should not be used after disposal.
   */
  public dispose(): void {
    if (this._sweepTimer !== null) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    for (const unsub of this._unsubs) {
      unsub();
    }
    this._unsubs.length = 0;
    this._pendingTurnStart.clear();
    this._seenFirstDelta.clear();
    this._pendingCancel.clear();
    this._pendingPermission.clear();
    this._pendingReconnectAt = null;
  }
}
