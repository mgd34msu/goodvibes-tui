/**
 * Tests for the behavior.budgetAlertUsd synthetic setting
 * (src/input/settings-modal-data.ts: buildBudgetAlertUsdSyntheticEntry,
 * and its injection into buildSettingGroups's 'behavior' category).
 *
 * Context: budgetAlertUsd is a TUI-local key, never registered in the SDK's
 * CONFIG_SCHEMA. Before this entry existed, the actual USD threshold was
 * invisible to every schema-driven inspection surface (/config, and
 * /settings-sync show <key>, which rejects any key outside CONFIG_KEYS) even
 * though it round-tripped correctly through configManager.get/set. This test
 * locks in that /config behavior now shows the real value.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { buildBudgetAlertUsdSyntheticEntry, buildSettingGroups } from '../../input/settings-modal-data.ts';
import { BUDGET_ALERT_USD_CONFIG_KEY, BUDGET_ALERT_USD_DEFAULT } from '../../export/cost-utils.ts';

describe('buildBudgetAlertUsdSyntheticEntry', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-budget-alert-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  test('defaults to BUDGET_ALERT_USD_DEFAULT (0 = disabled) when never set', () => {
    const entry = buildBudgetAlertUsdSyntheticEntry(cm);
    // BUDGET_ALERT_USD_CONFIG_KEY is TUI-local and not in the SDK's ConfigKey
    // union (see settings-modal-data.ts doc comment); production code casts
    // it the same way when building the synthetic setting descriptor.
    expect(entry.setting.key).toBe(BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey);
    expect(entry.setting.type).toBe('number');
    expect(entry.currentValue).toBe(BUDGET_ALERT_USD_DEFAULT);
    expect(entry.isDefault).toBe(true);
  });

  test('reflects a nonzero value written via configManager.set', () => {
    cm.set(BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey, 25 as never);
    const entry = buildBudgetAlertUsdSyntheticEntry(cm);
    expect(entry.currentValue).toBe(25);
    expect(entry.isDefault).toBe(false);
  });

  test('reflects clearing back to 0 (disabled) after a nonzero value', () => {
    cm.set(BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey, 25 as never);
    cm.set(BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey, 0 as never);
    const entry = buildBudgetAlertUsdSyntheticEntry(cm);
    expect(entry.currentValue).toBe(0);
    expect(entry.isDefault).toBe(true);
  });

  test('buildSettingGroups injects it into the behavior category exactly once, alongside the notifyOnBudgetBreach gate', () => {
    const groups = buildSettingGroups(cm);
    const behaviorKeys = (groups.get('behavior') ?? []).map((e) => e.setting.key);
    // Both keys below are TUI-local synthetic settings, not members of the
    // SDK's ConfigKey union — same `as ConfigKey` cast production code uses.
    expect(behaviorKeys.filter((k) => k === (BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey))).toHaveLength(1);
    expect(behaviorKeys).toContain('behavior.notifyOnBudgetBreach' as ConfigKey);
  });
});
