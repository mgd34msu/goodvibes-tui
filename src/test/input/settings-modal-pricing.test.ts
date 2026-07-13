/**
 * The pricing settings domain reaches the modal from CONFIG_SCHEMA
 * generically — including the object-typed pricing.modelPrices key, which
 * must render honestly (never "[object Object]") and edit as validated JSON
 * persisted live. Also pins that the new notifications.push* and
 * watchers.ciPollIntervalMs keys from this SDK round surface in their
 * existing categories with no TUI-side change.
 */
import { describe, test, expect } from 'bun:test';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { formatValue } from '../../renderer/settings-modal-helpers.ts';
import { SETTINGS_CATEGORIES } from '../../input/settings-modal-types.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import type { SettingEntry } from '../../input/settings-modal-types.ts';

function findEntry(groups: ReturnType<typeof buildSettingGroups>, key: string) {
  for (const entries of groups.values()) {
    const found = entries.find((e) => e.setting.key === key);
    if (found) return found;
  }
  return undefined;
}

describe('pricing settings domain', () => {
  test('the pricing category is registered so pricing.modelPrices is not silently dropped', () => {
    expect(SETTINGS_CATEGORIES).toContain('pricing');
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const entry = findEntry(groups, 'pricing.modelPrices');
    expect(entry).toBeDefined();
    expect(entry!.setting.type).toBe('object');
    expect(typeof entry!.setting.validate).toBe('function');
  });

  test('the schema validator accepts provider:model price maps and rejects bare keys', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const entry = findEntry(groups, 'pricing.modelPrices')!;
    const validate = entry.setting.validate!;
    expect(validate({ 'anthropic:claude-sonnet-4-6': { input: 3, output: 15 } })).toBe(true);
    expect(validate({ 'bare-model': { input: 3, output: 15 } })).toBe(false);
    expect(validate('not an object')).toBe(false);
  });

  test('an empty object value renders (none set), never [object Object]', () => {
    const entry = {
      setting: { key: 'pricing.modelPrices', type: 'object' },
      currentValue: {},
      isDefault: true,
    } as unknown as SettingEntry;
    expect(formatValue(entry)).toBe('(none set)');
  });

  test('a short object value renders its JSON in full', () => {
    const entry = {
      setting: { key: 'pricing.modelPrices', type: 'object' },
      currentValue: { 'openai:gpt-5.4': { input: 5, output: 15 } },
      isDefault: false,
    } as unknown as SettingEntry;
    expect(formatValue(entry)).toBe('{"openai:gpt-5.4":{"input":5,"output":15}}');
  });

  test('a long object value renders an honest entry count with the edit hint', () => {
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) value[`provider:model-${i}`] = { input: i, output: i * 2 };
    const entry = {
      setting: { key: 'pricing.modelPrices', type: 'object' },
      currentValue: value,
      isDefault: false,
    } as unknown as SettingEntry;
    expect(formatValue(entry)).toBe('5 entries (Enter to edit as JSON)');
  });
});

describe('new notification/watcher keys surface generically', () => {
  test('notifications.pushCompletion (default on) reaches the notifications category', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const entry = findEntry(groups, 'notifications.pushCompletion');
    expect(entry).toBeDefined();
    expect(entry!.setting.default).toBe(true);
  });

  test('watchers.ciPollIntervalMs reaches the watchers category with its 60s default', () => {
    const { configManager } = createTestManagers();
    const groups = buildSettingGroups(configManager);
    const entry = findEntry(groups, 'watchers.ciPollIntervalMs');
    expect(entry).toBeDefined();
    expect(entry!.setting.default).toBe(60_000);
  });
});
