/**
 * Tests for computeBudgetBreach / readBudgetAlertUsd (src/export/cost-utils.ts).
 *
 * These are the pure predicate and config-reader CostTrackerPanel's render-time
 * "OVER BUDGET" flag and the background budget-breach notifier both share, so
 * they agree on exactly one definition of "over budget" and one source of
 * truth for the configured threshold.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { computeBudgetBreach, readBudgetAlertUsd, BUDGET_ALERT_USD_DEFAULT, BUDGET_ALERT_USD_CONFIG_KEY } from '@pellux/goodvibes-sdk/platform/providers';

describe('computeBudgetBreach', () => {
  test('false when no budget is configured (threshold <= 0)', () => {
    expect(computeBudgetBreach(1000, 0)).toBe(false);
    expect(computeBudgetBreach(1000, -5)).toBe(false);
  });

  test('false when cost is under the threshold', () => {
    expect(computeBudgetBreach(5, 10)).toBe(false);
  });

  test('false when cost exactly equals the threshold (breach is strictly over)', () => {
    expect(computeBudgetBreach(10, 10)).toBe(false);
  });

  test('true when cost exceeds the threshold', () => {
    expect(computeBudgetBreach(10.01, 10)).toBe(true);
  });
});

describe('readBudgetAlertUsd', () => {
  function makeConfigGet(overrides: Record<string, unknown> = {}) {
    return (key: string): unknown => overrides[key];
  }

  test('returns BUDGET_ALERT_USD_DEFAULT (0) when the key is absent', () => {
    expect(readBudgetAlertUsd(makeConfigGet({}))).toBe(BUDGET_ALERT_USD_DEFAULT);
  });

  test('returns the configured value when valid', () => {
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': 25 }))).toBe(25);
  });

  test('returns the default when the value is negative', () => {
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': -5 }))).toBe(BUDGET_ALERT_USD_DEFAULT);
  });

  test('returns the default when the value is NaN or non-numeric', () => {
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': NaN }))).toBe(BUDGET_ALERT_USD_DEFAULT);
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': 'lots' }))).toBe(BUDGET_ALERT_USD_DEFAULT);
  });

  test('coerces a numeric string', () => {
    expect(readBudgetAlertUsd(makeConfigGet({ 'behavior.budgetAlertUsd': '15' }))).toBe(15);
  });
});

/**
 * readBudgetAlertUsd persistence across a real ConfigManager restart.
 *
 * budgetAlertUsd is a "synthetic" key: it was never registered in the SDK's
 * CONFIG_SCHEMA (cost-tracker-panel.ts writes it via configAccess.set with a
 * plain string key, bypassing schema validation entirely). That raises a
 * real question the pure-predicate tests above can't answer: does a value
 * written through the *actual* SDK ConfigManager survive being reloaded from
 * disk by a brand-new instance (what happens on every real process restart),
 * given the key has no schema entry, no default in DEFAULT_CONFIG.behavior,
 * and is deep-merged in as a bare extra property? These tests exercise the
 * real ConfigManager class (no mocking) against a scratch directory to prove
 * it does — and that clearing back to 0 survives a restart too, so "0
 * reliably disables" holds after a real process restart, not just in-memory.
 */
describe('behavior.budgetAlertUsd persistence across a ConfigManager restart', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-budget-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfigManager(): ConfigManager {
    return new ConfigManager({ surfaceRoot: 'tui', workingDir: tmpDir, homeDir: tmpDir, configDir: join(tmpDir, '.goodvibes', 'global-tui') });
  }

  test('a nonzero threshold set on one instance is read back by a freshly constructed instance', () => {
    const first = makeConfigManager();
    first.set(BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey, 12.5 as never);

    // Simulate a process restart: a brand-new ConfigManager pointed at the
    // same directory, with no in-memory state carried over.
    const second = makeConfigManager();
    expect(readBudgetAlertUsd((k) => second.get(k as ConfigKey))).toBe(12.5);
  });

  test('clearing to 0 survives a restart — a later instance does not resurrect the old nonzero value', () => {
    const first = makeConfigManager();
    first.set(BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey, 12.5 as never);
    first.set(BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey, 0 as never);

    const second = makeConfigManager();
    expect(readBudgetAlertUsd((k) => second.get(k as ConfigKey))).toBe(BUDGET_ALERT_USD_DEFAULT);

    // And a third instance constructed after that — the value must not
    // flip back on any later restart either.
    const third = makeConfigManager();
    expect(readBudgetAlertUsd((k) => third.get(k as ConfigKey))).toBe(0);
  });

  test('a value set by one instance is visible to a second instance constructed afterward without needing its own set() call', () => {
    // Regression guard for the "two long-running processes disagree" class of
    // bug: a second ConfigManager instance constructed AFTER the first
    // process wrote a new value must load the updated value from disk, not
    // silently default because the key is schema-less.
    const writer = makeConfigManager();
    writer.set(BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey, 7 as never);

    const reader = makeConfigManager();
    expect(readBudgetAlertUsd((k) => reader.get(k as ConfigKey))).toBe(7);
  });
});
