/**
 * UI performance domain state — tracks TUI render performance,
 * frame rates, and input responsiveness metrics.
 */

/** Render budget status. */
export type RenderBudgetStatus = 'ok' | 'warning' | 'critical';

/** A single render cycle record. */
export interface RenderCycleRecord {
  /** Sequential render cycle ID. */
  cycleId: number;
  /** Epoch ms when the render was requested. */
  requestedAt: number;
  /** Epoch ms when the render completed. */
  completedAt: number;
  /** Render duration in ms. */
  durationMs: number;
  /** Whether the render exceeded the budget. */
  overBudget: boolean;
}

/** Input latency sample. */
export interface InputLatencySample {
  /** Epoch ms when the key event was received. */
  keyEventAt: number;
  /** Epoch ms when the UI responded to the input. */
  respondedAt: number;
  /** Latency in ms. */
  latencyMs: number;
}

/**
 * UiPerfDomainState — TUI render and input performance metrics.
 */
export interface UiPerfDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Render metrics ─────────────────────────────────────────────────────────
  /** Total render cycles since session start. */
  totalRenderCycles: number;
  /** Moving average render duration in ms (last 20 cycles). */
  avgRenderMs: number;
  /** Maximum render duration observed. */
  maxRenderMs: number;
  /** Number of render cycles that exceeded budget. */
  overBudgetCount: number;
  /** Current render budget status. */
  budgetStatus: RenderBudgetStatus;
  /** Target render budget in ms (default: 16ms for ~60fps). */
  targetBudgetMs: number;
  /** Ring buffer of recent render cycles. */
  recentCycles: RenderCycleRecord[];
  /** Maximum number of render cycles to keep. */
  maxCycleBuffer: number;

  // ── Input latency ─────────────────────────────────────────────────────────
  /** Moving average input response latency in ms. */
  avgInputLatencyMs: number;
  /** Maximum observed input latency in ms. */
  maxInputLatencyMs: number;
  /** Ring buffer of recent input latency samples. */
  recentInputLatency: InputLatencySample[];

  // ── Memory ────────────────────────────────────────────────────────────────
  /** Bun process heap usage in bytes (polled). */
  heapUsedBytes: number;
  /** Bun process RSS in bytes. */
  rssBytes: number;
  /** Epoch ms of the last memory sample. */
  lastMemorySampleAt?: number;
}

/**
 * Returns the default initial state for the UI performance domain.
 */
export function createInitialUiPerfState(): UiPerfDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    totalRenderCycles: 0,
    avgRenderMs: 0,
    maxRenderMs: 0,
    overBudgetCount: 0,
    budgetStatus: 'ok',
    targetBudgetMs: 16,
    recentCycles: [],
    maxCycleBuffer: 60,
    avgInputLatencyMs: 0,
    maxInputLatencyMs: 0,
    recentInputLatency: [],
    heapUsedBytes: 0,
    rssBytes: 0,
    lastMemorySampleAt: undefined,
  };
}
