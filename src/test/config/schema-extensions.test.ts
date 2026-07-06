import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { DEFAULT_CONFIG } from '@pellux/goodvibes-sdk/platform/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-cfg-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createConfigManager(workingDir: string): ConfigManager {
  return new ConfigManager({ surfaceRoot: 'tui',
    workingDir,
    homeDir: workingDir,
    configDir: join(workingDir, '.goodvibes', 'global-tui'),
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Config schema extensions: orchestration, storage, sandbox, danger, and tools categories', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Default values
  // Note: global ~/.goodvibes/tui/settings.json may exist on dev machines and
  // can override some defaults. We verify structure and types, not exact values,
  // except for keys that project config explicitly controls (see 'get/set' tests).
  // -------------------------------------------------------------------------

  describe('defaults: orchestration category', () => {
    test('orchestration category fields have correct types when no project config exists', () => {
      const mgr = createConfigManager(tmpDir);
      expect(typeof mgr.get('orchestration.recursionEnabled')).toBe('boolean');
      expect(typeof mgr.get('orchestration.maxActiveAgents')).toBe('number');
      expect(typeof mgr.get('orchestration.maxDepth')).toBe('number');
    });

    test('daemon + danger category fields have correct types when no project config exists', () => {
      const mgr = createConfigManager(tmpDir);
      // daemon.enabled is the honestly-named key: default true (daemon runs by default).
      // The deprecated danger.daemon alias was removed from the schema in Wave 6
      // (docs/decisions/2026-07-05-daemon-by-default.md) — see config-migrations.test.ts
      // in the SDK for the removal migration's contract.
      expect(typeof mgr.get('daemon.enabled')).toBe('boolean');
      expect(mgr.get('daemon.enabled')).toBe(true);
      expect(typeof mgr.get('danger.httpListener')).toBe('boolean');
    });

    test('storage category fields have correct types when no project config exists', () => {
      const mgr = createConfigManager(tmpDir);
      expect(typeof mgr.get('storage.secretPolicy')).toBe('string');
      expect(typeof mgr.get('storage.artifacts.maxBytes')).toBe('number');
    });

    test('sandbox category fields have correct types when no project config exists', () => {
      const mgr = createConfigManager(tmpDir);
      expect(typeof mgr.get('sandbox.replIsolation')).toBe('string');
      expect(typeof mgr.get('sandbox.mcpIsolation')).toBe('string');
      expect(typeof mgr.get('sandbox.windowsMode')).toBe('string');
      expect(typeof mgr.get('sandbox.vmBackend')).toBe('string');
      expect(typeof mgr.get('sandbox.qemuBinary')).toBe('string');
      expect(typeof mgr.get('sandbox.qemuImagePath')).toBe('string');
      expect(typeof mgr.get('sandbox.qemuExecWrapper')).toBe('string');
      expect(typeof mgr.get('sandbox.qemuGuestHost')).toBe('string');
      expect(typeof mgr.get('sandbox.qemuGuestPort')).toBe('number');
      expect(typeof mgr.get('sandbox.qemuGuestUser')).toBe('string');
      expect(typeof mgr.get('sandbox.qemuWorkspacePath')).toBe('string');
      expect(typeof mgr.get('sandbox.qemuSessionMode')).toBe('string');
      expect(typeof mgr.get('sandbox.replJavaScriptCommand')).toBe('string');
      expect(typeof mgr.get('release.channel')).toBe('string');
    });

    test('DEFAULT_CONFIG.orchestration has correct default values', () => {
      expect(DEFAULT_CONFIG.orchestration.recursionEnabled).toBe(false);
      expect(DEFAULT_CONFIG.orchestration.maxActiveAgents).toBe(8);
      expect(DEFAULT_CONFIG.orchestration.maxDepth).toBe(0);
    });

    test('DEFAULT_CONFIG.daemon/danger have correct default values', () => {
      // Daemon on by default via the honest key. The deprecated danger.daemon
      // alias was removed from the schema in Wave 6.
      expect(DEFAULT_CONFIG.daemon.enabled).toBe(true);
      expect(DEFAULT_CONFIG.danger.httpListener).toBe(false);
    });

    test('DEFAULT_CONFIG.storage has correct default values', () => {
      expect(DEFAULT_CONFIG.storage.secretPolicy).toBe('preferred_secure');
      expect(DEFAULT_CONFIG.storage.artifacts.maxBytes).toBe(512 * 1024 * 1024);
    });

    test('DEFAULT_CONFIG.sandbox has correct default values', () => {
      expect(DEFAULT_CONFIG.sandbox.replIsolation).toBe('shared-vm');
      expect(DEFAULT_CONFIG.sandbox.mcpIsolation).toBe('disabled');
      expect(DEFAULT_CONFIG.sandbox.windowsMode).toBe('native-basic');
      expect(DEFAULT_CONFIG.sandbox.vmBackend).toBe('local');
      expect(DEFAULT_CONFIG.sandbox.qemuBinary).toBe('qemu-system-x86_64');
      expect(DEFAULT_CONFIG.sandbox.qemuImagePath).toBe('');
      expect(DEFAULT_CONFIG.sandbox.qemuExecWrapper).toBe('');
      expect(DEFAULT_CONFIG.sandbox.qemuGuestHost).toBe('');
      expect(DEFAULT_CONFIG.sandbox.qemuGuestPort).toBe(2222);
      expect(DEFAULT_CONFIG.sandbox.qemuGuestUser).toBe('goodvibes');
      expect(DEFAULT_CONFIG.sandbox.qemuWorkspacePath).toBe('/workspace');
      expect(DEFAULT_CONFIG.sandbox.qemuSessionMode).toBe('attach');
      expect(DEFAULT_CONFIG.sandbox.replJavaScriptCommand).toBe('bun');
      expect(DEFAULT_CONFIG.release.channel).toBe('stable');
    });

    test('project config overrides win for orchestration fields', () => {
      const projectSettingsDir = join(tmpDir, '.goodvibes', 'tui');
      mkdirSync(projectSettingsDir, { recursive: true });
      writeFileSync(
        join(projectSettingsDir, 'settings.json'),
        JSON.stringify({ orchestration: { maxActiveAgents: 4 } }, null, 2),
        'utf-8'
      );
      const mgr = createConfigManager(tmpDir);
      expect(mgr.get('orchestration.maxActiveAgents')).toBe(4);
    });
  });

  describe('defaults: tools category', () => {
    test('tools category fields have correct types when no project config exists', () => {
      const mgr = createConfigManager(tmpDir);
      expect(typeof mgr.get('tools.llmProvider')).toBe('string');
      expect(typeof mgr.get('tools.llmModel')).toBe('string');
      expect(typeof mgr.get('tools.autoHeal')).toBe('boolean');
      expect(typeof mgr.get('tools.defaultTokenBudget')).toBe('number');
      expect(typeof mgr.get('tools.hooksFile')).toBe('string');
    });

    test('DEFAULT_CONFIG.tools has correct default values', () => {
      expect(DEFAULT_CONFIG.tools.llmProvider).toBe('');
      expect(DEFAULT_CONFIG.tools.llmModel).toBe('');
      expect(DEFAULT_CONFIG.tools.autoHeal).toBe(false);
      expect(DEFAULT_CONFIG.tools.defaultTokenBudget).toBe(5000);
      expect(DEFAULT_CONFIG.tools.hooksFile).toBe('hooks.json');
    });

    test('project config overrides win for tools fields', () => {
      const projectSettingsDir = join(tmpDir, '.goodvibes', 'tui');
      mkdirSync(projectSettingsDir, { recursive: true });
      writeFileSync(
        join(projectSettingsDir, 'settings.json'),
        JSON.stringify({ tools: { defaultTokenBudget: 3000 } }, null, 2),
        'utf-8'
      );
      const mgr = createConfigManager(tmpDir);
      expect(mgr.get('tools.defaultTokenBudget')).toBe(3000);
    });
  });

  // -------------------------------------------------------------------------
  // get / set round-trips
  // -------------------------------------------------------------------------

  describe('get/set: orchestration category', () => {
    test('set and get orchestration.recursionEnabled', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('orchestration.recursionEnabled', true);
      expect(mgr.get('orchestration.recursionEnabled')).toBe(true);
    });

    test('set and get orchestration.maxActiveAgents with valid value', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('orchestration.maxActiveAgents', 12);
      expect(mgr.get('orchestration.maxActiveAgents')).toBe(12);
    });

    test('set and get orchestration.maxDepth to 1', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('orchestration.maxDepth', 1);
      expect(mgr.get('orchestration.maxDepth')).toBe(1);
    });

    test('set and get orchestration.maxDepth to 3', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('orchestration.maxDepth', 3);
      expect(mgr.get('orchestration.maxDepth')).toBe(3);
    });

    test('set and get orchestration.maxDepth back to 0', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('orchestration.maxDepth', 1);
      mgr.set('orchestration.maxDepth', 0);
      expect(mgr.get('orchestration.maxDepth')).toBe(0);
    });

    test('set and get daemon.enabled', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('daemon.enabled', false);
      expect(mgr.get('daemon.enabled')).toBe(false);
    });

    test('set and get danger.httpListener', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('danger.httpListener', true);
      expect(mgr.get('danger.httpListener')).toBe(true);
    });

    test('set and get storage.secretPolicy', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('storage.secretPolicy', 'require_secure');
      expect(mgr.get('storage.secretPolicy')).toBe('require_secure');
    });

    test('set and get sandbox.replIsolation', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.replIsolation', 'shared-vm');
      expect(mgr.get('sandbox.replIsolation')).toBe('shared-vm');
    });

    test('set and get sandbox.mcpIsolation', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.mcpIsolation', 'per-server-vm');
      expect(mgr.get('sandbox.mcpIsolation')).toBe('per-server-vm');
    });

    test('set and get sandbox.windowsMode', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.windowsMode', 'native-basic');
      expect(mgr.get('sandbox.windowsMode')).toBe('native-basic');
    });

    test('set and get sandbox.vmBackend', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.vmBackend', 'qemu');
      expect(mgr.get('sandbox.vmBackend')).toBe('qemu');
    });

    test('set and get sandbox.qemuBinary', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.qemuBinary', 'qemu-system-aarch64');
      expect(mgr.get('sandbox.qemuBinary')).toBe('qemu-system-aarch64');
    });

    test('set and get sandbox.qemuImagePath', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.qemuImagePath', '/tmp/gv-sandbox.qcow2');
      expect(mgr.get('sandbox.qemuImagePath')).toBe('/tmp/gv-sandbox.qcow2');
    });

    test('set and get sandbox.qemuExecWrapper', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.qemuExecWrapper', '/tmp/gv-qemu-wrapper');
      expect(mgr.get('sandbox.qemuExecWrapper')).toBe('/tmp/gv-qemu-wrapper');
    });

    test('set and get sandbox.qemuGuestHost', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.qemuGuestHost', '127.0.0.1');
      expect(mgr.get('sandbox.qemuGuestHost')).toBe('127.0.0.1');
    });

    test('set and get sandbox.qemuGuestPort', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.qemuGuestPort', 2222);
      expect(mgr.get('sandbox.qemuGuestPort')).toBe(2222);
    });

    test('set and get sandbox.qemuGuestUser', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.qemuGuestUser', 'goodvibes');
      expect(mgr.get('sandbox.qemuGuestUser')).toBe('goodvibes');
    });

    test('set and get sandbox.qemuWorkspacePath', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.qemuWorkspacePath', '/workspace');
      expect(mgr.get('sandbox.qemuWorkspacePath')).toBe('/workspace');
    });

    test('set and get sandbox.qemuSessionMode', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.qemuSessionMode', 'launch-per-command');
      expect(mgr.get('sandbox.qemuSessionMode')).toBe('launch-per-command');
    });

    test('set and get sandbox.replJavaScriptCommand', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('sandbox.replJavaScriptCommand', '/home/goodvibes/.bun/bin/bun');
      expect(mgr.get('sandbox.replJavaScriptCommand')).toBe('/home/goodvibes/.bun/bin/bun');
    });

    test('set and get release.channel', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('release.channel', 'preview');
      expect(mgr.get('release.channel')).toBe('preview');
    });
  });

  describe('get/set: tools category', () => {
    test('set and get tools.llmProvider', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('tools.llmProvider', 'anthropic');
      expect(mgr.get('tools.llmProvider')).toBe('anthropic');
    });

    test('set and get tools.llmModel', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('tools.llmModel', 'claude-sonnet-4-6');
      expect(mgr.get('tools.llmModel')).toBe('claude-sonnet-4-6');
    });

    test('set and get tools.autoHeal', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('tools.autoHeal', true);
      expect(mgr.get('tools.autoHeal')).toBe(true);
    });

    test('set and get tools.defaultTokenBudget with valid value', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('tools.defaultTokenBudget', 8000);
      expect(mgr.get('tools.defaultTokenBudget')).toBe(8000);
    });

    test('set and get tools.hooksFile', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('tools.hooksFile', 'custom-hooks.json');
      expect(mgr.get('tools.hooksFile')).toBe('custom-hooks.json');
    });
  });

  // -------------------------------------------------------------------------
  // Validation: invalid values must throw
  // -------------------------------------------------------------------------

  describe('validation: orchestration category', () => {
    test('orchestration.maxDepth accepts value 2', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('orchestration.maxDepth', 2);
      expect(mgr.get('orchestration.maxDepth')).toBe(2);
    });

    test('orchestration.maxDepth rejects negative value', () => {
      const mgr = createConfigManager(tmpDir);
      expect(() => mgr.set('orchestration.maxDepth', -1 as never)).toThrow();
    });

    test('orchestration.maxDepth rejects value 6', () => {
      const mgr = createConfigManager(tmpDir);
      expect(() => mgr.set('orchestration.maxDepth', 6 as never)).toThrow();
    });

    test('orchestration.maxActiveAgents rejects 0 (below minimum)', () => {
      const mgr = createConfigManager(tmpDir);
      expect(() => mgr.set('orchestration.maxActiveAgents', 0 as never)).toThrow();
    });

    test('orchestration.maxActiveAgents rejects 21 (above maximum)', () => {
      const mgr = createConfigManager(tmpDir);
      expect(() => mgr.set('orchestration.maxActiveAgents', 21 as never)).toThrow();
    });

    test('orchestration.maxActiveAgents accepts boundary value 1', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('orchestration.maxActiveAgents', 1);
      expect(mgr.get('orchestration.maxActiveAgents')).toBe(1);
    });

    test('orchestration.maxActiveAgents accepts boundary value 20', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('orchestration.maxActiveAgents', 20);
      expect(mgr.get('orchestration.maxActiveAgents')).toBe(20);
    });
  });

  describe('validation: tools category', () => {
    test('tools.defaultTokenBudget rejects value below 100', () => {
      const mgr = createConfigManager(tmpDir);
      expect(() => mgr.set('tools.defaultTokenBudget', 99 as never)).toThrow();
    });

    test('tools.defaultTokenBudget rejects value above 100000', () => {
      const mgr = createConfigManager(tmpDir);
      expect(() => mgr.set('tools.defaultTokenBudget', 100001 as never)).toThrow();
    });

    test('tools.defaultTokenBudget accepts boundary value 100', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('tools.defaultTokenBudget', 100);
      expect(mgr.get('tools.defaultTokenBudget')).toBe(100);
    });

    test('tools.defaultTokenBudget accepts boundary value 100000', () => {
      const mgr = createConfigManager(tmpDir);
      mgr.set('tools.defaultTokenBudget', 100000);
      expect(mgr.get('tools.defaultTokenBudget')).toBe(100000);
    });
  });

  // -------------------------------------------------------------------------
  // getAll() includes new categories
  // -------------------------------------------------------------------------

  describe('getAll includes new categories', () => {
    test('getAll returns orchestration and danger categories with correct field types', () => {
      const mgr = createConfigManager(tmpDir);
      const all = mgr.getAll();
      expect(typeof all.orchestration.recursionEnabled).toBe('boolean');
      expect(typeof all.orchestration.maxActiveAgents).toBe('number');
      expect(typeof all.orchestration.maxDepth).toBe('number');
      expect(typeof all.daemon.enabled).toBe('boolean');
      expect(typeof all.danger.httpListener).toBe('boolean');
    });

    test('getAll returns tools category with correct field types', () => {
      const mgr = createConfigManager(tmpDir);
      const all = mgr.getAll();
      expect(typeof all.tools.llmProvider).toBe('string');
      expect(typeof all.tools.llmModel).toBe('string');
      expect(typeof all.tools.autoHeal).toBe('boolean');
      expect(typeof all.tools.defaultTokenBudget).toBe('number');
      expect(typeof all.tools.hooksFile).toBe('string');
    });

    test('getAll snapshot does not reflect subsequent mutations (deep clone)', () => {
      const mgr = createConfigManager(tmpDir);
      const valueBefore = mgr.get('orchestration.maxActiveAgents');
      const snapshot = mgr.getAll();
      // Set to a value that differs from whatever was loaded (pick 1 if current is > 1, else pick 2)
      const newValue = valueBefore !== 1 ? 1 : 2;
      mgr.set('orchestration.maxActiveAgents', newValue);
      // Snapshot must not reflect the mutation
      expect(snapshot.orchestration.maxActiveAgents).toBe(valueBefore);
      expect(mgr.get('orchestration.maxActiveAgents')).toBe(newValue);
    });
  });

  // -------------------------------------------------------------------------
  // DEFAULT_CONFIG shape
  // -------------------------------------------------------------------------

  describe('DEFAULT_CONFIG shape', () => {
    test('DEFAULT_CONFIG.orchestration, daemon, and danger have all required keys', () => {
      expect(DEFAULT_CONFIG.orchestration).toBeDefined();
      expect(typeof DEFAULT_CONFIG.orchestration.recursionEnabled).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.orchestration.maxActiveAgents).toBe('number');
      expect(typeof DEFAULT_CONFIG.orchestration.maxDepth).toBe('number');
      // daemon.enabled is the honest key (default true). The deprecated
      // danger.daemon alias was removed from the schema in Wave 6.
      expect(DEFAULT_CONFIG.daemon).toBeDefined();
      expect(DEFAULT_CONFIG.daemon.enabled).toBe(true);
      expect(DEFAULT_CONFIG.danger).toBeDefined();
      expect(typeof DEFAULT_CONFIG.danger.httpListener).toBe('boolean');
    });

    test('DEFAULT_CONFIG.tools has all required keys', () => {
      expect(DEFAULT_CONFIG.tools).toBeDefined();
      expect(typeof DEFAULT_CONFIG.tools.llmProvider).toBe('string');
      expect(typeof DEFAULT_CONFIG.tools.llmModel).toBe('string');
      expect(typeof DEFAULT_CONFIG.tools.autoHeal).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.tools.defaultTokenBudget).toBe('number');
      expect(typeof DEFAULT_CONFIG.tools.hooksFile).toBe('string');
    });

    test('DEFAULT_CONFIG is not mutated by ConfigManager instantiation', () => {
      const before = JSON.stringify(DEFAULT_CONFIG);
      createConfigManager(tmpDir);
      expect(JSON.stringify(DEFAULT_CONFIG)).toBe(before);
    });
  });
});
