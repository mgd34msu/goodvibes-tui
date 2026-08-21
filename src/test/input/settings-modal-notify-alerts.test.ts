/**
 * Tests for the behavior.notifyOn* synthetic settings
 * (src/input/settings-modal-data.ts: buildNotifyAlertSyntheticEntries,
 * and their injection into buildSettingGroups's 'behavior' category).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { buildNotifyAlertSyntheticEntries, buildSettingGroups } from '../../input/settings-modal-data.ts';

// These are synthetic settings (buildNotifyAlertSyntheticEntries), not real
// ConfigKey schema entries, the module itself stamps them `as ConfigKey`
// (settings-modal-data.ts), so the test matches that same convention here.
const EXPECTED_KEYS = ([
  'behavior.notifyOnBudgetBreach',
  'behavior.notifyOnAgentFailure',
  'behavior.notifyOnChainFailure',
  'behavior.notifyOnApprovalPending',
  'behavior.notifyOnlyWhenUnfocused',
] as string[]) as ConfigKey[];

describe('buildNotifyAlertSyntheticEntries', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-notify-alerts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: tmpDir, homeDir: tmpDir, configDir: join(tmpDir, '.goodvibes', 'global-tui') });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('produces all five expected keys, defaulting to true', () => {
    const entries = buildNotifyAlertSyntheticEntries(cm);
    expect(entries.map((e) => e.setting.key).sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const entry of entries) {
      expect(entry.setting.type).toBe('boolean');
      expect(entry.currentValue).toBe(true);
      expect(entry.isDefault).toBe(true);
    }
  });

  test('reflects a value written via configManager.set', () => {
    cm.set('behavior.notifyOnlyWhenUnfocused' as ConfigKey, false as never);
    const entries = buildNotifyAlertSyntheticEntries(cm);
    const masterGate = entries.find((e) => e.setting.key === ('behavior.notifyOnlyWhenUnfocused' as ConfigKey));
    expect(masterGate?.currentValue).toBe(false);
    expect(masterGate?.isDefault).toBe(false);
  });

  test('buildSettingGroups injects all five into the behavior category exactly once', () => {
    const groups = buildSettingGroups(cm);
    const behaviorKeys = (groups.get('behavior') ?? []).map((e) => e.setting.key);
    for (const key of EXPECTED_KEYS) {
      expect(behaviorKeys.filter((k) => k === key)).toHaveLength(1);
    }
  });

});
