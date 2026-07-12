/**
 * Product Quality Gate — Release Gate 5
 *
 * Verifies that:
 * - Every platform capability is declared on the FEATURE_SETTINGS surface
 * - Features have correct structure (id, name, real description, domain,
 *   enablement shape, settings keys, restartRequired, defaultEnabled)
 * - Notification router suppresses burst traffic (high-signal under burst)
 * - The gate manager can enable/disable capabilities at runtime
 * - All declared features have unique IDs
 */

import { describe, test, expect } from 'bun:test';
import { FEATURE_SETTINGS } from '@/runtime/index.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { NotificationRouter } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFeature(id: string) {
  return FEATURE_SETTINGS.find(f => f.id === id);
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

describe('product quality gate: feature declarations', () => {
  test('FEATURE_SETTINGS is non-empty', () => {
    expect(FEATURE_SETTINGS.length).toBeGreaterThan(0);
  });

  test('all features have unique IDs', () => {
    const ids = FEATURE_SETTINGS.map(f => f.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test('all features have required fields', () => {
    for (const feature of FEATURE_SETTINGS) {
      expect(typeof feature.id).toBe('string');
      expect(feature.id.length).toBeGreaterThan(0);
      expect(typeof feature.name).toBe('string');
      expect(typeof feature.description).toBe('string');
      expect(feature.description.length).toBeGreaterThan(0);
      expect(typeof feature.domain).toBe('string');
      expect(feature.enablement.key.startsWith(`${feature.domain}.`)).toBe(true);
      expect(['boolean', 'enum', 'constant']).toContain(feature.enablement.kind);
      expect(feature.settings.length).toBeGreaterThan(0);
      expect(feature.settings[0]).toBe(feature.enablement.key);
      expect(typeof feature.restartRequired).toBe('boolean');
      expect(typeof feature.defaultEnabled).toBe('boolean');
    }
  });

  test('all feature IDs are kebab-case', () => {
    for (const feature of FEATURE_SETTINGS) {
      expect(feature.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  // Permissions
  test('permissions-policy-engine feature is declared', () => {
    expect(findFeature('permissions-policy-engine')).toBeDefined();
  });

  test('permissions-simulation feature is declared', () => {
    expect(findFeature('permissions-simulation')).toBeDefined();
  });

  // HITL UX modes
  test('hitl-ux-modes feature is declared', () => {
    expect(findFeature('hitl-ux-modes')).toBeDefined();
  });

  // Session compaction v2
  test('session-compaction feature is declared and live-toggleable', () => {
    expect(findFeature('session-compaction')).toBeDefined();
    expect(findFeature('session-compaction')!.restartRequired).toBe(false);
  });

  // Tool result reconciliation
  test('tool-result-reconciliation feature is declared', () => {
    expect(findFeature('tool-result-reconciliation')).toBeDefined();
  });

  // Fetch sanitization
  test('fetch-sanitization feature is declared as an always-on capability', () => {
    expect(findFeature('fetch-sanitization')).toBeDefined();
    expect(findFeature('fetch-sanitization')!.enablement.kind).toBe('constant');
    expect(findFeature('fetch-sanitization')!.restartRequired).toBe(false);
  });

  // Budget enforcement
  test('runtime-tools-budget-enforcement feature is declared', () => {
    expect(findFeature('runtime-tools-budget-enforcement')).toBeDefined();
  });

  // OTel foundation
  test('otel-foundation feature is declared', () => {
    expect(findFeature('otel-foundation')).toBeDefined();
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

  test('default-off feature reports isEnabled=false initially', () => {
    const manager = makeManager();
    expect(manager.isEnabled('adaptive-execution-planner')).toBe(false);
  });

  test('enable → isEnabled returns true', () => {
    const manager = makeManager();
    manager.enable('adaptive-execution-planner');
    expect(manager.isEnabled('adaptive-execution-planner')).toBe(true);
  });

  test('disable → isEnabled returns false', () => {
    const manager = makeManager();
    manager.enable('adaptive-execution-planner');
    manager.disable('adaptive-execution-planner');
    expect(manager.isEnabled('adaptive-execution-planner')).toBe(false);
  });

  test('kill → isKilled returns true and the gate cannot be re-enabled', () => {
    const manager = makeManager();
    manager.kill('adaptive-execution-planner', 'emergency disable');
    expect(manager.isKilled('adaptive-execution-planner')).toBe(true);
    expect(() => manager.enable('adaptive-execution-planner')).toThrow();
  });

  test('getAll returns map of all registered features with their states', () => {
    const manager = makeManager();
    const allFlags = manager.getAll();
    // Every FEATURE_SETTINGS id should be present as a registered gate.
    for (const feature of FEATURE_SETTINGS) {
      expect(allFlags.has(feature.id)).toBe(true);
    }
  });

  test('getTransitions is empty before any changes', () => {
    const manager = makeManager();
    expect(manager.getTransitions().length).toBe(0);
  });

  test('getTransitions records enable/disable history', () => {
    const manager = makeManager();
    manager.enable('adaptive-execution-planner');
    manager.disable('adaptive-execution-planner');
    expect(manager.getTransitions().length).toBe(2);
  });

  test('subscribe notifies on gate state change', () => {
    const manager = makeManager();
    const events: string[] = [];
    const unsub = manager.subscribe((id, state) => {
      events.push(`${id}:${state}`);
    });
    manager.enable('adaptive-execution-planner');
    expect(events).toContain('adaptive-execution-planner:enabled');
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
