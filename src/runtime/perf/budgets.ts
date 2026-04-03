/**
 * Default performance budget definitions for goodvibes-tui.
 *
 * Based on v3 Section 21.4 — measurable budgets for frame latency,
 * event throughput, tool executor overhead, memory growth, and
 * compaction latency.
 */

import type { PerfBudget } from './types.ts';

/**
 * The default set of performance budgets applied in CI.
 *
 * These represent acceptable operational thresholds. Any metric that
 * consistently exceeds its budget beyond the tolerance window will
 * cause CI to fail.
 */
export const DEFAULT_BUDGETS: PerfBudget[] = [
  {
    name: 'Frame Render Latency (p95)',
    metric: 'frame.render.p95',
    threshold: 16,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 frame render duration must stay under 16ms to maintain 60fps. ' +
      'Sustained violations indicate rendering bottlenecks under operational load.',
  },
  {
    name: 'Event Queue Depth',
    metric: 'event.queue.depth',
    threshold: 1000,
    unit: 'count',
    tolerance: 5,
    description:
      'Event queue must not accumulate more than 1000 pending events. ' +
      'Deep queues indicate the event loop cannot drain fast enough.',
  },
  {
    name: 'Tool Executor Overhead (p95)',
    metric: 'tool.executor.overhead.p95',
    threshold: 5,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 overhead per tool executor phase (scheduling, dispatch, teardown) ' +
      'must be under 5ms. Sustained violations indicate executor inefficiency.',
  },
  {
    name: 'Memory Growth Rate',
    metric: 'memory.growth.bytes_per_hour',
    threshold: 52_428_800, // 50 MiB in bytes
    unit: 'bytes',
    tolerance: 2,
    description:
      'Sustained heap growth must remain below 50 MiB/hour. ' +
      'Faster growth indicates a memory leak in long-running sessions.',
  },
  {
    name: 'Compaction Latency (p95)',
    metric: 'compaction.latency.p95',
    threshold: 500,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 compaction duration must be under 500ms. ' +
      'Slower compaction blocks the conversation loop and degrades UX.',
  },
  // ── SLO Gates ──────────────────────────────────────────────────────────────
  {
    name: 'SLO: Turn Start Latency (p95)',
    metric: 'slo.turn_start.p95',
    threshold: 2000,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 duration from TURN_SUBMITTED to first STREAM_DELTA must be under 2000ms. ' +
      'Sustained violations indicate provider latency or pipeline overhead regression.',
  },
  {
    name: 'SLO: Cancel Latency (p95)',
    metric: 'slo.cancel.p95',
    threshold: 500,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 duration from TURN_CANCEL to confirmed turn stop must be under 500ms. ' +
      'Sustained violations indicate the cancellation path is blocked or too slow.',
  },
  {
    name: 'SLO: Reconnect Recovery (p95)',
    metric: 'slo.reconnect_recovery.p95',
    threshold: 10000,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 duration from TRANSPORT_RECONNECTING to TRANSPORT_CONNECTED must be under 10000ms. ' +
      'Sustained violations indicate degraded transport reliability.',
  },
  {
    name: 'SLO: Permission Decision (p95)',
    metric: 'slo.permission_decision.p95',
    threshold: 100,
    unit: 'ms',
    tolerance: 3,
    description:
      'p95 duration from PERMISSION_REQUESTED to DECISION_EMITTED must be under 100ms. ' +
      'Sustained violations indicate permission pipeline overhead regression.',
  },
  // ── Integration Delivery SLO ─────────────────────────────────────────────
  {
    name: 'SLO: Integration Delivery Success Rate',
    metric: 'slo.integration.delivery_success_rate',
    threshold: 95,
    unit: 'percent',
    tolerance: 3,
    description:
      'Integration delivery success rate must remain above 95% over any 100-delivery window. '
      + 'Sustained violations indicate systemic integration delivery failures requiring investigation.',
  },
  {
    name: 'SLO: Integration DLQ Depth',
    metric: 'slo.integration.dlq_depth',
    threshold: 10,
    unit: 'count',
    tolerance: 3,
    description:
      'Integration dead-letter queue depth must remain below 10 entries. '
      + 'A deeper queue indicates persistent delivery failures that require manual replay or investigation.',
  },
];
