import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PermissionManager } from '../../permissions/manager.ts';
import { EventBus } from '../../core/event-bus.ts';
import { ConfigManager } from '../../config/manager.ts';
import { configManager } from '../../config/index.ts';

/** Path to the shared global settings file. */
const GLOBAL_SETTINGS_PATH = join(homedir(), '.goodvibes', 'tui', 'settings.json');

/** Snapshot/restore the global settings file to prevent test cross-contamination. */
let globalSettingsSnapshot: string | null = null;

function snapshotGlobalSettings(): void {
  globalSettingsSnapshot = existsSync(GLOBAL_SETTINGS_PATH)
    ? readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8')
    : null;
}

function restoreGlobalSettings(): void {
  if (globalSettingsSnapshot !== null) {
    writeFileSync(GLOBAL_SETTINGS_PATH, globalSettingsSnapshot, 'utf-8');
    // Reload singleton so restored values are live
    configManager.load();
  }
}

describe('PermissionManager — config-driven modes', () => {
  let bus: EventBus;
  let manager: PermissionManager;

  beforeEach(() => {
    bus = new EventBus();
    manager = new PermissionManager(bus);
    snapshotGlobalSettings();
    // Ensure autoApprove is off for all tests that exercise permission logic
    configManager.set('behavior.autoApprove', false);
  });

  afterEach(() => {
    restoreGlobalSettings();
  });

  // ── allow-all mode ──────────────────────────────────────

  describe('allow-all mode', () => {
    test('allow-all mode config key stores and reads back correctly', () => {
      const cm = new ConfigManager();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cm.set('permissions.mode', 'allow-all' as any);
      expect(cm.get('permissions.mode')).toBe('allow-all');
    });

    test('allow-all mode auto-approves write tools without prompting', async () => {
      let eventFired = false;
      bus.on('permission:request', ({ resolve }: { resolve: (v: boolean) => void }) => {
        eventFired = true;
        resolve(true);
      });

      // Set real config state to allow-all
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.mode', 'allow-all' as any);

      const result = await manager.check('file_write', { path: 'test.ts' });
      expect(result).toBe(true);
      expect(eventFired).toBe(false);
    });

    test('allow-all mode auto-approves shell_exec without prompting', async () => {
      let eventFired = false;
      bus.on('permission:request', ({ resolve }: { resolve: (v: boolean) => void }) => {
        eventFired = true;
        resolve(true);
      });

      // Set real config state to allow-all
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.mode', 'allow-all' as any);

      const result = await manager.check('shell_exec', { command: 'ls' });
      expect(result).toBe(true);
      expect(eventFired).toBe(false);
    });
  });

  // ── custom mode ─────────────────────────────────────────

  describe('custom mode', () => {
    test('custom mode config key stores allow for file_write', () => {
      const cm = new ConfigManager();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cm.set('permissions.tools.file_write', 'allow' as any);
      expect(cm.get('permissions.tools.file_write')).toBe('allow');
    });

    test('custom mode config key stores deny for shell_exec', () => {
      const cm = new ConfigManager();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cm.set('permissions.tools.shell_exec', 'deny' as any);
      expect(cm.get('permissions.tools.shell_exec')).toBe('deny');
    });

    test('custom mode respects per-tool allow: auto-approves without prompt', async () => {
      let eventFired = false;
      bus.on('permission:request', ({ resolve }: { resolve: (v: boolean) => void }) => {
        eventFired = true;
        resolve(true);
      });

      // Set real config state: custom mode, file_write=allow
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.mode', 'custom' as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.tools.file_write', 'allow' as any);

      const result = await manager.check('file_write', { path: 'test.ts' });
      expect(result).toBe(true);
      expect(eventFired).toBe(false);
    });

    test('custom mode respects per-tool deny: blocks tool execution', async () => {
      let eventFired = false;
      bus.on('permission:request', ({ resolve }: { resolve: (v: boolean) => void }) => {
        eventFired = true;
        resolve(true);
      });

      // Set real config state: custom mode, shell_exec=deny
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.mode', 'custom' as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.tools.shell_exec', 'deny' as any);

      const result = await manager.check('shell_exec', { command: 'rm -rf /' });
      expect(result).toBe(false);
      expect(eventFired).toBe(false);
    });

    test('custom mode unknown tool falls through to prompt (permission:request event)', async () => {
      let eventFired = false;
      bus.on('permission:request', ({ resolve }: { resolve: (v: boolean) => void }) => {
        eventFired = true;
        resolve(true);
      });

      // Set real config state: custom mode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.mode', 'custom' as any);

      const result = await manager.check('unknown_tool', {});
      expect(result).toBe(true);
      expect(eventFired).toBe(true);
    });
  });

  // ── prompt mode (default) ────────────────────────────────

  describe('prompt mode (default)', () => {
    beforeEach(() => {
      // Reset to default prompt mode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.mode', 'prompt' as any);
    });

    test('auto-approves read category in prompt mode', async () => {
      const result = await manager.check('file_read', { path: 'README.md' });
      expect(result).toBe(true);
    });

    test('auto-approves grep in prompt mode', async () => {
      const result = await manager.check('grep', { pattern: 'foo' });
      expect(result).toBe(true);
    });

    test('auto-approves list_dir in prompt mode', async () => {
      const result = await manager.check('list_dir', { path: '.' });
      expect(result).toBe(true);
    });

    test('auto-approves glob in prompt mode', async () => {
      const result = await manager.check('glob', { patterns: ['**/*.ts'] });
      expect(result).toBe(true);
    });

    test('prompts for file_write in prompt mode (fires permission:request event)', async () => {
      let eventFired = false;
      bus.once('permission:request', ({ resolve }: { resolve: (v: boolean, r?: boolean) => void }) => {
        eventFired = true;
        resolve(true);
      });
      const result = await manager.check('file_write', { path: 'test.ts' });
      expect(result).toBe(true);
      expect(eventFired).toBe(true);
    });
  });

  // ── deny action blocks execution ────────────────────

  describe('deny action blocks execution', () => {
    test('deny action returns false without prompting (custom mode, shell_exec=deny)', async () => {
      let eventFired = false;
      bus.on('permission:request', ({ resolve }: { resolve: (v: boolean) => void }) => {
        eventFired = true;
        resolve(true);
      });

      // Set real config state: custom mode, shell_exec=deny
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.mode', 'custom' as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configManager.set('permissions.tools.shell_exec', 'deny' as any);

      const result = await manager.check('shell_exec', { command: 'whoami' });
      expect(result).toBe(false);
      expect(eventFired).toBe(false);
    });
  });

  // ── config schema ────────────────────────────────────────

  describe('config schema for permissions', () => {
    test('permissions.mode config key is readable/writable (round-trip)', () => {
      // Test in-memory round-trip: set then get on same instance
      const cm = new ConfigManager();
      const original = cm.get('permissions.mode');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cm.set('permissions.mode', 'custom' as any);
      expect(cm.get('permissions.mode')).toBe('custom');
      // Restore
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cm.set('permissions.mode', original as any);
    });

    test('permissions.tools.file_write config key is readable/writable (round-trip)', () => {
      const cm = new ConfigManager();
      const original = cm.get('permissions.tools.file_write');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cm.set('permissions.tools.file_write', 'allow' as any);
      expect(cm.get('permissions.tools.file_write')).toBe('allow');
      // Restore
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cm.set('permissions.tools.file_write', original as any);
    });

    test('DEFAULT_CONFIG has correct permission defaults', () => {
      // Read defaults directly from schema rather than from ConfigManager (avoids disk state)
      const { DEFAULT_CONFIG } = require('../../config/schema.ts');
      expect(DEFAULT_CONFIG.permissions.mode).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.file_read).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.file_write).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.file_edit).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.shell_exec).toBe('prompt');
      expect(DEFAULT_CONFIG.permissions.tools.grep).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.list_dir).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.glob).toBe('allow');
      expect(DEFAULT_CONFIG.permissions.tools.delegate).toBe('prompt');
    });
  });
});
