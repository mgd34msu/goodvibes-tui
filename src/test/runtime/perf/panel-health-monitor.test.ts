/**
 * Panel resource contracts and health monitor tests.
 *
 * Covers:
 * - Contract enforcement: update rate throttling
 * - Render cost budget enforcement and degradation
 * - Render storm containment (many rapid requests do not cascade globally)
 * - Recovery after sustained clean windows
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  ComponentHealthMonitor,
} from '../../../runtime/perf/panel-health-monitor.ts';
import { buildContract } from '../../../runtime/perf/panel-contracts.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a tight contract for testing: 3 updates/s, 5ms render budget. */
function tightContract(panelId: string) {
  return buildContract(panelId, 'monitoring', {
    maxUpdatesPerSecond: 3,
    maxRenderMs: 5,
    throttleIntervalMs: 100,
    degradeAfterViolations: 3,
    degradedIntervalMs: 500,
  });
}

/** Advance a fake clock and simulate N render requests. Returns permit count. */
function simulateRequests(
  monitor: ComponentHealthMonitor,
  panelId: string,
  count: number,
  startMs: number,
  stepMs: number = 10,
): { permitted: number; suppressed: number } {
  let permitted = 0;
  let suppressed = 0;
  for (let i = 0; i < count; i++) {
    const now = startMs + i * stepMs;
    if (monitor.canRender(panelId, now)) {
      permitted++;
    } else {
      suppressed++;
    }
  }
  return { permitted, suppressed };
}

// ---------------------------------------------------------------------------
// Core contract enforcement
// ---------------------------------------------------------------------------

