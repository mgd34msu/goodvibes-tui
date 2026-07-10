/**
 * Tests for the worktree.setup.commands / worktree.setup.carryOverGlobs
 * synthetic settings (src/input/worktree-setup-config.ts, and their
 * injection into buildSettingGroups's 'orchestration' category).
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
  WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY,
  WORKTREE_SETUP_COMMANDS_CONFIG_KEY,
  buildWorktreeSetupCarryOverGlobsSyntheticEntry,
  buildWorktreeSetupCommandsSyntheticEntry,
  isWorktreeSetupListConfigKey,
  parseWorktreeSetupListInput,
  readWorktreeSetupList,
} from '../../input/worktree-setup-config.ts';

describe('worktree.setup.* synthetic settings', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-worktree-setup-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  test('defaults to an empty list for both keys', () => {
    const commands = buildWorktreeSetupCommandsSyntheticEntry(cm);
    const globs = buildWorktreeSetupCarryOverGlobsSyntheticEntry(cm);
    expect(commands.setting.key).toBe(WORKTREE_SETUP_COMMANDS_CONFIG_KEY);
    expect(commands.currentValue).toEqual([]);
    expect(commands.isDefault).toBe(true);
    expect(globs.setting.key).toBe(WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY);
    expect(globs.currentValue).toEqual([]);
    expect(globs.isDefault).toBe(true);
  });

  test('reflects a value the config store already holds for the key', () => {
    // A stub stands in here rather than a real ConfigManager: as of the SDK
    // 1.6.1 repack, 'worktree' has no entry in DEFAULT_CONFIG (unlike every
    // other synthetic-setting section — behavior, storage, display, tts all
    // pre-exist), so ConfigManager.get/set/setDynamic throw "Invalid config
    // path: section 'worktree' does not exist" for a store that has never
    // had the key written. That SDK-side gap is covered by the "never
    // crashes" tests below; this test isolates the read-mapping logic itself.
    const stub: Pick<ConfigManagerType, 'get'> = { get: () => ['bun install', 'bun run codegen'] };
    const entry = buildWorktreeSetupCommandsSyntheticEntry(stub);
    expect(entry.currentValue).toEqual(['bun install', 'bun run codegen']);
    expect(entry.isDefault).toBe(false);
  });

  test('degrades a malformed (non-array) value to empty, never throws', () => {
    const stub: Pick<ConfigManagerType, 'get'> = { get: () => 'not-an-array' };
    expect(readWorktreeSetupList(stub, WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY)).toEqual([]);
  });

  test('a real ConfigManager missing the worktree config section never crashes the read path', () => {
    // Documents the actual SDK 1.6.1 gap: 'worktree' isn't in DEFAULT_CONFIG,
    // so configManager.get throws for this key on a fresh store. The
    // synthetic-entry builder must degrade to an empty list, not propagate.
    expect(() => cm.get(WORKTREE_SETUP_COMMANDS_CONFIG_KEY)).toThrow();
    const entry = buildWorktreeSetupCommandsSyntheticEntry(cm);
    expect(entry.currentValue).toEqual([]);
    expect(entry.isDefault).toBe(true);
  });

  test('a real ConfigManager missing the worktree config section never crashes the write path (applySettingValue)', () => {
    // Documents the write-side counterpart: applySettingValue must surface an
    // honest "Save failed" effect message instead of throwing, since
    // configManager.setDynamic also throws for this section on a fresh store.
    const groups = new Map<string, ReturnType<typeof buildWorktreeSetupCommandsSyntheticEntry>[]>();
    const result = applySettingValue({
      key: WORKTREE_SETUP_COMMANDS_CONFIG_KEY,
      value: ['bun install'],
      configManager: cm,
      groups,
      onSettingApplied: null,
      refreshGroups: () => {},
    });
    expect(result.changed).toBe(false);
    expect(result.effectMessage).toContain('Save failed');
  });

  test('buildSettingGroups injects both entries into the orchestration category exactly once', () => {
    const groups = buildSettingGroups(cm);
    const orchestrationKeys = (groups.get('orchestration') ?? []).map((e) => e.setting.key);
    expect(orchestrationKeys.filter((k) => k === WORKTREE_SETUP_COMMANDS_CONFIG_KEY)).toHaveLength(1);
    expect(orchestrationKeys.filter((k) => k === WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY)).toHaveLength(1);
  });

  test('isWorktreeSetupListConfigKey is true only for the two worktree-setup keys', () => {
    expect(isWorktreeSetupListConfigKey(WORKTREE_SETUP_COMMANDS_CONFIG_KEY)).toBe(true);
    expect(isWorktreeSetupListConfigKey(WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY)).toBe(true);
    expect(isWorktreeSetupListConfigKey('behavior.autoApprove' as never)).toBe(false);
  });

  test('parseWorktreeSetupListInput splits on comma, trims, and drops empties', () => {
    expect(parseWorktreeSetupListInput('bun install, bun run codegen ,, ')).toEqual(['bun install', 'bun run codegen']);
    expect(parseWorktreeSetupListInput('')).toEqual([]);
    expect(parseWorktreeSetupListInput('.env, .env.*,config/local.json')).toEqual(['.env', '.env.*', 'config/local.json']);
  });
});
