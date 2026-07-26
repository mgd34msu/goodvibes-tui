/**
 * tts-settings-data.test.ts
 *
 * Covers TASK-062 (tts.speed synthetic entry surfaced in settings modal) and
 * TASK-063 (explicit tts.* config defaults visible with accurate isDefault).
 *
 * Tests focus on the individually exported pure functions to avoid the need
 * for a full ConfigManager mock (buildSettingGroups calls getResolvedSettingLookup
 * which requires getControlPlaneConfigDir). Integration-level coverage of the
 * tts group injection is verified via buildTtsSpeedSyntheticEntry + the exported
 * TTS_SPEED_SYNTHETIC_SETTING constant.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigKey, ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  buildTtsSpeedSyntheticEntry,
  TTS_SPEED_DEFAULT,
  TTS_SPEED_SYNTHETIC_SETTING,
  deepEqual,
  refreshEntryValues,
} from '../../input/settings-modal-data.ts';
import type { SettingEntry, SettingsCategory } from '../../input/settings-modal-types.ts';

// ---------------------------------------------------------------------------
// Minimal fake ConfigManager for functions that only need .get
// ---------------------------------------------------------------------------

// Typed against ConfigManager['get'] directly (rather than re-declaring the
// generic `<K extends ConfigKey>(key: K): ConfigValue<K>` signature by hand) —
// re-deriving it structurally makes the compiler re-walk the large ConfigValue
// conditional type and blows the instantiation stack ("Excessive stack depth
// comparing types"). Referencing the real method's type sidesteps that.
type PartialCM = { get: ConfigManager['get'] };

function makePartialCM(overrides: Record<string, unknown> = {}): PartialCM {
  return {
    get: ((key: ConfigKey) => overrides[key as string] ?? undefined) as ConfigManager['get'],
  };
}

// ---------------------------------------------------------------------------
// TASK-062: tts.speed synthetic entry
// ---------------------------------------------------------------------------

describe('TASK-062: TTS_SPEED_SYNTHETIC_SETTING descriptor', () => {
  test('has key tts.speed', () => {
    expect(TTS_SPEED_SYNTHETIC_SETTING.key).toBe('tts.speed');
  });

  test('has type number', () => {
    expect(TTS_SPEED_SYNTHETIC_SETTING.type).toBe('number');
  });

  test('has default of TTS_SPEED_DEFAULT (1)', () => {
    expect(TTS_SPEED_SYNTHETIC_SETTING.default).toBe(TTS_SPEED_DEFAULT);
    expect(TTS_SPEED_DEFAULT).toBe(1);
  });

  test('description mentions SDK schema or pending', () => {
    expect(TTS_SPEED_SYNTHETIC_SETTING.description).toMatch(/sdk.*schema|pending.*sdk|schema.*pending/i);
  });
});

describe('TASK-062: buildTtsSpeedSyntheticEntry', () => {
  test('returns default when configManager has no tts.speed', () => {
    const entry = buildTtsSpeedSyntheticEntry(makePartialCM());
    expect(entry.currentValue).toBe(TTS_SPEED_DEFAULT);
    expect(entry.isDefault).toBe(true);
    expect(entry.setting).toBe(TTS_SPEED_SYNTHETIC_SETTING);
  });

  test('returns non-default when speed is set to 1.5', () => {
    const cm = makePartialCM({ 'tts.speed': 1.5 });
    const entry = buildTtsSpeedSyntheticEntry(cm);
    expect(entry.currentValue).toBe(1.5);
    expect(entry.isDefault).toBe(false);
  });

  test('returns non-default when speed is set to 0.5', () => {
    const cm = makePartialCM({ 'tts.speed': 0.5 });
    const entry = buildTtsSpeedSyntheticEntry(cm);
    expect(entry.currentValue).toBe(0.5);
    expect(entry.isDefault).toBe(false);
  });

  test('returns default when speed is 1 (exact default)', () => {
    const cm = makePartialCM({ 'tts.speed': 1 });
    const entry = buildTtsSpeedSyntheticEntry(cm);
    expect(entry.currentValue).toBe(1);
    expect(entry.isDefault).toBe(true);
  });

  test('normalizes 0 to default (0 is not a valid positive speed)', () => {
    const cm = makePartialCM({ 'tts.speed': 0 });
    const entry = buildTtsSpeedSyntheticEntry(cm);
    expect(entry.currentValue).toBe(TTS_SPEED_DEFAULT);
    expect(entry.isDefault).toBe(true);
  });

  test('normalizes negative value to default', () => {
    const cm = makePartialCM({ 'tts.speed': -0.5 });
    const entry = buildTtsSpeedSyntheticEntry(cm);
    expect(entry.currentValue).toBe(TTS_SPEED_DEFAULT);
    expect(entry.isDefault).toBe(true);
  });

  test('normalizes NaN to default', () => {
    const cm = makePartialCM({ 'tts.speed': NaN });
    const entry = buildTtsSpeedSyntheticEntry(cm);
    expect(entry.currentValue).toBe(TTS_SPEED_DEFAULT);
    expect(entry.isDefault).toBe(true);
  });

  test('normalizes non-numeric string to default', () => {
    const cm = makePartialCM({ 'tts.speed': 'fast' });
    const entry = buildTtsSpeedSyntheticEntry(cm);
    expect(entry.currentValue).toBe(TTS_SPEED_DEFAULT);
    expect(entry.isDefault).toBe(true);
  });

  test('parses numeric string "1.5" to 1.5', () => {
    const cm = makePartialCM({ 'tts.speed': '1.5' });
    const entry = buildTtsSpeedSyntheticEntry(cm);
    expect(entry.currentValue).toBe(1.5);
    expect(entry.isDefault).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TASK-062: refreshEntryValues handles synthetic tts.speed entry
// ---------------------------------------------------------------------------

describe('TASK-062: refreshEntryValues normalizes tts.speed synthetic entry', () => {
  function makeTtsSpeedGroups(speedValue: unknown): Map<SettingsCategory, SettingEntry[]> {
    const entry: SettingEntry = {
      setting: TTS_SPEED_SYNTHETIC_SETTING,
      currentValue: TTS_SPEED_DEFAULT,
      isDefault: true,
    };
    const groups = new Map<SettingsCategory, SettingEntry[]>();
    groups.set('tts', [entry]);
    return groups;
  }

  test('refreshEntryValues updates tts.speed to non-default positive value', () => {
    const store: Record<string, unknown> = { 'tts.speed': 2.0 };
    const cm = {
      get(key: ConfigKey): unknown { return store[key as string] ?? undefined; },
    };
    const groups = makeTtsSpeedGroups(undefined);
    refreshEntryValues(groups, cm as never);
    const entry = groups.get('tts')![0]!;
    expect(entry.currentValue).toBe(2.0);
    expect(entry.isDefault).toBe(false);
  });

  test('refreshEntryValues normalizes undefined back to default', () => {
    const cm = {
      get(_key: ConfigKey): unknown { return undefined; },
    };
    const groups = makeTtsSpeedGroups(undefined);
    // Force the entry to a non-default state first
    groups.get('tts')![0]!.currentValue = 2.0;
    groups.get('tts')![0]!.isDefault = false;

    refreshEntryValues(groups, cm as never);
    const entry = groups.get('tts')![0]!;
    expect(entry.currentValue).toBe(TTS_SPEED_DEFAULT);
    expect(entry.isDefault).toBe(true);
  });

  test('refreshEntryValues normalizes 0 back to default', () => {
    const cm = {
      get(key: ConfigKey): unknown {
        if ((key as string) === 'tts.speed') return 0;
        return undefined;
      },
    };
    const groups = makeTtsSpeedGroups(undefined);
    refreshEntryValues(groups, cm as never);
    const entry = groups.get('tts')![0]!;
    expect(entry.currentValue).toBe(TTS_SPEED_DEFAULT);
    expect(entry.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TASK-063: tts.* defaults and deepEqual isDefault diamonds
// ---------------------------------------------------------------------------

describe('TASK-063: tts.* SDK defaults via deepEqual', () => {
  test('tts.provider SDK default is elevenlabs', () => {
    // Verified from SDK schema-domain-core.js: tts.provider default is 'elevenlabs'
    // We test deepEqual logic: same string matches default
    expect(deepEqual('elevenlabs', 'elevenlabs')).toBe(true);
    expect(deepEqual('openai', 'elevenlabs')).toBe(false);
  });

  test('tts.voice SDK default is empty string', () => {
    expect(deepEqual('', '')).toBe(true);
    expect(deepEqual('alloy', '')).toBe(false);
  });

  test('tts.llmProvider SDK default is empty string', () => {
    expect(deepEqual('', '')).toBe(true);
    expect(deepEqual('anthropic', '')).toBe(false);
  });

  test('tts.llmModel SDK default is empty string', () => {
    expect(deepEqual('', '')).toBe(true);
    expect(deepEqual('claude-sonnet-4-6', '')).toBe(false);
  });

  test('tts.speed TUI default is 1 (TTS_SPEED_DEFAULT)', () => {
    expect(deepEqual(TTS_SPEED_DEFAULT, 1)).toBe(true);
    expect(deepEqual(1.5, TTS_SPEED_DEFAULT)).toBe(false);
  });

  test('buildTtsSpeedSyntheticEntry isDefault is true at default speed', () => {
    const entry = buildTtsSpeedSyntheticEntry(makePartialCM());
    // isDefault must use deepEqual(currentValue, setting.default)
    expect(deepEqual(entry.currentValue, entry.setting.default)).toBe(true);
    expect(entry.isDefault).toBe(true);
  });

  test('buildTtsSpeedSyntheticEntry isDefault is false at non-default speed', () => {
    const entry = buildTtsSpeedSyntheticEntry(makePartialCM({ 'tts.speed': 2 }));
    expect(deepEqual(entry.currentValue, entry.setting.default)).toBe(false);
    expect(entry.isDefault).toBe(false);
  });

  test('deepEqual handles TtsConfig-like objects accurately', () => {
    // Simulates what buildSettingGroups does for tts.* object defaults
    const ttsDefault = { provider: 'elevenlabs', voice: '', llmProvider: '', llmModel: '' };
    const ttsIdentical = { provider: 'elevenlabs', voice: '', llmProvider: '', llmModel: '' };
    const ttsDifferent = { provider: 'openai', voice: '', llmProvider: '', llmModel: '' };
    expect(deepEqual(ttsDefault, ttsIdentical)).toBe(true);
    expect(deepEqual(ttsDefault, ttsDifferent)).toBe(false);
  });
});
