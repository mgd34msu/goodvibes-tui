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
    // A stub stands in here rather than a real ConfigManager purely to isolate
    // the read-mapping logic from any on-disk store state. (The SDK now
    // registers the `worktree` section in DEFAULT_CONFIG, so a real
    // ConfigManager reads/writes these keys without throwing, covered by the
    // two "real ConfigManager" tests below.)
    // worktree.setup.* keys are not in the SDK's ConfigKey union (see
    // worktree-setup-config.ts's header comment), the real ConfigManager
    // itself reads them "via a cast" per the SDK's own documented convention,
    // so this stub mirrors that same cast rather than fabricating a scalar
    // ConfigValue branch that doesn't exist for these array-shaped keys.
    const stub: Pick<ConfigManagerType, 'get'> = {
      get: ((_key: string) => ['bun install', 'bun run codegen']) as unknown as ConfigManagerType['get'],
    };
    const entry = buildWorktreeSetupCommandsSyntheticEntry(stub);
    expect(entry.currentValue).toEqual(['bun install', 'bun run codegen']);
    expect(entry.isDefault).toBe(false);
  });

  test('degrades a malformed (non-array) value to empty, never throws', () => {
    const stub: Pick<ConfigManagerType, 'get'> = {
      get: ((_key: string) => 'not-an-array') as unknown as ConfigManagerType['get'],
    };
    expect(readWorktreeSetupList(stub, WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY)).toEqual([]);
  });

  test('a real ConfigManager reads the worktree section the SDK now registers, without crashing', () => {
    // The SDK's DEFAULT_CONFIG registers the `worktree` section (setup.commands
    // and setup.carryOverGlobs, both empty lists) as of this repack, so
    // configManager.get no longer throws for these keys on a fresh store, it
    // returns the registered empty default. The synthetic-entry builder (and
    // its defensive try/catch, now belt-and-suspenders) reflects that default.
    // worktree.setup.commands has no branch in the SDK's ConfigValue mapped
    // type (it's an array-shaped key read "via a cast", not a scalar
    // ConfigKey, see worktree-setup-config.ts). Widen through `unknown`
    // before comparing, same as the production readWorktreeSetupList() does.
    const storedCommands: unknown = cm.get(WORKTREE_SETUP_COMMANDS_CONFIG_KEY);
    expect(storedCommands).toEqual([]);
    const entry = buildWorktreeSetupCommandsSyntheticEntry(cm);
    expect(entry.currentValue).toEqual([]);
    expect(entry.isDefault).toBe(true);
  });

  test('a real ConfigManager writes the worktree section the SDK now registers (applySettingValue)', () => {
    // Write-side counterpart: setDynamic succeeds now that the section exists in
    // DEFAULT_CONFIG, so applySettingValue reports a real change and never the
    // "Save failed" message the pre-registration gap used to force.
    const groups = new Map<string, ReturnType<typeof buildWorktreeSetupCommandsSyntheticEntry>[]>();
    const result = applySettingValue({
      key: WORKTREE_SETUP_COMMANDS_CONFIG_KEY,
      value: ['bun install'],
      configManager: cm,
      groups,
      onSettingApplied: null,
      refreshGroups: () => {},
    });
    expect(result.changed).toBe(true);
    expect(result.effectMessage ?? '').not.toContain('Save failed');
    const writtenCommands: unknown = cm.get(WORKTREE_SETUP_COMMANDS_CONFIG_KEY);
    expect(writtenCommands).toEqual(['bun install']);
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
