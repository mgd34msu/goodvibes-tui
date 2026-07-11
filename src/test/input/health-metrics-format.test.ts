import { describe, expect, test } from 'bun:test';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import {
  formatQuotaSnapshotLine,
  renderMetricMap,
  telemetryScopeRefusalLine,
} from '../../input/commands/health-metrics-format.ts';

describe('renderMetricMap', () => {
  test('empty map says "none reported", not a zero count line', () => {
    expect(renderMetricMap('counters', {})).toEqual(['  counters: none reported']);
    expect(renderMetricMap('gauges', undefined)).toEqual(['  gauges: none reported']);
  });

  test('renders sorted key: value entries with the count header', () => {
    const lines = renderMetricMap('counters', { 'http.requests': 12, 'auth.failures': 3 });
    expect(lines[0]).toBe('  counters: 2');
    expect(lines).toContain('    auth.failures: 3');
    expect(lines).toContain('    http.requests: 12');
    // sorted: auth before http
    expect(lines.indexOf('    auth.failures: 3')).toBeLessThan(lines.indexOf('    http.requests: 12'));
  });

  test('caps the listing and reports the remainder honestly', () => {
    const map: Record<string, number> = {};
    for (let i = 0; i < 50; i++) map[`k${String(i).padStart(2, '0')}`] = i;
    const lines = renderMetricMap('counters', map);
    expect(lines[0]).toBe('  counters: 50');
    // 1 header + 40 entries + 1 remainder line
    expect(lines).toHaveLength(42);
    expect(lines[lines.length - 1]).toBe('    (+10 more)');
  });
});

describe('telemetryScopeRefusalLine', () => {
  test('names the missing read:telemetry scope on 401/403 (never zeros)', () => {
    for (const status of [401, 403]) {
      const line = telemetryScopeRefusalLine(new GoodVibesSdkError('nope', { status }), 'runtime metrics');
      expect(line).toContain('read:telemetry');
      expect(line).toContain(String(status));
      expect(line).not.toMatch(/\b0\b/);
    }
  });

  test('returns null for non-scope errors so the caller renders the generic message', () => {
    expect(telemetryScopeRefusalLine(new GoodVibesSdkError('boom', { status: 500 }), 'runtime metrics')).toBeNull();
    expect(telemetryScopeRefusalLine(new Error('plain'), 'runtime metrics')).toBeNull();
  });
});

describe('formatQuotaSnapshotLine', () => {
  test('hasSignal:false renders an explicit "no signal yet", not a fabricated quota', () => {
    const line = formatQuotaSnapshotLine('anthropic', { hasSignal: false, recentRateLimitCount: 0 });
    expect(line).toContain('no rate-limit signal observed yet');
    expect(line).not.toContain('remaining');
  });

  test('hasSignal:true renders the observed remaining/limit and reset', () => {
    const line = formatQuotaSnapshotLine('anthropic', {
      hasSignal: true,
      remaining: 40,
      limit: 100,
      resetAt: 0,
      recentRateLimitCount: 2,
    });
    expect(line).toContain('remaining 40/100');
    expect(line).toContain('resets 1970-01-01T00:00:00.000Z');
    expect(line).toContain('2 recent rate-limit event(s)');
  });
});
