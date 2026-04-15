import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import {
  applyStagedManagedBundle,
  applySettingsSyncBundle,
  formatResolvedSettingReview,
  formatStagedManagedBundleReview,
  getSettingsControlPlaneSnapshot,
  resolveSettingsSyncConflict,
  rollbackManagedApply,
  stageManagedSettingsBundle,
} from '@pellux/goodvibes-sdk/platform/runtime/settings/control-plane';
import type { ManagedSettingsBundle } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/types';
import { resetSettingsControlPlaneStore } from '../helpers/settings-control-plane.ts';

describe('runtime/settings/control-plane', () => {
  let root = '';
  let configDir = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-settings-plane-'));
    configDir = join(root, '.goodvibes', 'tui');
    resetSettingsControlPlaneStore(new ConfigManager({ surfaceRoot: 'tui',  configDir }));
  });

  afterEach(() => {
    resetSettingsControlPlaneStore(new ConfigManager({ surfaceRoot: 'tui',  configDir }));
    configDir = '';
  });

  test('formats resolved setting review with layer provenance', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir });
    const managed: ManagedSettingsBundle = {
      version: 1,
      exportedAt: Date.now(),
      profileName: 'ops',
      settings: {
        'provider.model': 'managed-model',
      },
    };

    stageManagedSettingsBundle(config, managed, join(root, 'managed.json'));
    applyStagedManagedBundle(config);

    const review = formatResolvedSettingReview(config, 'provider.model');
    expect(review).toContain('Resolved Setting Review');
    expect(review).toContain('key: provider.model');
    expect(review).toContain('effective source: managed');
    expect(review).toContain('managed value: managed-model');
    expect(review).toContain('live lock:');
    expect(review).toContain('managed layer:');
  });

  test('formats staged managed bundle review with change details', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir });
    const managed: ManagedSettingsBundle = {
      version: 1,
      exportedAt: Date.now(),
      profileName: 'ops',
      settings: {
        'provider.model': 'managed-model',
        'provider.provider': 'openai',
      },
    };

    stageManagedSettingsBundle(config, managed, join(root, 'managed.json'));
    const review = formatStagedManagedBundleReview(config);
    expect(review).toContain('Staged Managed Bundle Review');
    expect(review).toContain('profileName: ops');
    expect(review).toContain('provider.model');
    expect(review).toContain('next: managed-model');
  });

  test('partial staged apply leaves unmatched keys staged and rollback restores previous values', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir });
    config.setDynamic('provider.model', 'gpt-5');
    config.setDynamic('provider.provider', 'openrouter');

    const managed: ManagedSettingsBundle = {
      version: 1,
      exportedAt: Date.now(),
      profileName: 'ops',
      settings: {
        'provider.model': 'managed-model',
        'provider.provider': 'openai',
      },
    };

    stageManagedSettingsBundle(config, managed, join(root, 'managed.json'));
    const applied = applyStagedManagedBundle(config, ['provider.model']);
    expect(applied.appliedCount).toBe(1);
    expect(applied.remainingCount).toBe(1);
    expect(config.get('provider.model')).toBe('managed-model');
    expect(config.get('provider.provider')).toBe('openrouter');

    const snapshot = getSettingsControlPlaneSnapshot(config);
    expect(snapshot.stagedManagedBundle).toBeDefined();
    expect(snapshot.stagedManagedBundle?.changes.map((change) => change.key)).toEqual(['provider.provider']);

    const restored = rollbackManagedApply(config, applied.rollbackToken);
    expect(restored).toBe(1);
    expect(config.get('provider.model')).toBe('gpt-5');
    expect(config.get('provider.provider')).toBe('openrouter');
  });

  test('synced conflicts can be resolved back to local or kept as synced', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir });
    config.setDynamic('provider.model', 'local-model');

    const bundle = {
      version: 1 as const,
      exportedAt: Date.now(),
      source: 'settings-sync' as const,
      settings: {
        'provider.model': 'synced-model',
      },
    };

    const applied = applySettingsSyncBundle(config, bundle, join(root, 'settings-sync.json'));
    expect(applied.conflictCount).toBe(1);
    expect(config.get('provider.model')).toBe('synced-model');

    let snapshot = getSettingsControlPlaneSnapshot(config);
    expect(snapshot.conflicts.length).toBe(1);
    expect(resolveSettingsSyncConflict(config, 'provider.model', 'local')).toBe(true);
    expect(config.get('provider.model')).toBe('local-model');

    snapshot = getSettingsControlPlaneSnapshot(config);
    expect(snapshot.conflicts.length).toBe(0);
    expect(snapshot.resolvedEntries.find((entry) => entry.key === 'provider.model')?.effectiveSource).toBe('local');

    applySettingsSyncBundle(config, bundle, join(root, 'settings-sync.json'));
    expect(resolveSettingsSyncConflict(config, 'provider.model', 'synced')).toBe(true);
    expect(config.get('provider.model')).toBe('synced-model');

    snapshot = getSettingsControlPlaneSnapshot(config);
    expect(snapshot.conflicts.length).toBe(0);
    expect(snapshot.resolvedEntries.find((entry) => entry.key === 'provider.model')?.effectiveSource).toBe('synced');
  });
});
