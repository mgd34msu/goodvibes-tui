import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PermissionManager, createPermissionConfigReader } from '@pellux/goodvibes-sdk/platform/permissions';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  DEFAULT_CONFIG,
  type ConfigKey,
  type PermissionAction,
  type PermissionMode,
} from '@pellux/goodvibes-sdk/platform/config';
import type { PermissionPromptRequest, PermissionPromptDecision } from '@pellux/goodvibes-sdk/platform/permissions';
import { PolicyRuntimeState } from '@/runtime/index.ts';

const setPermissionMode = (cm: ConfigManager, mode: PermissionMode): void => {
  cm.set('permissions.mode', mode);
};

const setPermissionTool = (
  cm: ConfigManager,
  key: Extract<ConfigKey, `permissions.tools.${string}`>,
  action: PermissionAction,
): void => {
  cm.setDynamic(key, action);
};

describe('PermissionManager: config-driven modes', () => {
  let manager: PermissionManager;
  let configManager: ConfigManager;
  let tempDir: string;
  let requests: PermissionPromptRequest[];
  let decisions: PermissionPromptDecision[];
  let policyRuntimeState: PolicyRuntimeState;

  const createIsolatedConfigManager = () => new ConfigManager({ surfaceRoot: 'tui',  configDir: tempDir, workingDir: tempDir });

  beforeEach(() => {
    tempDir = join(tmpdir(), `gv-permissions-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    configManager = createIsolatedConfigManager();
    requests = [];
    decisions = [];
    policyRuntimeState = new PolicyRuntimeState();
    manager = new PermissionManager(async (request) => {
      requests.push(request);
      return decisions.shift() ?? { approved: true };
    }, createPermissionConfigReader(configManager), policyRuntimeState);
    configManager.set('behavior.autoApprove', false);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── allow-all mode ──────────────────────────────────────

  describe('allow-all mode', () => {
    test('allow-all mode config key stores and reads back correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionMode(cm, 'allow-all');
      expect(cm.get('permissions.mode')).toBe('allow-all');
    });

    test('allow-all mode auto-approves write tools without prompting', async () => {
      // Set real config state to allow-all
      setPermissionMode(configManager, 'allow-all');

      const result = await manager.check('write', { path: 'test.ts' });
      expect(result).toBe(true);
      expect(requests).toHaveLength(0);
    });

    test('allow-all mode auto-approves exec without prompting', async () => {
      // Set real config state to allow-all
      setPermissionMode(configManager, 'allow-all');

      const result = await manager.check('exec', { command: 'ls' });
      expect(result).toBe(true);
      expect(requests).toHaveLength(0);
    });
  });

  // ── custom mode ─────────────────────────────────────────

  describe('custom mode', () => {
    test('custom mode config key stores allow for write', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.write', 'allow');
      expect(cm.get('permissions.tools.write')).toBe('allow');
    });

    test('custom mode config key stores deny for exec', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.exec', 'deny');
      expect(cm.get('permissions.tools.exec')).toBe('deny');
    });

    test('custom mode respects per-tool allow: auto-approves without prompt', async () => {
      setPermissionMode(configManager, 'custom');
      setPermissionTool(configManager, 'permissions.tools.write', 'allow');

      const result = await manager.check('write', { path: 'test.ts' });
      expect(result).toBe(true);
      expect(requests).toHaveLength(0);
    });

    test('custom mode respects per-tool deny: blocks tool execution', async () => {
      setPermissionMode(configManager, 'custom');
      setPermissionTool(configManager, 'permissions.tools.exec', 'deny');

      const result = await manager.check('exec', { command: 'rm -rf /' });
      expect(result).toBe(false);
      expect(requests).toHaveLength(0);
    });

    test('custom mode unknown tool falls through to prompt (permission:request event)', async () => {
      decisions.push({ approved: true });

      // Set real config state: custom mode
      setPermissionMode(configManager, 'custom');

      const result = await manager.check('unknown_tool', {});
      expect(result).toBe(true);
      expect(requests).toHaveLength(1);
    });
  });

  // ── prompt mode (default) ────────────────────────────────

  describe('prompt mode (default)', () => {
    beforeEach(() => {
      // Reset to default prompt mode
      setPermissionMode(configManager, 'prompt');
    });

    test('auto-approves read category in prompt mode', async () => {
      const result = await manager.check('read', { path: 'README.md' });
      expect(result).toBe(true);
    });

    test('auto-approves grep in prompt mode', async () => {
      const result = await manager.check('find', { pattern: 'foo' });
      expect(result).toBe(true);
    });

    test('auto-approves list_dir in prompt mode', async () => {
      const result = await manager.check('read', { path: '.' });
      expect(result).toBe(true);
    });

    test('auto-approves glob in prompt mode', async () => {
      const result = await manager.check('find', { patterns: ['**/*.ts'] });
      expect(result).toBe(true);
    });

    test('prompts for write in prompt mode', async () => {
      decisions.push({ approved: true });
      const result = await manager.check('write', { path: 'test.ts' });
      expect(result).toBe(true);
      expect(requests).toHaveLength(1);
    });
  });

  // ── deny action blocks execution ────────────────────

  describe('deny action blocks execution', () => {
    test('deny action returns false without prompting (custom mode, exec=deny)', async () => {
      setPermissionMode(configManager, 'custom');
      setPermissionTool(configManager, 'permissions.tools.exec', 'deny');

      const result = await manager.check('exec', { command: 'whoami' });
      expect(result).toBe(false);
      expect(requests).toHaveLength(0);
    });
  });

  // ── config schema ────────────────────────────────────────

  describe('config schema for permissions', () => {
    test('permissions.mode config key is readable/writable (round-trip)', () => {
      // Test in-memory round-trip: set then get on same instance
      const cm = createIsolatedConfigManager();
      const original = cm.get('permissions.mode');
      setPermissionMode(cm, 'custom');
      expect(cm.get('permissions.mode')).toBe('custom');
      // Restore
      setPermissionMode(cm, original);
    });

    test('permissions.tools.write config key is readable/writable (round-trip)', () => {
      const cm = createIsolatedConfigManager();
      const original = cm.get('permissions.tools.write');
      setPermissionTool(cm, 'permissions.tools.write', 'allow');
      expect(cm.get('permissions.tools.write')).toBe('allow');
      setPermissionTool(cm, 'permissions.tools.write', original);
    });

    test('DEFAULT_CONFIG has correct permission defaults for new tool names', () => {
      expect(DEFAULT_CONFIG.permissions.mode).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.read).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.write).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.edit).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.exec).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.find).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.fetch).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.analyze).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.inspect).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.agent).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.state).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.workflow).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.registry).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.delegate).toBe('prompt');
    });
  });

  // ── new tool names config keys ───────────────────────────────────────────

  describe('new tool name config keys', () => {
    test('permissions.tools.read config key stores allow correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.read', 'allow');
      expect(cm.get('permissions.tools.read')).toBe('allow');
    });

    test('permissions.tools.write config key stores deny correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.write', 'deny');
      expect(cm.get('permissions.tools.write')).toBe('deny');
    });

    test('permissions.tools.edit config key stores prompt correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.edit', 'prompt');
      expect(cm.get('permissions.tools.edit')).toBe('prompt');
    });

    test('permissions.tools.exec config key stores allow correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.exec', 'allow');
      expect(cm.get('permissions.tools.exec')).toBe('allow');
    });

    test('permissions.tools.find config key stores allow correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.find', 'allow');
      expect(cm.get('permissions.tools.find')).toBe('allow');
    });

    test('permissions.tools.fetch config key stores deny correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.fetch', 'deny');
      expect(cm.get('permissions.tools.fetch')).toBe('deny');
    });

    test('permissions.tools.analyze config key stores allow correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.analyze', 'allow');
      expect(cm.get('permissions.tools.analyze')).toBe('allow');
    });

    test('permissions.tools.inspect config key stores prompt correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.inspect', 'prompt');
      expect(cm.get('permissions.tools.inspect')).toBe('prompt');
    });

    test('permissions.tools.agent config key stores deny correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.agent', 'deny');
      expect(cm.get('permissions.tools.agent')).toBe('deny');
    });

    test('permissions.tools.state config key stores allow correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.state', 'allow');
      expect(cm.get('permissions.tools.state')).toBe('allow');
    });

    test('permissions.tools.workflow config key stores prompt correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.workflow', 'prompt');
      expect(cm.get('permissions.tools.workflow')).toBe('prompt');
    });

    test('permissions.tools.registry config key stores allow correctly', () => {
      const cm = createIsolatedConfigManager();
      setPermissionTool(cm, 'permissions.tools.registry', 'allow');
      expect(cm.get('permissions.tools.registry')).toBe('allow');
    });

    test('custom mode respects exec=deny: blocks tool execution', async () => {
      setPermissionMode(configManager, 'custom');
      setPermissionTool(configManager, 'permissions.tools.exec', 'deny');

      const result = await manager.check('exec', { command: 'rm -rf /' });
      expect(result).toBe(false);
      expect(requests).toHaveLength(0);
    });

    test('custom mode respects write=allow: auto-approves without prompt', async () => {
      setPermissionMode(configManager, 'custom');
      setPermissionTool(configManager, 'permissions.tools.write', 'allow');

      const result = await manager.check('write', { path: 'out.ts' });
      expect(result).toBe(true);
      expect(requests).toHaveLength(0);
    });

    test('prompt mode auto-approves read tool', async () => {
      setPermissionMode(configManager, 'prompt');
      const result = await manager.check('read', { path: 'src/index.ts' });
      expect(result).toBe(true);
    });

    test('prompt mode auto-approves find tool', async () => {
      setPermissionMode(configManager, 'prompt');
      const result = await manager.check('find', { pattern: 'foo' });
      expect(result).toBe(true);
    });
  });
});
