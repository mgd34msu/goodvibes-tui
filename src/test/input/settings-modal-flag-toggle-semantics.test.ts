/**
 * Feature-toggle semantics against the live settings→gate bridge.
 *
 * Verifies that a plain domain-settings write (the only write path the
 * settings modal has) keeps persisted config and live gate state consistent,
 * and honestly distinguishes the two feature classes:
 *
 *   - runtime-toggleable feature → applies live (gate state flips) AND the
 *     domain key persists; no restart pending.
 *   - startup-gated feature      → the domain key persists AND the gate
 *     records pending-restart; the effective state is UNCHANGED until the
 *     next launch (never faked live).
 *
 * Uses a real FeatureFlagManager and a real on-disk ConfigManager wired with
 * the SDK's own settings bridge — no mocks — so persistence and bridge
 * behavior are exercised for real, including through the modal's
 * toggleSelectedFlag path.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager, ServiceRegistry, SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { bindFeatureSettingsBridge, deriveFeatureStates } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { createFeatureFlagManager } from '../../runtime/index.ts';
import type { FeatureFlagManager } from '../../runtime/index.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { SettingsModal } from '../../input/settings-modal.ts';

// A feature that flips live, and one gated to startup — both default OFF so
// the toggle direction is unambiguous.
const RUNTIME_FEATURE = 'adaptive-execution-planner'; // planner.adaptive, live, default off
const STARTUP_FEATURE = 'mcp-lifecycle'; // runtime.mcpLifecycle, startup-gated, default off
const STARTUP_ENUM_FEATURE = 'permissions-policy-engine'; // permissions.engine, startup-gated enum

describe('feature-toggle semantics — domain settings writes + gate bridge', () => {
  let tmpDir: string;
  let cm: ConfigManager;
  let manager: FeatureFlagManager;

  const newConfigManager = () =>
    new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: tmpDir,
      homeDir: tmpDir,
      configDir: join(tmpDir, '.goodvibes', 'global-tui'),
    });

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-feature-toggle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
    cm = newConfigManager();
    manager = createFeatureFlagManager();
    manager.loadFromConfig({ flags: deriveFeatureStates(cm) });
    bindFeatureSettingsBridge(cm, manager);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runtime-toggleable feature: live effect AND persisted, no restart pending', () => {
    expect(manager.isEnabled(RUNTIME_FEATURE)).toBe(false);

    cm.setDynamic('planner.adaptive', true);

    // Live effect: the bridge flipped the gate.
    expect(manager.isEnabled(RUNTIME_FEATURE)).toBe(true);
    expect(manager.getState(RUNTIME_FEATURE)).toBe('enabled');
    expect(manager.hasPendingRestart(RUNTIME_FEATURE)).toBe(false);

    // Persisted: the domain key survives reload and seeds the next launch.
    const reloaded = newConfigManager();
    expect(reloaded.get('planner.adaptive')).toBe(true);
    const nextManager = createFeatureFlagManager();
    nextManager.loadFromConfig({ flags: deriveFeatureStates(reloaded) });
    expect(nextManager.isEnabled(RUNTIME_FEATURE)).toBe(true);
  });

  test('startup-gated feature: persisted + pendingRestart, effective state unchanged', () => {
    expect(manager.getState(STARTUP_FEATURE)).toBe('disabled');

    cm.setDynamic('runtime.mcpLifecycle', true);

    // Effective state is NOT faked live — still disabled until restart.
    expect(manager.getState(STARTUP_FEATURE)).toBe('disabled');
    expect(manager.isEnabled(STARTUP_FEATURE)).toBe(false);

    // But the change is recorded as pending a restart, with the target value.
    expect(manager.hasPendingRestart(STARTUP_FEATURE)).toBe(true);
    expect(manager.getPendingRestartState(STARTUP_FEATURE)).toBe('enabled');

    // And the domain key is persisted so the next launch picks it up cleanly.
    const reloaded = newConfigManager();
    expect(reloaded.get('runtime.mcpLifecycle')).toBe(true);
    const nextManager = createFeatureFlagManager();
    nextManager.loadFromConfig({ flags: deriveFeatureStates(reloaded) });
    expect(nextManager.getState(STARTUP_FEATURE)).toBe('enabled');
    expect(nextManager.hasPendingRestart(STARTUP_FEATURE)).toBe(false);
  });

  test('enum feature: the mode value drives the gate through the same bridge', () => {
    expect(manager.isEnabled(STARTUP_ENUM_FEATURE)).toBe(false);

    cm.setDynamic('permissions.engine', 'policy-engine');

    // Startup-gated: pending, not live.
    expect(manager.isEnabled(STARTUP_ENUM_FEATURE)).toBe(false);
    expect(manager.hasPendingRestart(STARTUP_ENUM_FEATURE)).toBe(true);
    expect(manager.getPendingRestartState(STARTUP_ENUM_FEATURE)).toBe('enabled');

    // Back to baseline clears the pending marker (no restart needed anymore).
    cm.setDynamic('permissions.engine', 'baseline');
    expect(manager.hasPendingRestart(STARTUP_ENUM_FEATURE)).toBe(false);
  });

  describe('through the settings modal', () => {
    let modal: SettingsModal;

    beforeEach(() => {
      modal = new SettingsModal();
      const subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'tui', 'subscriptions.json'));
      const serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'tui', 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
        subscriptionManager,
      });
      modal.open(cm, manager, subscriptionManager, serviceRegistry);
    });

    const selectHeader = (key: string, featureId: string): void => {
      modal.selectTarget(key);
      const selected = modal.getSelected();
      if (selected?.flag?.feature.id !== featureId) {
        // Shared or reordered rows: walk the category for the exact header.
        const items = modal.currentItems;
        const index = items.findIndex((entry) => entry.flag?.feature.id === featureId);
        expect(index).toBeGreaterThanOrEqual(0);
        modal.selectedIndex = index;
      }
      expect(modal.getSelected()?.flag?.feature.id).toBe(featureId);
    };

    test('toggleSelectedFlag on a live boolean feature writes the domain key and flips the gate', () => {
      selectHeader('planner.adaptive', RUNTIME_FEATURE);
      modal.toggleSelectedFlag();

      expect(cm.get('planner.adaptive')).toBe(true);
      expect(manager.isEnabled(RUNTIME_FEATURE)).toBe(true);
      const entry = modal.getSelected()!;
      expect(entry.currentValue).toBe(true);
      expect(entry.flag!.state).toBe('enabled');
      expect(entry.flag!.pendingRestart).toBe(false);

      // Toggle back off through the same path.
      modal.toggleSelectedFlag();
      expect(cm.get('planner.adaptive')).toBe(false);
      expect(manager.isEnabled(RUNTIME_FEATURE)).toBe(false);
    });

    test('toggleSelectedFlag on a startup-gated feature shows the pending-restart marker at the point of change', () => {
      selectHeader('runtime.mcpLifecycle', STARTUP_FEATURE);
      modal.toggleSelectedFlag();

      expect(cm.get('runtime.mcpLifecycle')).toBe(true);
      const entry = modal.getSelected()!;
      // The row's saved value changed; the effective state honestly did not.
      expect(entry.currentValue).toBe(true);
      expect(entry.flag!.state).toBe('disabled');
      expect(entry.flag!.pendingRestart).toBe(true);
      expect(entry.flag!.persistedState).toBe('enabled');
    });

    test('toggleSelectedFlag on an enum feature jumps between its stock active mode and its off mode', () => {
      selectHeader('permissions.engine', STARTUP_ENUM_FEATURE);
      modal.toggleSelectedFlag();
      expect(cm.get('permissions.engine')).toBe('policy-engine');
      modal.toggleSelectedFlag();
      expect(cm.get('permissions.engine')).toBe('baseline');
    });
  });
});
