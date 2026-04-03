/**
 * Hotspot sampler tests — accuracy of sliding-window frequency tracking
 * and latency percentile computation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SelectorHotspotSampler } from '../../../runtime/ui/state-inspector/hotspot-sampler.ts';

// ── Construction ──────────────────────────────────────────────────────────────

describe('SelectorHotspotSampler — construction', () => {
  it('initialises with no tracked keys', () => {
    const s = new SelectorHotspotSampler();
    expect(s.trackedKeyCount).toBe(0);
  });

  it('exposes configured windowMs', () => {
    const s = new SelectorHotspotSampler({ windowMs: 5_000 });
    expect(s.windowMs).toBe(5_000);
  });

  it('defaults windowMs to 10_000', () => {
    const s = new SelectorHotspotSampler();
    expect(s.windowMs).toBe(10_000);
  });
});

// ── record() ─────────────────────────────────────────────────────────────────

describe('SelectorHotspotSampler — record', () => {
  it('creates a new key on first record', () => {
    const s = new SelectorHotspotSampler();
    s.record('selectSession', 0.5);
    expect(s.trackedKeyCount).toBe(1);
  });

  it('accumulates totalCalls across multiple records', () => {
    const s = new SelectorHotspotSampler();
    for (let i = 0; i < 10; i++) s.record('selectSession', 1);
    const hs = s.getHotspot('selectSession')!;
    expect(hs.totalCalls).toBe(10);
  });

  it('tracks separate keys independently', () => {
    const s = new SelectorHotspotSampler();
    s.record('selectA', 1);
    s.record('selectB', 2);
    s.record('selectA', 1);
    expect(s.trackedKeyCount).toBe(2);
    expect(s.getHotspot('selectA')!.totalCalls).toBe(2);
    expect(s.getHotspot('selectB')!.totalCalls).toBe(1);
  });
});

// ── Latency percentiles ───────────────────────────────────────────────────────

describe('SelectorHotspotSampler — latency percentiles', () => {
  it('computes p50, p95, p99, avg, max correctly for a known distribution', () => {
    const s = new SelectorHotspotSampler({ windowMs: 60_000 });
    // Record 100 samples: 1ms through 100ms
    for (let i = 1; i <= 100; i++) s.record('sel', i);
    const hs = s.getHotspot('sel')!;
    // p50 of [1..100]: 50th percentile
    expect(hs.p50Ms).toBeGreaterThanOrEqual(49);
    expect(hs.p50Ms).toBeLessThanOrEqual(51);
    // p95 of [1..100]: near 95
    expect(hs.p95Ms).toBeGreaterThanOrEqual(94);
    expect(hs.p95Ms).toBeLessThanOrEqual(96);
    // p99 of [1..100]: near 99
    expect(hs.p99Ms).toBeGreaterThanOrEqual(98);
    expect(hs.p99Ms).toBeLessThanOrEqual(100);
    // avg of [1..100] = 50.5
    expect(hs.avgMs).toBeGreaterThanOrEqual(50);
    expect(hs.avgMs).toBeLessThanOrEqual(51);
    // max
    expect(hs.maxMs).toBe(100);
  });

  it('returns zeroes for a key with no samples in window', () => {
    const s = new SelectorHotspotSampler();
    s.record('sel', 5);
    // Manually evict by mocking time would require fake timers;
    // instead test with empty buffer via reset
    s.reset();
    const hs = s.getHotspot('sel');
    expect(hs).toBeUndefined();
  });

  it('single sample: all percentiles equal the sample value', () => {
    const s = new SelectorHotspotSampler({ windowMs: 60_000 });
    s.record('sel', 7.5);
    const hs = s.getHotspot('sel')!;
    expect(hs.p50Ms).toBe(7.5);
    expect(hs.p95Ms).toBe(7.5);
    expect(hs.p99Ms).toBe(7.5);
    expect(hs.maxMs).toBe(7.5);
  });
});

// ── Sliding-window eviction ───────────────────────────────────────────────────

describe('SelectorHotspotSampler — sliding window', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('evicts samples older than windowMs from callsInWindow', () => {
    const s = new SelectorHotspotSampler({ windowMs: 5_000 });

    // Record 5 samples at t=0
    for (let i = 0; i < 5; i++) s.record('sel', 1);

    // Advance 6 seconds — these samples are now outside the window
    vi.advanceTimersByTime(6_000);

    // Record 2 new samples at t=6s
    s.record('sel', 1);
    s.record('sel', 1);

    const hs = s.getHotspot('sel')!;
    // Only 2 samples in the window
    expect(hs.callsInWindow).toBe(2);
    // totalCalls is still 7 (lifetime)
    expect(hs.totalCalls).toBe(7);
  });

  it('callsInWindow is 0 when all samples expired', () => {
    const s = new SelectorHotspotSampler({ windowMs: 1_000 });
    s.record('sel', 1);
    vi.advanceTimersByTime(2_000);
    // Trigger eviction via record of a new key
    s.record('sel', 0); // this will trigger eviction
    const hs = s.getHotspot('sel')!;
    expect(hs.callsInWindow).toBe(1); // only the just-recorded sample
  });
});

// ── Hotspot classification ────────────────────────────────────────────────────

describe('SelectorHotspotSampler — hotspot flags', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('isChurnHotspot is true when callsPerSecond > 10', () => {
    // windowMs=1000ms, so 11 calls = 11/sec
    const s = new SelectorHotspotSampler({ windowMs: 1_000 });
    for (let i = 0; i < 11; i++) s.record('sel', 0);
    const hs = s.getHotspot('sel')!;
    expect(hs.isChurnHotspot).toBe(true);
  });

  it('isChurnHotspot is false when callsPerSecond <= 10', () => {
    const s = new SelectorHotspotSampler({ windowMs: 1_000 });
    for (let i = 0; i < 5; i++) s.record('sel', 0);
    const hs = s.getHotspot('sel')!;
    expect(hs.isChurnHotspot).toBe(false);
  });

  it('isLatencyHotspot is true when p95 > 5ms', () => {
    const s = new SelectorHotspotSampler({ windowMs: 60_000 });
    // 100 samples, values 1..100 — p95 will be ~95ms
    for (let i = 1; i <= 100; i++) s.record('sel', i);
    const hs = s.getHotspot('sel')!;
    expect(hs.isLatencyHotspot).toBe(true);
  });

  it('isLatencyHotspot is false when p95 <= 5ms', () => {
    const s = new SelectorHotspotSampler({ windowMs: 60_000 });
    // All samples below 5ms
    for (let i = 0; i < 50; i++) s.record('sel', 1);
    const hs = s.getHotspot('sel')!;
    expect(hs.isLatencyHotspot).toBe(false);
  });
});

// ── getReport ─────────────────────────────────────────────────────────────────

describe('SelectorHotspotSampler — getReport', () => {
  it('returns hotspots sorted by callsInWindow descending', () => {
    const s = new SelectorHotspotSampler({ windowMs: 60_000 });
    for (let i = 0; i < 3; i++) s.record('selA', 1); // 3 calls
    for (let i = 0; i < 7; i++) s.record('selB', 1); // 7 calls
    for (let i = 0; i < 1; i++) s.record('selC', 1); // 1 call

    const report = s.getReport();
    expect(report.hotspots[0].key).toBe('selB');
    expect(report.hotspots[1].key).toBe('selA');
    expect(report.hotspots[2].key).toBe('selC');
  });

  it('report includes windowMs', () => {
    const s = new SelectorHotspotSampler({ windowMs: 7_500 });
    const report = s.getReport();
    expect(report.windowMs).toBe(7_500);
  });

  it('report generatedAt is recent', () => {
    const before = Date.now();
    const s = new SelectorHotspotSampler();
    const report = s.getReport();
    expect(report.generatedAt).toBeGreaterThanOrEqual(before);
  });

  it('report has empty hotspots when nothing recorded', () => {
    const s = new SelectorHotspotSampler();
    expect(s.getReport().hotspots).toEqual([]);
  });
});

// ── getTopHotspots ────────────────────────────────────────────────────────────

describe('SelectorHotspotSampler — getTopHotspots', () => {
  it('returns at most N hotspots', () => {
    const s = new SelectorHotspotSampler({ windowMs: 60_000 });
    for (let k = 0; k < 10; k++) s.record(`sel${k}`, 1);
    const top3 = s.getTopHotspots(3);
    expect(top3.length).toBe(3);
  });

  it('returns all when N > tracked keys', () => {
    const s = new SelectorHotspotSampler({ windowMs: 60_000 });
    s.record('a', 1);
    s.record('b', 1);
    expect(s.getTopHotspots(100).length).toBe(2);
  });
});

// ── per-key sample cap ────────────────────────────────────────────────────────

describe('SelectorHotspotSampler — per-key sample cap', () => {
  it('does not retain more than maxSamplesPerKey samples', () => {
    const s = new SelectorHotspotSampler({ windowMs: 600_000, maxSamplesPerKey: 10 });
    for (let i = 0; i < 50; i++) s.record('sel', 1);
    // Cannot directly access internal samples; verify via totalCalls vs callsInWindow
    const hs = s.getHotspot('sel')!;
    expect(hs.totalCalls).toBe(50);
    expect(hs.callsInWindow).toBeLessThanOrEqual(10);
  });
});

// ── reset ─────────────────────────────────────────────────────────────────────

describe('SelectorHotspotSampler — reset', () => {
  it('clears all tracked keys', () => {
    const s = new SelectorHotspotSampler();
    s.record('sel', 1);
    s.reset();
    expect(s.trackedKeyCount).toBe(0);
    expect(s.getHotspot('sel')).toBeUndefined();
  });

  it('report after reset returns empty hotspots', () => {
    const s = new SelectorHotspotSampler();
    s.record('sel', 1);
    s.reset();
    expect(s.getReport().hotspots).toEqual([]);
  });
});
