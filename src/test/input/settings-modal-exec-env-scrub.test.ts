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
import type { ConfigKey, ConfigManager as ConfigManagerType, ConfigValue } from '@pellux/goodvibes-sdk/platform/config';
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
    // permissions.execEnvScrubAllowlist is TUI-local, not in the SDK's
    // ConfigValue<K> mapping, so it resolves to `never` there; the stub's
    // `get` has to stay generic over K to satisfy ConfigManager's real
    // `get<K extends ConfigKey>(key: K): ConfigValue<K>` signature.
    // The reader is handed a `get` that returns a string where a string[] is
    // expected. Writing this as a generic `<K extends ConfigKey>(key: K) =>
    // ConfigValue<K>` makes tsc compare two deferred `ConfigValue<K>`
    // conditionals against each other and give up with "excessive stack depth"
    // (TS2321), so the stub returns `unknown` and is asserted onto the real
    // member type once, a shallow comparison tsc can actually complete.
    const stub = {
      get: (_key: ConfigKey): unknown => 'not-an-array',
    } as Pick<ConfigManagerType, 'get'>;
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
    // EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY is declared as plain `ConfigKey`
    // (the whole schema union) in exec-env-scrub-config.ts, not narrowed to
    // its own literal, so cm.get(...) here statically resolves to the union
    // of every schema value type, which never includes string[] since this
    // key genuinely isn't schema-registered. It really does round-trip as a
    // string[] at runtime; go through `unknown` to say so, as TS suggests.
    expect(cm.get(EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY) as unknown as string[]).toEqual(['CI_SIGNING_KEY']);
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
