/**
 * Tests for the permissions.execEnvScrubAllowlist synthetic setting
 * (src/input/exec-env-scrub-config.ts), and its injection into
 * buildSettingGroups's 'permissions' category.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager as ConfigManagerType } from '@pellux/goodvibes-sdk/platform/config';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { applySettingValue } from '../../input/settings-modal-mutations.ts';
import {
  EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY,
  buildExecEnvScrubAllowlistSyntheticEntry,
  isExecEnvScrubAllowlistConfigKey,
  parseExecEnvScrubAllowlistInput,
  readExecEnvScrubAllowlist,
} from '../../input/exec-env-scrub-config.ts';

describe('permissions.execEnvScrubAllowlist synthetic setting', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-exec-env-scrub-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  test('defaults to an empty list', () => {
    const entry = buildExecEnvScrubAllowlistSyntheticEntry(cm);
    expect(entry.setting.key).toBe(EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY);
    expect(entry.currentValue).toEqual([]);
    expect(entry.isDefault).toBe(true);
  });

  test('degrades a malformed (non-array) value to empty, never throws', () => {
    const stub: Pick<ConfigManagerType, 'get'> = { get: () => 'not-an-array' };
    expect(readExecEnvScrubAllowlist(stub)).toEqual([]);
  });

  test('a real ConfigManager reads the permissions section without crashing (no defensive guard needed)', () => {
    // 'permissions' is a real DEFAULT_CONFIG section (backs permissions.mode /
    // permissions.tools.*), so a plain get() never throws for this new leaf key.
    expect(cm.get(EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY)).toBeUndefined();
    const entry = buildExecEnvScrubAllowlistSyntheticEntry(cm);
    expect(entry.currentValue).toEqual([]);
    expect(entry.isDefault).toBe(true);
  });

  test('a real ConfigManager writes the key for real (applySettingValue)', () => {
    const groups = new Map<string, ReturnType<typeof buildExecEnvScrubAllowlistSyntheticEntry>[]>();
    const result = applySettingValue({
      key: EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY,
      value: ['CI_SIGNING_KEY'],
      configManager: cm,
      groups,
      onSettingApplied: null,
      refreshGroups: () => {},
    });
    expect(result.changed).toBe(true);
    expect(result.effectMessage ?? '').not.toContain('Save failed');
    expect(cm.get(EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY)).toEqual(['CI_SIGNING_KEY']);
  });

  test('buildSettingGroups injects the entry into the permissions category exactly once', () => {
    const groups = buildSettingGroups(cm);
    const permissionsKeys = (groups.get('permissions') ?? []).map((e) => e.setting.key);
    expect(permissionsKeys.filter((k) => k === EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY)).toHaveLength(1);
  });

  test('isExecEnvScrubAllowlistConfigKey is true only for its own key', () => {
    expect(isExecEnvScrubAllowlistConfigKey(EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY)).toBe(true);
    expect(isExecEnvScrubAllowlistConfigKey('permissions.mode' as never)).toBe(false);
  });

  test('parseExecEnvScrubAllowlistInput splits on comma, trims, and drops empties', () => {
    expect(parseExecEnvScrubAllowlistInput('CI_SIGNING_KEY, DEPLOY_TOKEN ,, ')).toEqual(['CI_SIGNING_KEY', 'DEPLOY_TOKEN']);
    expect(parseExecEnvScrubAllowlistInput('')).toEqual([]);
  });
});
