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
import type { ConfigManager as ConfigManagerType } from '@pellux/goodvibes-sdk/platform/config';
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
    const stub: Pick<ConfigManagerType, 'get'> = { get: () => 'not-an-array' };
    expect(readSandboxExecList(stub, SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY)).toEqual([]);
  });

  test('a real ConfigManager reads the sandbox section without crashing (no defensive guard needed)', () => {
    // 'sandbox' has been a real DEFAULT_CONFIG section since before this repack
    // (it backs the VM/REPL isolation settings), so a plain get() never throws
    // for these leaf keys — unlike worktree.setup.* pre-registration.
    expect(cm.get(SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY)).toEqual([]);
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
    expect(cm.get(SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY)).toEqual(['curl', 'git']);

    const writableResult = applySettingValue({
      key: SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY,
      value: ['/tmp/scratch'],
      configManager: cm,
      groups,
      onSettingApplied: null,
      refreshGroups: () => {},
    });
    expect(writableResult.changed).toBe(true);
    expect(cm.get(SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY)).toEqual(['/tmp/scratch']);

    // getCategory('sandbox') is exactly what registerAllTools reads at
    // tool-registration time — confirm both writes land there too.
    const category = cm.getCategory('sandbox') as { egressAllowlist: string[]; workspaceWritable: string[] };
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
