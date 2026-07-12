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
