import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  applyStagedManagedBundle,
  applySettingsSyncBundle,
  formatResolvedSettingReview,
  formatStagedManagedBundleReview,
  getSettingsControlPlaneSnapshot,
  resolveSettingsSyncConflict,
  rollbackManagedApply,
  stageManagedSettingsBundle,
} from '@/runtime/index.ts';
import type { ManagedSettingsBundle } from '@/runtime/index.ts';
import { resetSettingsControlPlaneStore } from '../helpers/settings-control-plane.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('runtime/settings/control-plane', () => {
  let root = '';
  let configDir = '';

  beforeEach(() => {
    root = makeProjectTempDir('gv-settings-plane');
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
        'provider.model': 'openai:managed-model',
      },
    };

    stageManagedSettingsBundle(config, managed, join(root, 'managed.json'));
    applyStagedManagedBundle(config);

    const review = formatResolvedSettingReview(config, 'provider.model');
    expect(review).toContain('Resolved Setting Review');
    expect(review).toContain('key: provider.model');
    expect(review).toContain('effective source: managed');
    expect(review).toContain('managed value: openai:managed-model');
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
        'provider.model': 'openai:managed-model',
        'display.stream': false,
      },
    };

    stageManagedSettingsBundle(config, managed, join(root, 'managed.json'));
    const review = formatStagedManagedBundleReview(config);
    expect(review).toContain('Staged Managed Bundle Review');
    expect(review).toContain('profileName: ops');
    expect(review).toContain('provider.model');
    expect(review).toContain('next: openai:managed-model');
  });

  test('partial staged apply leaves unmatched keys staged and rollback restores previous values', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir });
    config.setDynamic('provider.model', 'openai:gpt-5');
    config.setDynamic('display.stream', true);

    const managed: ManagedSettingsBundle = {
      version: 1,
      exportedAt: Date.now(),
      profileName: 'ops',
      settings: {
        'provider.model': 'openai:managed-model',
        'display.stream': false,
      },
    };

    stageManagedSettingsBundle(config, managed, join(root, 'managed.json'));
    const applied = applyStagedManagedBundle(config, ['provider.model']);
    expect(applied.appliedCount).toBe(1);
    expect(applied.remainingCount).toBe(1);
    expect(config.get('provider.model')).toBe('openai:managed-model');
    expect(config.get('display.stream')).toBe(true);

    const snapshot = getSettingsControlPlaneSnapshot(config);
    expect(snapshot.stagedManagedBundle).toBeDefined();
    expect(snapshot.stagedManagedBundle?.changes.map((change) => change.key)).toEqual(['display.stream']);

    const restored = rollbackManagedApply(config, applied.rollbackToken);
    expect(restored).toBe(1);
    expect(config.get('provider.model')).toBe('openai:gpt-5');
    expect(config.get('display.stream')).toBe(true);
  });

  test('synced conflicts can be resolved back to local or kept as synced', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir });
    config.setDynamic('provider.model', 'openai:local-model');

    const bundle = {
      version: 1 as const,
      exportedAt: Date.now(),
      source: 'settings-sync' as const,
      settings: {
        'provider.model': 'openai:synced-model',
      },
    };

    const applied = applySettingsSyncBundle(config, bundle, join(root, 'settings-sync.json'));
    expect(applied.conflictCount).toBe(1);
    expect(config.get('provider.model')).toBe('openai:synced-model');

    let snapshot = getSettingsControlPlaneSnapshot(config);
    expect(snapshot.conflicts.length).toBe(1);
    expect(resolveSettingsSyncConflict(config, 'provider.model', 'local')).toBe(true);
    expect(config.get('provider.model')).toBe('openai:local-model');

    snapshot = getSettingsControlPlaneSnapshot(config);
    expect(snapshot.conflicts.length).toBe(0);
    expect(snapshot.resolvedEntries.find((entry) => entry.key === 'provider.model')?.effectiveSource).toBe('local');

    applySettingsSyncBundle(config, bundle, join(root, 'settings-sync.json'));
    expect(resolveSettingsSyncConflict(config, 'provider.model', 'synced')).toBe(true);
    expect(config.get('provider.model')).toBe('openai:synced-model');

    snapshot = getSettingsControlPlaneSnapshot(config);
    expect(snapshot.conflicts.length).toBe(0);
    expect(snapshot.resolvedEntries.find((entry) => entry.key === 'provider.model')?.effectiveSource).toBe('synced');
  });
});
