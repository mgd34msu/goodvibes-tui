// ---------------------------------------------------------------------------
// memory-status.ts — the surface-facing projection of the daemon's memory
// governance (ops.memory.get + OPS_MEMORY_PRESSURE).
//
// The SDK's MemoryGovernor owns the policy: it samples RSS/heap against a
// budget, sheds memory by tier (trimming registered caches, pausing deferrable
// background jobs), refuses new expensive work at the critical tier, and trips
// on a genuine leak before the OS OOM-kills it. This module is the read-only
// projection the /health memory (doctor) surface renders from — the snapshot
// rows — and the attention line OPS_MEMORY_PRESSURE produces when the tier
// changes or the tripwire fires.
//
// Pure formatting only (no I/O): the command fetches the typed verb response
// over the operator invoke seam (memory-diagnostics-gateway.ts) and hands it
// here, so these builders are unit-testable against fixture shapes.
// ---------------------------------------------------------------------------

import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';
import type { OpsEvent } from '@/runtime/index.ts';

/** ops.memory.get output — the full governor snapshot. */
export type MemoryGovernorSnapshotResult = OperatorMethodOutput<'ops.memory.get'>;
/** The OPS_MEMORY_PRESSURE event payload (a tier change or a tripwire firing). */
export type MemoryPressurePayload = Extract<OpsEvent, { type: 'OPS_MEMORY_PRESSURE' }>;

/** Human MB (the governor already reports MB as numbers; round to 1 decimal). */
export function formatMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return 'unknown';
  return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** Human byte size for a cache footprint estimate. */
export function formatMemoryBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'size n/a';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** A plain-language note for the current tier (the governor's posture at this tier). */
export function memoryTierNote(tier: MemoryGovernorSnapshotResult['tier']): string {
  switch (tier) {
    case 'normal': return 'footprint is comfortably within budget';
    case 'elevated': return 'trimming caches to a floor and running gc';
    case 'high': return 'flushing caches and pausing deferrable background jobs';
    case 'critical': return 'refusing new expensive work until the footprint recovers';
    default: return '';
  }
}

/**
 * The /health memory (doctor) rows — the honest account of the daemon defending
 * its footprint. Order: tier + posture, budget vs RSS, heap, tier thresholds,
 * per-cache footprints the governor can shrink, which deferrable jobs are
 * paused, and the leak-tripwire state.
 */
export function memoryStatusLines(snapshot: MemoryGovernorSnapshotResult): string[] {
  const lines: string[] = [];
  lines.push(`  tier: ${snapshot.tier} — ${memoryTierNote(snapshot.tier)}`);
  if (snapshot.refusingExpensiveWork) {
    lines.push('  expensive work: REFUSED (critical tier) — new ingestion / reindex / voice install is declined until RSS recovers');
  }
  lines.push(`  budget: ${formatMb(snapshot.rssMb)} rss / ${formatMb(snapshot.budgetMb)} budget (${Math.round(snapshot.usedPct)}%)`);
  const heap = snapshot.heapTotalMb !== undefined
    ? `${formatMb(snapshot.heapUsedMb)} used / ${formatMb(snapshot.heapTotalMb)} total`
    : formatMb(snapshot.heapUsedMb);
  lines.push(`  heap: ${heap}`);
  lines.push(`  tiers: elevated ${snapshot.thresholds.elevatedPct}% · high ${snapshot.thresholds.highPct}% · critical ${snapshot.thresholds.criticalPct}%`);

  if (snapshot.caches.length === 0) {
    lines.push('  caches: none registered');
  } else {
    lines.push(`  caches: ${snapshot.caches.length}`);
    for (const cache of snapshot.caches) {
      const size = cache.estimatedBytes !== undefined ? `, ~${formatMemoryBytes(cache.estimatedBytes)}` : '';
      lines.push(`    ${cache.id} (${cache.name}): ${cache.entries} entries${size}`);
    }
  }

  lines.push(snapshot.pausedJobs.length === 0
    ? '  paused jobs: none'
    : `  paused jobs: ${snapshot.pausedJobs.join(', ')}`);

  if (snapshot.tripwire.armed) {
    lines.push(`  tripwire: ARMED — watching for a sustained >${snapshot.tripwire.rateMbPerSec} MB/s post-flush leak (held ${Math.round(snapshot.tripwire.sustainedSec)}s)`);
  } else {
    lines.push('  tripwire: disarmed (no post-flush leak growth under watch)');
  }
  return lines;
}

/**
 * The attention line OPS_MEMORY_PRESSURE produces: a one-liner naming the new
 * tier and the RSS/budget, plus a distinct escalation when the leak tripwire
 * fires (the daemon is about to exit for a clean supervisor restart). Returned
 * as a single string so the notice/attention surface can push it directly.
 */
export function memoryPressureLine(event: MemoryPressurePayload): string {
  const base = `memory pressure: ${event.previousTier} → ${event.tier} (${formatMb(event.rssMb)} rss / ${formatMb(event.budgetMb)} budget, ${Math.round(event.usedPct)}%)`;
  if (event.tripwire) {
    return `${base} — leak tripwire fired (${event.tripwire.rateMbPerSec} MB/s sustained ${Math.round(event.tripwire.sustainedSec)}s); the daemon will exit for a clean restart`;
  }
  if (event.note) return `${base} — ${event.note}`;
  return base;
}

/** Severity for the notice feed: critical tier (or a tripwire) is critical; high is a warning. */
export function memoryPressureLevel(event: MemoryPressurePayload): 'info' | 'warning' | 'critical' {
  if (event.tripwire || event.tier === 'critical') return 'critical';
  if (event.tier === 'high') return 'warning';
  return 'info';
}
