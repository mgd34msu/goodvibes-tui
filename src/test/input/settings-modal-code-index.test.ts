/**
 * Tests for the storage.codeIndexEnabled synthetic setting
 * (src/input/settings-modal-data.ts: buildCodeIndexEnabledSyntheticEntry,
 * and its injection into buildSettingGroups's 'storage' category), and for
 * the shared read isCodeIndexAutoStartEnabled (code-index-services.ts) that
 * /codebase status and RuntimeServices construction both key off of.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { buildCodeIndexEnabledSyntheticEntry, buildSettingGroups } from '../../input/settings-modal-data.ts';
import { CODE_INDEX_ENABLED_CONFIG_KEY, isCodeIndexAutoStartEnabled } from '@pellux/goodvibes-sdk/platform/runtime/operations';

describe('storage.codeIndexEnabled synthetic setting', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-code-index-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  test('defaults OFF — boolean, default false, currentValue false', () => {
    const entry = buildCodeIndexEnabledSyntheticEntry(cm);
    // storage.codeIndexEnabled is a TUI-local synthetic key, not yet part of the
    // SDK's ConfigKey union — compare as plain strings (see settings-modal-data.ts).
    expect(entry.setting.key as string).toBe(CODE_INDEX_ENABLED_CONFIG_KEY as string);
    expect(entry.setting.type).toBe('boolean');
    expect(entry.setting.default).toBe(false);
    expect(entry.currentValue).toBe(false);
    expect(entry.isDefault).toBe(true);
  });

  test('reflects a value written via configManager.set', () => {
    cm.set(CODE_INDEX_ENABLED_CONFIG_KEY as ConfigKey, true as never);
    const entry = buildCodeIndexEnabledSyntheticEntry(cm);
    expect(entry.currentValue).toBe(true);
    expect(entry.isDefault).toBe(false);
  });

  test('buildSettingGroups injects it into the storage category exactly once', () => {
    const groups = buildSettingGroups(cm);
    const storageKeys = (groups.get('storage') ?? []).map((e) => e.setting.key as string);
    expect(storageKeys.filter((k) => k === (CODE_INDEX_ENABLED_CONFIG_KEY as string))).toHaveLength(1);
  });

  test('isCodeIndexAutoStartEnabled mirrors the same key/default the settings entry uses', () => {
    expect(isCodeIndexAutoStartEnabled(cm)).toBe(false);
    cm.set(CODE_INDEX_ENABLED_CONFIG_KEY as ConfigKey, true as never);
    expect(isCodeIndexAutoStartEnabled(cm)).toBe(true);
  });
});
