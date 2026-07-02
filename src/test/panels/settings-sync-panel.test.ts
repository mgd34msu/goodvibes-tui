import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  applySettingsSyncBundle,
  stageManagedSettingsBundle,
} from '@/runtime/index.ts';
import type { ManagedSettingsBundle } from '@/runtime/index.ts';
import { resetSettingsControlPlaneStore } from '../helpers/settings-control-plane.ts';
import { SettingsSyncPanel } from '../../panels/settings-sync-panel.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import type { PanelIntegrationContext } from '../../panels/types.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeCtx(overrides: Partial<PanelIntegrationContext> = {}): PanelIntegrationContext & { executeCommand: ReturnType<typeof mock> } {
  const executeCommand = mock(() => Promise.resolve(undefined));
  const panelManager = { open: mock(() => undefined) } as unknown as PanelManager;
  return { panelManager, executeCommand, ...overrides } as PanelIntegrationContext & { executeCommand: ReturnType<typeof mock> };
}

describe('SettingsSyncPanel', () => {
  let root = '';
  let configDir = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-settings-sync-panel-'));
    configDir = join(root, '.goodvibes', 'tui');
    resetSettingsControlPlaneStore(new ConfigManager({ surfaceRoot: 'tui', configDir }));
  });

  afterEach(() => {
    resetSettingsControlPlaneStore(new ConfigManager({ surfaceRoot: 'tui', configDir }));
    configDir = '';
  });

  function makeConflictedConfig(): ConfigManager {
    const config = new ConfigManager({ surfaceRoot: 'tui', configDir });
    config.setDynamic('provider.model', 'openai:local-model');
    applySettingsSyncBundle(config, {
      version: 1 as const,
      exportedAt: Date.now(),
      source: 'settings-sync' as const,
      settings: { 'provider.model': 'openai:synced-model' },
    }, join(root, 'settings-sync-bundle.json'));
    return config;
  }

  test('Enter on a conflicted entry opens an inline local/synced picker', () => {
    const config = makeConflictedConfig();
    const panel = new SettingsSyncPanel(config);
    const idx = panel.getItems().findIndex((entry) => entry.key === 'provider.model');
    expect(idx).toBeGreaterThanOrEqual(0);
    (panel as unknown as { selectedIndex: number }).selectedIndex = idx;

    expect(panel.handleInput('enter')).toBe(true);
    const text = linesText(panel.render(120, 30));
    expect(text).toContain('Resolve conflict for "provider.model"?');
  });

  test('l resolves the conflict to local via executeCommand through the integration hook', () => {
    const config = makeConflictedConfig();
    const panel = new SettingsSyncPanel(config);
    const idx = panel.getItems().findIndex((entry) => entry.key === 'provider.model');
    (panel as unknown as { selectedIndex: number }).selectedIndex = idx;
    panel.handleInput('enter');

    expect(panel.handleInput('l')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('l', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    expect(ctx.executeCommand).toHaveBeenCalledWith('settings-sync', ['resolve', 'provider.model', 'local']);
  });

  test('s resolves the conflict to synced via executeCommand through the integration hook', () => {
    const config = makeConflictedConfig();
    const panel = new SettingsSyncPanel(config);
    const idx = panel.getItems().findIndex((entry) => entry.key === 'provider.model');
    (panel as unknown as { selectedIndex: number }).selectedIndex = idx;
    panel.handleInput('enter');

    expect(panel.handleInput('s')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('s', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledWith('settings-sync', ['resolve', 'provider.model', 'synced']);
  });

  test('Esc cancels the picker without dispatching a resolve command', () => {
    const config = makeConflictedConfig();
    const panel = new SettingsSyncPanel(config);
    const idx = panel.getItems().findIndex((entry) => entry.key === 'provider.model');
    (panel as unknown as { selectedIndex: number }).selectedIndex = idx;
    panel.handleInput('enter');

    expect(panel.handleInput('escape')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('escape', ctx)).toBe(false);
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    const text = linesText(panel.render(120, 30));
    expect(text).not.toContain('Resolve conflict for');
  });

  test('Enter on a non-conflicted entry does not open the picker', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui', configDir });
    const panel = new SettingsSyncPanel(config);
    (panel as unknown as { selectedIndex: number }).selectedIndex = 0;
    panel.handleInput('enter');
    const text = linesText(panel.render(120, 30));
    expect(text).not.toContain('Resolve conflict for');
  });

  test('m opens managed review via executeCommand when a staged managed bundle is present', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui', configDir });
    const bundle: ManagedSettingsBundle = {
      version: 1,
      exportedAt: Date.now(),
      profileName: 'ops',
      settings: { 'provider.model': 'openai:managed-model' },
    };
    stageManagedSettingsBundle(config, bundle, join(root, 'managed.json'));
    const panel = new SettingsSyncPanel(config);

    expect(panel.handleInput('m')).toBe(true);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('m', ctx)).toBe(true);
    expect(ctx.executeCommand).toHaveBeenCalledWith('managed', ['review']);
  });

  test('m is a no-op when no managed bundle is staged', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui', configDir });
    const panel = new SettingsSyncPanel(config);
    expect(panel.handleInput('m')).toBe(false);
    const ctx = makeCtx();
    expect(panel.handlePanelIntegrationAction('m', ctx)).toBe(false);
    expect(ctx.executeCommand).not.toHaveBeenCalled();
  });

  test('Tab moves events/locks/failures/conflicts/rollback into their own browse mode, keeping the keys viewport out of the way', () => {
    const config = makeConflictedConfig();
    const panel = new SettingsSyncPanel(config);
    const keysText = linesText(panel.render(120, 30));
    expect(keysText).toContain('Settings posture');

    expect(panel.handleInput('tab')).toBe(true); // events
    let text = linesText(panel.render(120, 30));
    expect(text).toContain('Recent Sync & Managed-Setting Events');

    expect(panel.handleInput('tab')).toBe(true); // locks
    text = linesText(panel.render(120, 30));
    expect(text).toContain('Managed Locks');

    expect(panel.handleInput('tab')).toBe(true); // failures
    text = linesText(panel.render(120, 30));
    expect(text).toContain('Sync & Managed-Setting Failures');

    expect(panel.handleInput('tab')).toBe(true); // conflicts
    text = linesText(panel.render(120, 30));
    expect(text).toContain('Settings Conflicts');
    expect(text).toContain('provider.model');

    expect(panel.handleInput('tab')).toBe(true); // rollback
    text = linesText(panel.render(120, 30));
    expect(text).toContain('Managed Rollback History');

    expect(panel.handleInput('tab')).toBe(true); // back to keys
    text = linesText(panel.render(120, 30));
    expect(text).toContain('Settings posture');
  });

  test('keyboard hints show real keys, not slash commands', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui', configDir });
    const panel = new SettingsSyncPanel(config);
    const text = linesText(panel.render(120, 24));
    expect(text).not.toContain('/settings-sync');
    expect(text).not.toContain('/managed');
    expect(text).toContain('resolve conflict');
    expect(text).toContain('managed review');
  });

  test('list-mode header stays within a compact fixed budget (posture summary: title + 4 rows)', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui', configDir });
    const panel = new SettingsSyncPanel(config);
    const header = (panel as unknown as {
      _buildPostureHeader: (width: number, snapshot: unknown) => Line[];
    })._buildPostureHeader(120, {
      resolvedEntries: [],
      conflicts: [],
      recentFailures: [],
      managedLockCount: 0,
      stagedManagedBundle: undefined,
      resolvedCounts: { local: 0, synced: 0, managed: 0, default: 0 },
      lastSync: undefined,
    });
    expect(header.length).toBe(5);
  });
});
