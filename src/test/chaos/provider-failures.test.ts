/**
 * Chaos: Provider failure simulation.
 *
 * Simulates provider timeouts, 429 (rate limit), and 5xx (server error)
 * scenarios. These are unit tests — no real network calls are made.
 * Instead we test the health aggregator domain transitions that would
 * be triggered by a provider failure handler, and verify the correct
 * downstream health state.
 */

import { describe, test, expect } from 'bun:test';
import { RuntimeHealthAggregator } from '../../runtime/health/aggregator.ts';
import { CascadeEngine } from '../../runtime/health/cascade-engine.ts';
import { CASCADE_RULES } from '../../runtime/health/cascade-rules.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSystem() {
  const clock = { t: 1000 };
  const aggregator = new RuntimeHealthAggregator(() => clock.t);
  const engine = new CascadeEngine(CASCADE_RULES, aggregator, () => clock.t);
  return { aggregator, engine, clock };
}

// Simulate what a provider failure handler would do:
// mark providerHealth as failed, then evaluate cascades.
function simulateProviderFailure(
  sys: ReturnType<typeof makeSystem>,
  status: 'failed' | 'degraded',
  reason: string,
) {
  sys.aggregator.updateDomainHealth('providerHealth', status, { failureReason: reason });
  return sys.engine.evaluate('providerHealth', status, { reason });
}

// ---------------------------------------------------------------------------
// Provider timeout
// ---------------------------------------------------------------------------

describe('chaos: provider failures', () => {
  describe('provider timeout', () => {
    test('timeout marks providerHealth as failed', () => {
      const sys = makeSystem();
      simulateProviderFailure(sys, 'failed', 'timeout');
      const health = sys.aggregator.getDomainHealth('providerHealth');
      expect(health.status).toBe('failed');
      expect(health.failureReason).toBe('timeout');
    });

    test('timeout degrades composite health', () => {
      const sys = makeSystem();
      simulateProviderFailure(sys, 'failed', 'timeout');
      const composite = sys.aggregator.getCompositeHealth();
      expect(composite.overall).toBe('failed');
      expect(composite.failedDomains).toContain('providerHealth');
    });

    test('timeout as degraded marks composite degraded not failed', () => {
      const sys = makeSystem();
      simulateProviderFailure(sys, 'degraded', 'timeout-partial');
      const composite = sys.aggregator.getCompositeHealth();
      expect(composite.overall).toBe('degraded');
      expect(composite.degradedDomains).toContain('providerHealth');
      expect(composite.failedDomains).not.toContain('providerHealth');
    });
  });

  describe('provider 429 (rate limit)', () => {
    test('429 burst marks providerHealth failed', () => {
      const sys = makeSystem();
      simulateProviderFailure(sys, 'failed', '429-rate-limit');
      const health = sys.aggregator.getDomainHealth('providerHealth');
      expect(health.status).toBe('failed');
      expect(health.failureReason).toBe('429-rate-limit');
    });

    test('429 canExecute blocks operations on providerHealth failure', () => {
      const sys = makeSystem();
      simulateProviderFailure(sys, 'failed', '429-rate-limit');
      // canExecute returns { allowed: boolean }
      const result = sys.aggregator.canExecute('providerHealth', 'stream-response');
      expect(result.allowed).toBe(false);
    });
  });

  describe('provider 5xx (server error)', () => {
    test('5xx marks providerHealth failed', () => {
      const sys = makeSystem();
      simulateProviderFailure(sys, 'failed', '5xx-server-error');
      const health = sys.aggregator.getDomainHealth('providerHealth');
      expect(health.status).toBe('failed');
    });

    test('5xx failure is tracked in failedDomains', () => {
      const sys = makeSystem();
      simulateProviderFailure(sys, 'failed', '5xx-server-error');
      const composite = sys.aggregator.getCompositeHealth();
      expect(composite.failedDomains).toContain('providerHealth');
    });
  });

  describe('recovery after failure', () => {
    test('updating providerHealth to healthy removes from failedDomains', () => {
      const sys = makeSystem();
      simulateProviderFailure(sys, 'failed', 'timeout');
      expect(sys.aggregator.getCompositeHealth().failedDomains).toContain('providerHealth');

      // Provider recovers
      sys.aggregator.updateDomainHealth('providerHealth', 'healthy');
      const composite = sys.aggregator.getCompositeHealth();
      expect(composite.failedDomains).not.toContain('providerHealth');
    });

    test('recovery transitions from failed to healthy updates overall status', () => {
      const sys = makeSystem();
      simulateProviderFailure(sys, 'failed', 'timeout');
      sys.aggregator.updateDomainHealth('providerHealth', 'healthy');

      // Verify composite recovers if no other domain is failed
      const composite = sys.aggregator.getCompositeHealth();
      expect(['healthy', 'unknown']).toContain(composite.overall);
    });
  });

  describe('subscriber notification on failure', () => {
    test('subscriber is called when providerHealth fails', () => {
      const sys = makeSystem();
      let notified = false;
      sys.aggregator.subscribe(() => { notified = true; });

      simulateProviderFailure(sys, 'failed', 'timeout');
      expect(notified).toBe(true);
    });

    test('subscriber receives updated composite health on failure', () => {
      const sys = makeSystem();
      let receivedOverall: string | null = null;
      sys.aggregator.subscribe((health) => { receivedOverall = health.overall; });

      simulateProviderFailure(sys, 'failed', '5xx');
      expect(receivedOverall).toBe('failed');
    });
  });
});
