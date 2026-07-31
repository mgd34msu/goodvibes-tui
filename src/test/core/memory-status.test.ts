import { describe, expect, test } from 'bun:test';
import {
  formatMb,
  formatMemoryBytes,
  memoryTierNote,
  memoryStatusLines,
  memoryPressureLine,
  memoryPressureLevel,
  type MemoryGovernorSnapshotResult,
  type MemoryPressurePayload,
} from '@pellux/goodvibes-sdk/platform/runtime/memory';

function snapshot(overrides: Partial<MemoryGovernorSnapshotResult> = {}): MemoryGovernorSnapshotResult {
  return {
    tier: 'normal',
    budgetMb: 4096,
    rssMb: 512.4,
    heapUsedMb: 210.2,
    heapTotalMb: 300,
    usedPct: 12.5,
    refusingExpensiveWork: false,
    caches: [
      { id: 'knowledge-store', name: 'knowledge stores (regular + agent + home-graph)', entries: 1240, estimatedBytes: 5_242_880 },
      { id: 'session-union', name: 'shared session broker (sessions + message/input buckets)', entries: 88 },
    ],
    pausedJobs: [],
    tripwire: { armed: false, sustainedSec: 0, rateMbPerSec: 25 },
    thresholds: { elevatedPct: 60, highPct: 80, criticalPct: 95 },
    ...overrides,
  } as MemoryGovernorSnapshotResult;
}

function pressure(overrides: Partial<MemoryPressurePayload> = {}): MemoryPressurePayload {
  return {
    type: 'OPS_MEMORY_PRESSURE',
    tier: 'high',
    previousTier: 'elevated',
    rssMb: 3600,
    heapMb: 900,
    budgetMb: 4096,
    usedPct: 87.9,
    ...overrides,
  } as MemoryPressurePayload;
}

describe('formatMb / formatMemoryBytes', () => {
  test('MB rounds sensibly and is honest on missing values', () => {
    expect(formatMb(512.44)).toBe('512 MB');
    expect(formatMb(12.34)).toBe('12.3 MB');
    expect(formatMb(undefined)).toBe('unknown');
  });
  test('bytes humanize across units', () => {
    expect(formatMemoryBytes(5_242_880)).toBe('5.0 MB');
    expect(formatMemoryBytes(512)).toBe('512 B');
    expect(formatMemoryBytes(undefined)).toBe('size n/a');
  });
});

describe('memoryStatusLines — populated (normal tier)', () => {
  test('renders tier, budget/rss, heap, thresholds, cache footprints, no paused jobs, disarmed tripwire', () => {
    const text = memoryStatusLines(snapshot()).join('\n');
    expect(text).toContain('tier: normal — footprint is comfortably within budget');
    expect(text).toContain('budget: 512 MB rss / 4096 MB budget (13%)');
    expect(text).toContain('heap: 210 MB used / 300 MB total');
    expect(text).toContain('tiers: elevated 60% · high 80% · critical 95%');
    expect(text).toContain('caches: 2');
    expect(text).toContain('knowledge-store (knowledge stores (regular + agent + home-graph)): 1240 entries, ~5.0 MB');
    expect(text).toContain('session-union'); // no estimatedBytes -> no size suffix
    expect(text).toContain('paused jobs: none');
    expect(text).toContain('tripwire: disarmed');
    expect(text).not.toContain('REFUSED');
  });
});

describe('memoryStatusLines — high/critical tiers', () => {
  test('critical tier renders the refusal and paused jobs', () => {
    const text = memoryStatusLines(snapshot({
      tier: 'critical',
      refusingExpensiveWork: true,
      pausedJobs: ['knowledge-self-improvement', 'code-index-reindex'],
      tripwire: { armed: true, sustainedSec: 12, rateMbPerSec: 25 },
    })).join('\n');
    expect(text).toContain('tier: critical — refusing new expensive work');
    expect(text).toContain('expensive work: REFUSED (critical tier)');
    expect(text).toContain('paused jobs: knowledge-self-improvement, code-index-reindex');
    expect(text).toContain('tripwire: ARMED');
    expect(text).toContain('held 12s');
  });
});

describe('memoryStatusLines — empty caches', () => {
  test('honest "none registered" rather than a fabricated zero row', () => {
    const text = memoryStatusLines(snapshot({ caches: [] })).join('\n');
    expect(text).toContain('caches: none registered');
  });
});

describe('memoryTierNote', () => {
  test('each tier has a plain-language posture', () => {
    expect(memoryTierNote('elevated')).toContain('trimming caches');
    expect(memoryTierNote('high')).toContain('pausing deferrable background jobs');
  });
});

describe('memoryPressureLine / memoryPressureLevel', () => {
  test('a tier change renders the transition and footprint', () => {
    expect(memoryPressureLine(pressure())).toBe('memory pressure: elevated → high (3600 MB rss / 4096 MB budget, 88%)');
    expect(memoryPressureLevel(pressure())).toBe('warning');
  });
  test('a tripwire firing escalates to critical with the exit note', () => {
    const ev = pressure({ tier: 'critical', tripwire: { rateMbPerSec: 40, sustainedSec: 60, action: 'exit' } });
    const line = memoryPressureLine(ev);
    expect(line).toContain('leak tripwire fired (40 MB/s sustained 60s)');
    expect(line).toContain('the daemon will exit for a clean restart');
    expect(memoryPressureLevel(ev)).toBe('critical');
  });
  test('a normal-tier recovery is informational', () => {
    expect(memoryPressureLevel(pressure({ tier: 'normal', previousTier: 'elevated' }))).toBe('info');
  });
});
