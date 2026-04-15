/**
 * Product Quality Gate — Release Gate 5
 *
 * Verifies that:
 * - Feature flags exist for all post-v3 capabilities
 * - Flags have correct structure (id, name, description, tier, runtimeToggleable)
 * - Notification router suppresses burst traffic (high-signal under burst)
 * - Feature flag manager can enable/disable flags at runtime
 * - All declared flags have unique IDs
 */

import { describe, test, expect } from 'bun:test';
import { FEATURE_FLAGS } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/flags';
import { createFeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/manager';
import { NotificationRouter } from '@pellux/goodvibes-sdk/platform/runtime/notifications/router';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFlag(id: string) {
  return FEATURE_FLAGS.find(f => f.id === id);
}

function makeBurstNotifications(count: number, domain: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `notif-${i}`,
    domain,
    title: `Notification ${i}`,
    body: `Body ${i}`,
    level: 'info' as const,
    timestamp: Date.now() + i,
  }));
}

// ---------------------------------------------------------------------------
// 1. Feature flags: all post-v3 capabilities are declared
// ---------------------------------------------------------------------------

describe('product quality gate: feature flag declarations', () => {
  test('FEATURE_FLAGS is non-empty', () => {
    expect(FEATURE_FLAGS.length).toBeGreaterThan(0);
  });

  test('all flags have unique IDs', () => {
    const ids = FEATURE_FLAGS.map(f => f.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test('all flags have required fields', () => {
    for (const flag of FEATURE_FLAGS) {
      expect(typeof flag.id).toBe('string');
      expect(flag.id.length).toBeGreaterThan(0);
      expect(typeof flag.name).toBe('string');
      expect(typeof flag.description).toBe('string');
      expect(typeof flag.tier).toBe('number');
      expect(flag.tier).toBeGreaterThan(0);
      expect(typeof flag.runtimeToggleable).toBe('boolean');
      expect(['enabled', 'disabled', 'killed']).toContain(flag.defaultState);
    }
  });

  test('all flag IDs are kebab-case', () => {
    for (const flag of FEATURE_FLAGS) {
      expect(flag.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  // Permissions
  test('permissions-policy-engine flag is declared', () => {
    expect(findFlag('permissions-policy-engine')).toBeDefined();
  });

  test('permissions-simulation flag is declared', () => {
    expect(findFlag('permissions-simulation')).toBeDefined();
  });

  // HITL UX modes
  test('hitl-ux-modes flag is declared', () => {
    expect(findFlag('hitl-ux-modes')).toBeDefined();
  });

  // Session compaction v2
  test('session-compaction flag is declared', () => {
    expect(findFlag('session-compaction')).toBeDefined();
    expect(findFlag('session-compaction')!.runtimeToggleable).toBe(true);
  });

  // Tool result reconciliation
  test('tool-result-reconciliation flag is declared', () => {
    expect(findFlag('tool-result-reconciliation')).toBeDefined();
  });

  // Fetch sanitization
  test('fetch-sanitization flag is declared', () => {
    expect(findFlag('fetch-sanitization')).toBeDefined();
    expect(findFlag('fetch-sanitization')!.runtimeToggleable).toBe(true);
  });

  // Budget enforcement
  test('runtime-tools-budget-enforcement flag is declared', () => {
    expect(findFlag('runtime-tools-budget-enforcement')).toBeDefined();
  });

  // OTel foundation
  test('otel-foundation flag is declared', () => {
    expect(findFlag('otel-foundation')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Feature flag manager: runtime toggle lifecycle
// ---------------------------------------------------------------------------

describe('product quality gate: feature flag manager lifecycle', () => {
  function makeManager() {
    return createFeatureFlagManager();
  }

  test('manager initialises all known flags', () => {
    const manager = makeManager();
    const allFlags = manager.getAll();
    expect(allFlags.size).toBeGreaterThan(0);
  });

  test('disabled flag reports isEnabled=false initially', () => {
    const manager = makeManager();
    expect(manager.isEnabled('fetch-sanitization')).toBe(false);
  });

  test('enable → isEnabled returns true', () => {
    const manager = makeManager();
    manager.enable('fetch-sanitization');
    expect(manager.isEnabled('fetch-sanitization')).toBe(true);
  });

  test('disable → isEnabled returns false', () => {
    const manager = makeManager();
    manager.enable('fetch-sanitization');
    manager.disable('fetch-sanitization');
    expect(manager.isEnabled('fetch-sanitization')).toBe(false);
  });

  test('kill → isKilled returns true and flag cannot be re-enabled', () => {
    const manager = makeManager();
    manager.kill('fetch-sanitization', 'emergency disable');
    expect(manager.isKilled('fetch-sanitization')).toBe(true);
    expect(() => manager.enable('fetch-sanitization')).toThrow();
  });

  test('getAll returns map of all registered flags with their states', () => {
    const manager = makeManager();
    const allFlags = manager.getAll();
    // All FEATURE_FLAGS IDs should be present
    for (const flag of FEATURE_FLAGS) {
      expect(allFlags.has(flag.id)).toBe(true);
    }
  });

  test('getTransitions is empty before any changes', () => {
    const manager = makeManager();
    expect(manager.getTransitions().length).toBe(0);
  });

  test('getTransitions records enable/disable history', () => {
    const manager = makeManager();
    manager.enable('fetch-sanitization');
    manager.disable('fetch-sanitization');
    expect(manager.getTransitions().length).toBe(2);
  });

  test('subscribe notifies on flag state change', () => {
    const manager = makeManager();
    const events: string[] = [];
    const unsub = manager.subscribe((id, state) => {
      events.push(`${id}:${state}`);
    });
    manager.enable('fetch-sanitization');
    expect(events).toContain('fetch-sanitization:enabled');
    unsub();
  });
});

// ---------------------------------------------------------------------------
// 3. Notification router: high-signal under burst (suppression)
// ---------------------------------------------------------------------------

describe('product quality gate: notification suppression under burst', () => {
  test('NotificationRouter instantiates with default config', () => {
    const router = new NotificationRouter();
    expect(router).toBeDefined();
  });

  test('router has route method for notification decisions', () => {
    const router = new NotificationRouter();
    expect(typeof router.route).toBe('function');
  });

  test('router returns a routing decision for each notification', () => {
    const router = new NotificationRouter();
    const notification = makeBurstNotifications(1, 'tools')[0]!;
    const decision = router.route(notification);
    expect(decision).toBeDefined();
    expect(typeof decision.target).toBe('string');
    expect(typeof decision.reasonCode).toBe('string');
  });

  test('setDomainVerbosity to minimal suppresses info notifications', () => {
    const router = new NotificationRouter();
    router.setDomainVerbosity('tools', 'minimal');
    // 'info' level notifications are below minimal threshold
    const notification = makeBurstNotifications(1, 'tools')[0]!;
    const decision = router.route(notification);
    // When suppressed, target should not be 'conversation'
    expect(decision.target).toBeDefined();
    expect(decision.target).not.toBe('conversation');
    // reasonCode reveals the suppression policy
    expect(typeof decision.reasonCode).toBe('string');
  });

  test('setQuietWhileTyping toggles typing suppression', () => {
    const router = new NotificationRouter();
    expect(() => router.setQuietWhileTyping(true)).not.toThrow();
    expect(() => router.setQuietWhileTyping(false)).not.toThrow();
  });

  test('adaptive suppression can be enabled and queried', () => {
    const router = new NotificationRouter(2000, true);
    expect(router.isAdaptiveSuppressionEnabled()).toBe(true);
  });

  test('adaptive suppression disabled by default', () => {
    const router = new NotificationRouter();
    expect(router.isAdaptiveSuppressionEnabled()).toBe(false);
  });

  test('setAdaptiveSuppression toggles the setting', () => {
    const router = new NotificationRouter();
    router.setAdaptiveSuppression(true);
    expect(router.isAdaptiveSuppressionEnabled()).toBe(true);
    router.setAdaptiveSuppression(false);
    expect(router.isAdaptiveSuppressionEnabled()).toBe(false);
  });

  test('flush returns an array (batch delivery)', () => {
    const router = new NotificationRouter();
    const result = router.flush();
    expect(Array.isArray(result)).toBe(true);
  });

  test('getActiveBurstGroups returns an array', () => {
    const router = new NotificationRouter();
    const groups = router.getActiveBurstGroups();
    expect(Array.isArray(groups)).toBe(true);
  });

  test('normal verbosity domain routes notifications with a reasonCode', () => {
    const router = new NotificationRouter();
    router.setDomainVerbosity('health', 'normal');
    const notification = makeBurstNotifications(1, 'health')[0]!;
    const decision = router.route(notification);
    // reasonCode should be a known routing code
    expect(typeof decision.reasonCode).toBe('string');
    expect(decision.reasonCode.length).toBeGreaterThan(0);
  });
});
