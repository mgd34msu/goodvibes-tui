/**
 * Tests for the sandbox.egressAllowlist / sandbox.workspaceWritable synthetic
 * settings (src/input/sandbox-exec-config.ts), and their injection into
 * buildSettingGroups's 'sandbox' category.
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
  SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY,
  SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY,
  buildSandboxEgressAllowlistSyntheticEntry,
  buildSandboxWorkspaceWritableSyntheticEntry,
  isSandboxExecListConfigKey,
  parseSandboxExecListInput,
  readSandboxExecList,
} from '../../input/sandbox-exec-config.ts';

/**
 * Reads the 'sandbox' category directly (the same call registerAllTools makes
 * at tool-registration time) instead of cm.get(SANDBOX_*_CONFIG_KEY): the SDK's
 * exported ConfigKey union is missing the egressAllowlist/workspaceWritable
 * dotted leaf entries (present for every sibling sandbox.* key), so a generic
 * cm.get(key) call with those constants can't recover a usable ConfigValue<K>.
 */
function readSandboxCategory(configManager: Pick<ConfigManagerType, 'getCategory'>): { egressAllowlist: string[]; workspaceWritable: string[] } {
  return configManager.getCategory('sandbox') as { egressAllowlist: string[]; workspaceWritable: string[] };
}

describe('sandbox.egressAllowlist / sandbox.workspaceWritable synthetic settings', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gv-sandbox-exec-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    const egress = buildSandboxEgressAllowlistSyntheticEntry(cm);
    const writable = buildSandboxWorkspaceWritableSyntheticEntry(cm);
    expect(egress.setting.key).toBe(SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY);
    expect(egress.currentValue).toEqual([]);
    expect(egress.isDefault).toBe(true);
    expect(writable.setting.key).toBe(SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY);
    expect(writable.currentValue).toEqual([]);
    expect(writable.isDefault).toBe(true);
  });

  test('degrades a malformed (non-array) value to empty, never throws', () => {
    // The stub returns `unknown` and is asserted onto the real member type
    // once. Re-declaring `get` as its own `<K extends ConfigKey>(key: K) =>
    // ConfigValue<K>` generic makes tsc compare two deferred ConfigValue<K>
    // conditionals against each other and give up with "excessive stack depth"
    // (TS2321) — and it does so unpredictably, moving between files as the
    // config schema grows.
    const stub = {
      get: (_key: ConfigKey): unknown => 'not-an-array',
    } as Pick<ConfigManagerType, 'get'>;
    expect(readSandboxExecList(stub, SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY)).toEqual([]);
  });

  test('a real ConfigManager reads the sandbox section without crashing (no defensive guard needed)', () => {
    // 'sandbox' has been a real DEFAULT_CONFIG section since before this repack
    // (it backs the VM/REPL isolation settings), so a plain get() never throws
    // for these leaf keys — unlike worktree.setup.* pre-registration.
    //
    // Read through getCategory('sandbox') rather than cm.get(KEY) directly:
    // egressAllowlist/workspaceWritable are real GoodVibesConfig['sandbox']
    // fields, but the SDK's exported ConfigKey union is missing their dotted
    // leaf entries (present for every sibling sandbox.* key — qemuBinary,
    // vmBackend, etc. — but not these two), which is why sandbox-exec-config.ts
    // has to force these constants through `as ConfigKey` in the first place.
    // A generic cm.get(SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY) call can't recover
    // a useful ConfigValue<K> from that widened key type; getCategory reads
    // the real schema field directly instead.
    expect(readSandboxCategory(cm).egressAllowlist).toEqual([]);
    const entry = buildSandboxEgressAllowlistSyntheticEntry(cm);
    expect(entry.currentValue).toEqual([]);
    expect(entry.isDefault).toBe(true);
  });

  test('a real ConfigManager writes both keys for real (applySettingValue), feeding the SDK exec sandbox directly', () => {
    const groups = new Map<string, ReturnType<typeof buildSandboxEgressAllowlistSyntheticEntry>[]>();
    const egressResult = applySettingValue({
      key: SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY,
      value: ['curl', 'git'],
      configManager: cm,
      groups,
      onSettingApplied: null,
      refreshGroups: () => {},
    });
    expect(egressResult.changed).toBe(true);
    expect(egressResult.effectMessage ?? '').not.toContain('Save failed');
    expect(readSandboxCategory(cm).egressAllowlist).toEqual(['curl', 'git']);

    const writableResult = applySettingValue({
      key: SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY,
      value: ['/tmp/scratch'],
      configManager: cm,
      groups,
      onSettingApplied: null,
      refreshGroups: () => {},
    });
    expect(writableResult.changed).toBe(true);
    expect(readSandboxCategory(cm).workspaceWritable).toEqual(['/tmp/scratch']);

    // getCategory('sandbox') is exactly what registerAllTools reads at
    // tool-registration time — confirm both writes land there too.
    const category = readSandboxCategory(cm);
    expect(category.egressAllowlist).toEqual(['curl', 'git']);
    expect(category.workspaceWritable).toEqual(['/tmp/scratch']);
  });

  test('buildSettingGroups injects both entries into the sandbox category exactly once, alongside the real sandbox.enabled entry', () => {
    const groups = buildSettingGroups(cm);
    const sandboxKeys = (groups.get('sandbox') ?? []).map((e) => e.setting.key);
    expect(sandboxKeys.filter((k) => k === SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY)).toHaveLength(1);
    expect(sandboxKeys.filter((k) => k === SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY)).toHaveLength(1);
    expect(sandboxKeys).toContain('sandbox.enabled');
  });

  test('isSandboxExecListConfigKey is true only for the two sandbox exec-boundary keys', () => {
    expect(isSandboxExecListConfigKey(SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY)).toBe(true);
    expect(isSandboxExecListConfigKey(SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY)).toBe(true);
    expect(isSandboxExecListConfigKey('sandbox.enabled' as never)).toBe(false);
  });

  test('parseSandboxExecListInput splits on comma, trims, and drops empties', () => {
    expect(parseSandboxExecListInput('curl, git ,, ')).toEqual(['curl', 'git']);
    expect(parseSandboxExecListInput('')).toEqual([]);
    expect(parseSandboxExecListInput('/opt/tools, /var/cache')).toEqual(['/opt/tools', '/var/cache']);
  });
});
