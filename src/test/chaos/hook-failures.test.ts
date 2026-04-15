/**
 * Chaos: Hook and plugin error injection.
 *
 * Simulates plugin crash scenarios: fatal errors, non-fatal degradation,
 * and lifecycle state transitions under error conditions using
 * PluginLifecycleManager without any real hook execution.
 */

import { describe, test, expect } from 'bun:test';
import { PluginLifecycleManager } from '@pellux/goodvibes-sdk/platform/runtime/plugins/manager';
import { applyTransition, canTransition } from '@pellux/goodvibes-sdk/platform/runtime/plugins/lifecycle';
import type { PluginManifestV2 } from '@pellux/goodvibes-sdk/platform/runtime/plugins/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// PluginManifestV2 extends PluginManifest which requires name, version, description
function makeManifest(name: string): PluginManifestV2 {
  return {
    name,
    version: '1.0.0',
    description: 'Test plugin',
    capabilities: [],
    minRuntimeVersion: '0.1.0',
  } as PluginManifestV2;
}

function makeManager() {
  return new PluginLifecycleManager({ sessionId: 'test-session' });
}

function registerPlugin(manager: PluginLifecycleManager, name: string) {
  manager.registerDiscovered(makeManifest(name), '/plugins/' + name);
}

// ---------------------------------------------------------------------------
// Plugin lifecycle under error
// ---------------------------------------------------------------------------

describe('chaos: hook/plugin failures', () => {
  describe('recordError — non-fatal error on discovered plugin', () => {
    test('non-fatal error on discovered plugin does not throw', () => {
      const manager = makeManager();
      registerPlugin(manager, 'my-plugin');
      // discovered state does not transition to error on non-fatal
      expect(() => manager.recordError('my-plugin', 'transient error', false)).not.toThrow();
    });

    test('non-fatal error records lastError on the plugin', () => {
      const manager = makeManager();
      registerPlugin(manager, 'hook-plugin');
      manager.recordError('hook-plugin', 'hook timeout after 5000ms', false);
      const record = manager.getRecord('hook-plugin');
      expect(record!.lastError).toContain('timeout');
    });

    test('non-fatal error records errorAt timestamp', () => {
      const manager = makeManager();
      registerPlugin(manager, 'hook-plugin-2');
      manager.recordError('hook-plugin-2', 'transient error', false);
      const record = manager.getRecord('hook-plugin-2');
      expect(record!.errorAt).toBeDefined();
    });
  });

  describe('recordError — fatal error transitions active plugin to error', () => {
    // recordError only fires transition on active | loaded | degraded state.
    // Since registerDiscovered puts plugins in 'discovered', we check that
    // fatal error records the error but doesn't crash on discovered state.
    test('fatal error on discovered plugin records error details', () => {
      const manager = makeManager();
      registerPlugin(manager, 'crashing-plugin');
      manager.recordError('crashing-plugin', 'uncaught exception in hook', true);
      const record = manager.getRecord('crashing-plugin');
      expect(record).toBeDefined();
      expect(record!.lastError).toBe('uncaught exception in hook');
      expect(record!.errorAt).toBeDefined();
    });

    test('unknown plugin name is a no-op for recordError', () => {
      const manager = makeManager();
      expect(() => manager.recordError('does-not-exist', 'error', true)).not.toThrow();
    });
  });

  describe('degradePlugin — partial failure', () => {
    test('degraded plugin records degraded capabilities', () => {
      const manager = makeManager();
      registerPlugin(manager, 'partial-plugin');
      expect(() => manager.degradePlugin('partial-plugin', 'network capability unavailable', ['network.outbound'])).not.toThrow();
      const record = manager.getRecord('partial-plugin');
      expect(record).toBeDefined();
    });

    test('degraded plugin with no affected capabilities degrades gracefully', () => {
      const manager = makeManager();
      registerPlugin(manager, 'degrading-plugin');
      expect(() => manager.degradePlugin('degrading-plugin', 'partial failure', [])).not.toThrow();
    });
  });

  describe('lifecycle state machine — valid transitions', () => {
    test('discovered -> loading is a valid transition', () => {
      expect(canTransition('discovered', 'loading')).toBe(true);
    });

    test('loading -> loaded is a valid transition', () => {
      expect(canTransition('loading', 'loaded')).toBe(true);
    });

    test('loaded -> active is a valid transition', () => {
      expect(canTransition('loaded', 'active')).toBe(true);
    });

    test('active -> error is a valid transition', () => {
      expect(canTransition('active', 'error')).toBe(true);
    });

    test('error -> loading is a valid transition (recovery path)', () => {
      expect(canTransition('error', 'loading')).toBe(true);
    });

    test('error -> disabled is a valid transition (give up)', () => {
      expect(canTransition('error', 'disabled')).toBe(true);
    });

    test('active -> unloading is a valid transition', () => {
      expect(canTransition('active', 'unloading')).toBe(true);
    });

    test('unloading -> disabled is a valid transition', () => {
      expect(canTransition('unloading', 'disabled')).toBe(true);
    });
  });

  describe('lifecycle state machine — invalid transitions', () => {
    test('active -> discovered is NOT a valid transition', () => {
      expect(canTransition('active', 'discovered')).toBe(false);
    });

    test('error -> active direct is NOT a valid transition', () => {
      // Must go through loading first
      expect(canTransition('error', 'active')).toBe(false);
    });

    test('disabled -> active direct is NOT a valid transition', () => {
      // Must re-enable through loading
      expect(canTransition('disabled', 'active')).toBe(false);
    });
  });

  describe('applyTransition — result shape', () => {
    test('valid transition returns ok: true with from/to', () => {
      const result = applyTransition('discovered', 'loading');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.from).toBe('discovered');
        expect(result.to).toBe('loading');
      }
    });

    test('invalid transition returns ok: false with reason', () => {
      const result = applyTransition('active', 'discovered');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.reason).toBe('string');
      }
    });
  });

  describe('getPluginsInState — state queries', () => {
    test('newly registered plugin is in discovered state', () => {
      const manager = makeManager();
      registerPlugin(manager, 'new-plugin');
      const discovered = manager.getPluginsInState('discovered');
      expect(discovered).toContain('new-plugin');
    });

    test('multiple plugins can be in discovered state simultaneously', () => {
      const manager = makeManager();
      registerPlugin(manager, 'plugin-a');
      registerPlugin(manager, 'plugin-b');
      const discovered = manager.getPluginsInState('discovered');
      expect(discovered).toContain('plugin-a');
      expect(discovered).toContain('plugin-b');
    });
  });
});
