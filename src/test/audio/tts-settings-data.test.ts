/**
 * tts-settings-data.test.ts
 *
 * The `tts` settings group: `tts.speed` comes from the SDK's CONFIG_SCHEMA like
 * every other key in it, and the tts.* defaults read back with an accurate
 * modified marker.
 *
 * `tts.speed` used to be hand-built here — a TUI-local descriptor with its own
 * default, its own "positive finite number" normalization, and a cast key —
 * because the schema had no entry for it. It has one now (default 1, range
 * 0.25–4.0), so the row the modal renders is the schema's: same key, same type,
 * one definition of the default, and the range the SDK validates against
 * instead of a second opinion about it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_SCHEMA, ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import {
  buildSettingGroups,
  deepEqual,
  refreshEntryValues,
} from '../../input/settings-modal-data.ts';
import { getNumericAdjustmentMeta } from '../../input/settings-modal-behavior.ts';
import type { SettingEntry, SettingsCategory } from '../../input/settings-modal-types.ts';

const TTS_SPEED = 'tts.speed' as ConfigKey;

let root: string;
let cm: ConfigManager;

beforeEach(() => {
  root = join(tmpdir(), `gv-tts-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  cm = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, 'config'), workingDir: root, homeDir: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ttsSpeedRow(): SettingEntry {
  const rows = buildSettingGroups(cm).get('tts') ?? [];
  const matches = rows.filter((row) => row.setting.key === TTS_SPEED);
  expect(matches, 'tts.speed appears exactly once in the tts group').toHaveLength(1);
  return matches[0]!;
}

describe('tts.speed comes from the config schema', () => {
  test('the schema owns the key, its type, its default and its range', () => {
    const schemaEntry = CONFIG_SCHEMA.find((setting) => setting.key === TTS_SPEED);
    expect(schemaEntry, 'tts.speed is a real CONFIG_SCHEMA key').toBeDefined();
    expect(schemaEntry!.type).toBe('number');
    expect(schemaEntry!.default).toBe(1);
    // The range is enforced by the schema's own validator, so the modal never
    // has to carry a second opinion about what a legal speed is.
    expect(schemaEntry!.validate?.(0.25)).toBe(true);
    expect(schemaEntry!.validate?.(4)).toBe(true);
    expect(schemaEntry!.validate?.(0.1)).toBe(false);
    expect(schemaEntry!.validate?.(5)).toBe(false);
  });

  test('the modal row IS the schema descriptor, not a copy of it', () => {
    const schemaEntry = CONFIG_SCHEMA.find((setting) => setting.key === TTS_SPEED);
    expect(schemaEntry).toBeDefined();
    expect(ttsSpeedRow().setting).toBe(schemaEntry!);
  });

  test('an unset speed reads as the schema default and is marked unmodified', () => {
    const row = ttsSpeedRow();
    expect(row.currentValue).toBe(1);
    expect(row.isDefault).toBe(true);
    expect(deepEqual(row.currentValue, row.setting.default)).toBe(true);
  });

  test('a written speed reads back and is marked modified', () => {
    cm.set(TTS_SPEED, 1.5 as never);
    const row = ttsSpeedRow();
    expect(row.currentValue).toBe(1.5);
    expect(row.isDefault).toBe(false);
  });

  test('refreshEntryValues re-reads it through the same plain schema path', () => {
    const groups = new Map<SettingsCategory, SettingEntry[]>([['tts', [ttsSpeedRow()]]]);
    cm.set(TTS_SPEED, 2 as never);
    refreshEntryValues(groups, cm);
    expect(groups.get('tts')![0]!.currentValue).toBe(2);
    expect(groups.get('tts')![0]!.isDefault).toBe(false);

    cm.set(TTS_SPEED, 1 as never);
    refreshEntryValues(groups, cm);
    expect(groups.get('tts')![0]!.currentValue).toBe(1);
    expect(groups.get('tts')![0]!.isDefault).toBe(true);
  });

  test('the arrow-key adjustment steps within the range the schema accepts', () => {
    expect(getNumericAdjustmentMeta(ttsSpeedRow().setting)).toEqual({
      step: 0.1, min: 0.25, max: 4, precision: 1,
    });
  });

  test('it sits in the tts group beside the other tts.* keys and the always-speak toggle', () => {
    const keys: string[] = (buildSettingGroups(cm).get('tts') ?? []).map((row) => String(row.setting.key));
    for (const key of ['ui.voiceEnabled', 'tts.provider', 'tts.voice', 'tts.speed']) {
      expect(keys, `${key} in the tts group`).toContain(key);
    }
  });
});

describe('tts.* defaults read back with an accurate modified marker', () => {
  test('every tts.* schema key starts unmodified on a fresh config', () => {
    const rows = (buildSettingGroups(cm).get('tts') ?? []).filter((row) => row.setting.key.startsWith('tts.'));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.isDefault, `${row.setting.key} unmodified`).toBe(true);
      expect(row.currentValue).toEqual(row.setting.default);
    }
  });

  test('changing one tts.* key marks that key modified and leaves the rest alone', () => {
    cm.set('tts.provider' as ConfigKey, 'openai' as never);
    const rows = (buildSettingGroups(cm).get('tts') ?? []).filter((row) => row.setting.key.startsWith('tts.'));
    for (const row of rows) {
      expect(row.isDefault, `${row.setting.key}`).toBe(row.setting.key !== 'tts.provider');
    }
  });

  test('deepEqual compares object-valued defaults structurally, not by reference', () => {
    const ttsDefault = { provider: 'elevenlabs', voice: '', llmProvider: '', llmModel: '' };
    expect(deepEqual(ttsDefault, { ...ttsDefault })).toBe(true);
    expect(deepEqual(ttsDefault, { ...ttsDefault, provider: 'openai' })).toBe(false);
  });
});
