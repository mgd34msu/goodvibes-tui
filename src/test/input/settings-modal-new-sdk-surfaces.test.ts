/**
 * Regression coverage for the three new schema-driven settings surfaced by
 * the 1.6.1 SDK dev-link refresh: behavior.compactionStrategy,
 * telemetry.decisionOtlp* (Enabled/Endpoint/Signal), and
 * sandbox.judgmentAutoApprove.
 *
 * All three are already honestly described at the SDK schema layer
 * (CONFIG_SCHEMA), and buildSettingGroups() surfaces every schema entry
 * generically by category — no TUI-side override needed. These tests pin
 * that the honesty properties the task called out actually reach the
 * rendered description text through the real TUI path, so a future SDK
 * description rewrite that drops them fails loudly here instead of only
 * showing up as an unexplained golden-frame diff.
 */
import { describe, test, expect } from 'bun:test';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { CATEGORY_INFO, CATEGORY_LABELS } from '../../renderer/settings-modal-helpers.ts';

function findEntry(groups: ReturnType<typeof buildSettingGroups>, key: string) {
  for (const entries of groups.values()) {
    const found = entries.find((e) => e.setting.key === key);
    if (found) return found;
  }
  return undefined;
}

describe('new SDK settings surfaces — honest descriptions reach the modal', () => {
  test('behavior.compactionStrategy says the distiller path is gated and what it falls back to', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const entry = findEntry(groups, 'behavior.compactionStrategy');
    expect(entry).toBeDefined();
    expect(entry!.setting.description).toContain('distiller');
    expect(entry!.setting.description).toContain('falls back to structured');
    expect(entry!.setting.default).toBe('structured');
  });

  test('telemetry.decisionOtlpEnabled says off by default and export-only', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const entry = findEntry(groups, 'telemetry.decisionOtlpEnabled');
    expect(entry).toBeDefined();
    expect(entry!.setting.description).toContain('export-only');
    expect(entry!.setting.default).toBe(false);
    expect(entry!.isDefault).toBe(true); // off by default in a fresh config
  });

  test('telemetry.decisionOtlpEndpoint and decisionOtlpSignal are also surfaced', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    expect(findEntry(groups, 'telemetry.decisionOtlpEndpoint')).toBeDefined();
    expect(findEntry(groups, 'telemetry.decisionOtlpSignal')).toBeDefined();
  });

  test('sandbox.judgment says annotate is the default and auto-approve is the explicit opt-in', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    // The boolean judgmentAutoApprove key dissolved into the sandbox.judgment
    // mode enum (off | annotate | auto-approve).
    const entry = findEntry(groups, 'sandbox.judgment');
    expect(entry).toBeDefined();
    expect(entry!.setting.description).toContain('annotate (default');
    expect(entry!.setting.description).toContain('explicit opt-in');
    expect(entry!.setting.default).toBe('annotate');
    expect(entry!.isDefault).toBe(true);
  });
});

/**
 * Regression coverage for the twelve occasions.* settings the SDK added for
 * the proactive occasions/plans loop (docs/occasions.md §8).
 *
 * buildSettingGroups() guards every push with `if (groups.has(cat))`, keyed
 * off the setting key's own prefix as a SettingsCategory — the exact failure
 * class the settings-modal-types.ts comments document for push.* and
 * cluster.* (dropped from the workspace entirely, reachable only by
 * hand-editing a settings file). Before this test, 'occasions' had no entry
 * in SettingsCategory, SETTINGS_CATEGORY_GROUPS, CATEGORY_LABELS or
 * CATEGORY_INFO, so all twelve keys would silently vanish from the settings
 * modal despite being real, invokable, schema-declared config. Fixed by
 * adding 'occasions' to all four; this test pins that every key actually
 * lands in a group and that the category has a real label and description
 * (never an empty modal panel — see the "modals show full text" standard).
 */
describe('occasions settings surface — all twelve keys reach the modal, not dropped', () => {
  const OCCASIONS_SETTING_KEYS = [
    'occasions.enabled',
    'occasions.leadDays',
    'occasions.activeHours',
    'occasions.nudgeChannel',
    'occasions.cadenceDays',
    'occasions.finalStretchDays',
    'occasions.awayAdjust',
    'occasions.calendarMirror',
    'occasions.suppressMirroredNudges',
    'occasions.interviewQuestions',
    'occasions.giftHistoryYears',
    'occasions.sweepIntervalMinutes',
  ] as const;

  test('every occasions.* key is present in buildSettingGroups output', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    for (const key of OCCASIONS_SETTING_KEYS) {
      expect(findEntry(groups, key), `${key} missing from buildSettingGroups — dropped from the workspace`).toBeDefined();
    }
  });

  test('every occasions.* key lands specifically in the occasions category group', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const occasionsEntries = groups.get('occasions') ?? [];
    const occasionsKeys = new Set(occasionsEntries.map((e) => e.setting.key));
    for (const key of OCCASIONS_SETTING_KEYS) {
      expect(occasionsKeys.has(key), `${key} not in the 'occasions' group`).toBe(true);
    }
  });

  test('occasions.enabled defaults on and occasions.nudgeChannel defaults to telegram', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const enabled = findEntry(groups, 'occasions.enabled');
    expect(enabled!.setting.default).toBe(true);
    const channel = findEntry(groups, 'occasions.nudgeChannel');
    // Owner ruling 2026-07-28 (docs/occasions.md §8): nudges push to Telegram
    // out of the box; empty makes it pull-only.
    expect(channel!.setting.default).toBe('telegram');
  });

  test('the occasions category has a real label and a non-empty description (no clipped/blank panel)', () => {
    expect(CATEGORY_LABELS.occasions).toBeTruthy();
    expect(CATEGORY_INFO.occasions).toBeTruthy();
    expect(CATEGORY_INFO.occasions.length).toBeGreaterThan(20);
  });
});