describe('ComponentHealthMonitor: contract enforcement', () => {
  let monitor: ComponentHealthMonitor;

  beforeEach(() => {
    monitor = new ComponentHealthMonitor();
  });

  test('unregistered panel is always permitted', () => {
    expect(monitor.canRender('ghost-panel', 1000)).toBe(true);
  });

  test('registered panel is permitted within rate budget', () => {
    monitor.register('panel-a', 'development'); // 10 updates/s
    // 5 requests over 1 second — within budget
    const { permitted, suppressed } = simulateRequests(monitor, 'panel-a', 5, 1000, 200);
    expect(permitted).toBe(5);
    expect(suppressed).toBe(0);
  });

  test('panel exceeding rate limit is throttled', () => {
    monitor.register('panel-b', 'monitoring', {
      maxUpdatesPerSecond: 2,
      throttleIntervalMs: 200,
      degradeAfterViolations: 10, // high threshold so we stay throttled not degraded
    });
    // 10 rapid requests in 50ms steps — 200ms window contains many
    const { suppressed } = simulateRequests(monitor, 'panel-b', 10, 2000, 50);
    expect(suppressed).toBeGreaterThan(0);
  });

  test('health status is warning after first throttle', () => {
    monitor.register('panel-c', 'monitoring', {
      maxUpdatesPerSecond: 2,
      throttleIntervalMs: 100,
      degradeAfterViolations: 10,
    });
    simulateRequests(monitor, 'panel-c', 20, 3000, 20);
    const health = monitor.getHealth('panel-c')!;
    expect(['warning', 'overloaded']).toContain(health.healthStatus);
    expect(['throttled', 'degraded']).toContain(health.throttleStatus);
  });

  test('nextAllowedAt is set when throttled', () => {
    monitor.register('panel-d', 'monitoring', {
      maxUpdatesPerSecond: 1,
      throttleIntervalMs: 300,
      degradeAfterViolations: 10,
    });
    // Trigger throttle
    for (let i = 0; i < 5; i++) {
      monitor.canRender('panel-d', 4000 + i * 10);
    }
    const health = monitor.getHealth('panel-d')!;
    if (health.throttleStatus !== 'normal') {
      expect(health.nextAllowedAt).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Render cost budget
// ---------------------------------------------------------------------------

describe('ComponentHealthMonitor: render cost enforcement', () => {
  let monitor: ComponentHealthMonitor;

  beforeEach(() => {
    monitor = new ComponentHealthMonitor();
  });

  test('cheap renders do not degrade panel', () => {
    monitor.register('cheap', 'development', { maxRenderMs: 20, degradeAfterViolations: 3 });
    for (let i = 0; i < 10; i++) {
      monitor.canRender('cheap', 5000 + i * 100);
      monitor.recordRender('cheap', 5, 5000 + i * 100 + 3);
    }
    const health = monitor.getHealth('cheap')!;
    expect(health.healthStatus).toBe('healthy');
    expect(health.throttleStatus).toBe('normal');
  });

  test('expensive renders escalate panel health', () => {
    monitor.register('expensive', 'development', {
      maxRenderMs: 5,
      degradeAfterViolations: 3,
      degradedIntervalMs: 500,
    });
    for (let i = 0; i < 20; i++) {
      monitor.canRender('expensive', 6000 + i * 100);
      monitor.recordRender('expensive', 50, 6000 + i * 100 + 50); // 50ms >> 5ms budget
    }
    const health = monitor.getHealth('expensive')!;
    expect(['warning', 'overloaded']).toContain(health.healthStatus);
  });

  test('sustained expensive renders degrade panel to degraded status', () => {
    monitor.register('heavy', 'monitoring', {
      maxRenderMs: 5,
      throttleIntervalMs: 50,
      degradeAfterViolations: 2,
      degradedIntervalMs: 500,
      maxUpdatesPerSecond: 100, // no rate limit — isolate render cost test
    });
    // All renders are very expensive
    for (let i = 0; i < 20; i++) {
      const ok = monitor.canRender('heavy', 7000 + i * 10);
      if (ok) {
        monitor.recordRender('heavy', 100, 7000 + i * 10 + 100);
      }
    }
    const health = monitor.getHealth('heavy')!;
    expect(health.throttleStatus).toBe('degraded');
    expect(health.healthStatus).toBe('overloaded');
  });
});

// ---------------------------------------------------------------------------
// Render storm containment
// ---------------------------------------------------------------------------

describe('ComponentHealthMonitor: render storm containment', () => {
  test('100 rapid requests from one panel are contained without cascading', () => {
    const monitor = new ComponentHealthMonitor();
    // Register multiple panels — only the storming panel should be affected
    monitor.register('storm-panel', 'monitoring', {
      maxUpdatesPerSecond: 2,
      throttleIntervalMs: 200,
      degradeAfterViolations: 3,
      degradedIntervalMs: 1000,
    });
    monitor.register('calm-panel', 'development', {
      maxUpdatesPerSecond: 10,
      throttleIntervalMs: 100,
      degradeAfterViolations: 10,
    });

    // Storm: 100 renders in 10ms steps (10x the allowed rate)
    for (let i = 0; i < 100; i++) {
      monitor.canRender('storm-panel', 8000 + i * 10);
      monitor.recordRender('storm-panel', 5, 8000 + i * 10 + 5);
    }

    const stormHealth = monitor.getHealth('storm-panel')!;
    const calmHealth = monitor.getHealth('calm-panel')!;

    // Storming panel is throttled or degraded
    expect(['throttled', 'degraded']).toContain(stormHealth.throttleStatus);
    expect(stormHealth.totalSuppressed).toBeGreaterThan(0);

    // Calm panel is unaffected
    expect(calmHealth.healthStatus).toBe('healthy');
    expect(calmHealth.throttleStatus).toBe('normal');
    expect(calmHealth.totalSuppressed).toBe(0);
  });

  test('degraded panel respects degradedIntervalMs floor', () => {
    const monitor = new ComponentHealthMonitor();
    monitor.register('degraded-panel', 'monitoring', {
      maxUpdatesPerSecond: 1,
      throttleIntervalMs: 50,
      degradeAfterViolations: 2,
      degradedIntervalMs: 500,
      maxRenderMs: 100,
    });

    let now = 9000;
    // Force degradation
    for (let i = 0; i < 10; i++) {
      monitor.canRender('degraded-panel', now);
      now += 5; // very rapid
    }

    const health = monitor.getHealth('degraded-panel')!;
    if (health.throttleStatus === 'degraded') {
      // Attempt to render immediately after degradation — should be rejected
      const allowed = monitor.canRender('degraded-panel', now);
      expect(allowed).toBe(false);

      // After degradedIntervalMs, should be allowed again
      const allowed2 = monitor.canRender('degraded-panel', now + 600);
      expect(allowed2).toBe(true);
    }
  });

  test('multiple storming panels do not block each other', () => {
    const monitor = new ComponentHealthMonitor();
    for (let p = 0; p < 5; p++) {
      monitor.register(`storm-${p}`, 'monitoring', {
        maxUpdatesPerSecond: 1,
        throttleIntervalMs: 100,
        degradeAfterViolations: 3,
        degradedIntervalMs: 500,
      });
    }

    // Storm all panels simultaneously
    for (let i = 0; i < 20; i++) {
      const now = 10000 + i * 10;
      for (let p = 0; p < 5; p++) {
        monitor.canRender(`storm-${p}`, now);
      }
    }

    // Each panel independently throttled; none affects others
    for (let p = 0; p < 5; p++) {
      const h = monitor.getHealth(`storm-${p}`)!;
      expect(['throttled', 'degraded']).toContain(h.throttleStatus);
    }

    // A freshly registered sixth panel is unaffected
    monitor.register('clean', 'development');
    expect(monitor.canRender('clean', 10500)).toBe(true);
  });

  test('resetHealth clears throttle state', () => {
    const monitor = new ComponentHealthMonitor();
    monitor.register('reset-test', 'monitoring', {
      maxUpdatesPerSecond: 1,
      throttleIntervalMs: 200,
      degradeAfterViolations: 2,
      degradedIntervalMs: 1000,
    });

    // Trigger throttle
    for (let i = 0; i < 10; i++) {
      monitor.canRender('reset-test', 11000 + i * 5);
    }
    expect(monitor.getHealth('reset-test')!.throttleStatus).not.toBe('normal');

    monitor.resetHealth('reset-test');
    const h = monitor.getHealth('reset-test')!;
    expect(h.throttleStatus).toBe('normal');
    expect(h.healthStatus).toBe('healthy');
    expect(h.consecutiveViolations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildContract
// ---------------------------------------------------------------------------

describe('buildContract', () => {
  test('inherits category defaults', () => {
    const c = buildContract('p', 'monitoring');
    expect(c.componentId).toBe('p');
    expect(c.maxUpdatesPerSecond).toBe(2); // monitoring default
  });

  test('overrides apply on top of category', () => {
    const c = buildContract('p', 'monitoring', { maxUpdatesPerSecond: 10 });
    expect(c.maxUpdatesPerSecond).toBe(10);
    // Other fields still from category
    expect(c.maxRenderMs).toBe(50);
  });

  test('unknown category falls back to default contract', () => {
    const c = buildContract('p', 'nonexistent-category');
    expect(c.maxUpdatesPerSecond).toBe(5); // 'default' contract
  });
});
