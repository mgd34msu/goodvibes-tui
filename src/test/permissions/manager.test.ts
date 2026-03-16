import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PermissionManager } from '../../permissions/manager.ts';
import { EventBus } from '../../core/event-bus.ts';
import { config, configManager } from '../../config/index.ts';

// config.autoApprove reflects the --no-worries-just-vibes flag.
// In the test environment (no CLI flag), it is false.
// Tests are written for the autoApprove=false path.
// If the flag is somehow set, the suite notes it so the reader understands.

describe('PermissionManager', () => {
  let bus: EventBus;
  let manager: PermissionManager;
  let savedMode: string;
  let savedAutoApprove: boolean;

  beforeEach(() => {
    // Snapshot current config state
    savedMode = config.permissions?.mode ?? 'prompt';
    savedAutoApprove = config.autoApprove ?? false;
    // Isolate: reset to default permission state so tests are deterministic
    configManager.set('permissions.mode', 'prompt');
    configManager.set('behavior.autoApprove', false);
    bus = new EventBus();
    manager = new PermissionManager(bus);
  });

  afterEach(() => {
    // Restore config state after each test
    configManager.set('permissions.mode', savedMode as 'prompt' | 'allow-all' | 'custom');
    configManager.set('behavior.autoApprove', savedAutoApprove);
  });

  describe('getCategory', () => {
    // New tool names
    test('read is read category', () => {
      expect(manager.getCategory('read')).toBe('read');
    });

    test('find is read category', () => {
      expect(manager.getCategory('find')).toBe('read');
    });

    test('fetch is read category', () => {
      expect(manager.getCategory('fetch')).toBe('read');
    });

    test('analyze is read category', () => {
      expect(manager.getCategory('analyze')).toBe('read');
    });

    test('inspect is read category', () => {
      expect(manager.getCategory('inspect')).toBe('read');
    });

    test('state is read category', () => {
      expect(manager.getCategory('state')).toBe('read');
    });

    test('registry is read category', () => {
      expect(manager.getCategory('registry')).toBe('read');
    });

    test('write is write category', () => {
      expect(manager.getCategory('write')).toBe('write');
    });

    test('edit is write category', () => {
      expect(manager.getCategory('edit')).toBe('write');
    });

    test('exec is execute category', () => {
      expect(manager.getCategory('exec')).toBe('execute');
    });

    test('agent is delegate category', () => {
      expect(manager.getCategory('agent')).toBe('delegate');
    });

    test('delegate is delegate category', () => {
      expect(manager.getCategory('delegate')).toBe('delegate');
    });

    test('workflow is delegate category', () => {
      expect(manager.getCategory('workflow')).toBe('delegate');
    });

    // Legacy tool names (backward compat)
    test('file_read is read category', () => {
      expect(manager.getCategory('file_read')).toBe('read');
    });

    test('grep is read category', () => {
      expect(manager.getCategory('grep')).toBe('read');
    });

    test('list_dir is read category', () => {
      expect(manager.getCategory('list_dir')).toBe('read');
    });

    test('glob (glob tool) is read category', () => {
      expect(manager.getCategory('glob')).toBe('read');
    });

    test('file_write is write category', () => {
      expect(manager.getCategory('file_write')).toBe('write');
    });

    test('file_edit is write category', () => {
      expect(manager.getCategory('file_edit')).toBe('write');
    });

    test('shell_exec is execute category', () => {
      expect(manager.getCategory('shell_exec')).toBe('execute');
    });

    test('unknown tool defaults to delegate category', () => {
      expect(manager.getCategory('unknown_tool')).toBe('delegate');
    });

    test('custom_action defaults to delegate category', () => {
      expect(manager.getCategory('custom_action')).toBe('delegate');
    });
  });

  describe('check - read category auto-approval', () => {
    // New tool names
    test('auto-approves read tool', async () => {
      const result = await manager.check('read', { path: 'README.md' });
      expect(result).toBe(true);
    });

    test('auto-approves find tool', async () => {
      const result = await manager.check('find', { pattern: 'foo' });
      expect(result).toBe(true);
    });

    test('auto-approves fetch tool', async () => {
      const result = await manager.check('fetch', { url: 'https://example.com' });
      expect(result).toBe(true);
    });

    test('auto-approves analyze tool', async () => {
      const result = await manager.check('analyze', { path: '.' });
      expect(result).toBe(true);
    });

    test('auto-approves inspect tool', async () => {
      const result = await manager.check('inspect', { path: 'src/' });
      expect(result).toBe(true);
    });

    test('auto-approves state tool', async () => {
      const result = await manager.check('state', { key: 'session' });
      expect(result).toBe(true);
    });

    test('auto-approves registry tool', async () => {
      const result = await manager.check('registry', { query: 'tools' });
      expect(result).toBe(true);
    });

    // Legacy tool names (backward compat)
    test('auto-approves read category tools regardless of autoApprove flag', async () => {
      // Read operations are always auto-approved before the autoApprove check.
      const result = await manager.check('file_read', { path: 'README.md' });
      expect(result).toBe(true);
    });

    test('auto-approves grep without prompting', async () => {
      const result = await manager.check('grep', { pattern: 'foo' });
      expect(result).toBe(true);
    });

    test('auto-approves list_dir', async () => {
      const result = await manager.check('list_dir', { path: '.' });
      expect(result).toBe(true);
    });

    test('auto-approves glob tool', async () => {
      const result = await manager.check('glob', { patterns: ['**/*.ts'] });
      expect(result).toBe(true);
    });
  });

  describe('check - permission prompt for non-read tools (autoApprove=false)', () => {
    test('emits permission:request event for write category when autoApprove=false', async () => {
      if (config.autoApprove) {
        // Skip assertion path — flag is set, no event fires
        const result = await manager.check('file_write', { path: 'file.txt' });
        expect(result).toBe(true);
        return;
      }

      expect.assertions(2);
      let eventFired = false;

      bus.once('permission:request', ({ resolve }) => {
        eventFired = true;
        resolve(true);
      });

      const result = await manager.check('file_write', { path: 'file.txt' });
      expect(eventFired).toBe(true);
      expect(result).toBe(true);
    });

    test('resolving with false denies the operation', async () => {
      if (config.autoApprove) {
        const result = await manager.check('shell_exec', { command: 'echo hi' });
        expect(result).toBe(true);
        return;
      }

      expect.assertions(1);

      bus.once('permission:request', ({ resolve }) => {
        resolve(false);
      });

      const result = await manager.check('shell_exec', { command: 'echo hi' });
      expect(result).toBe(false);
    });

    test('permission:request event includes tool name and category', async () => {
      if (config.autoApprove) {
        await manager.check('file_write', { path: 'test.ts' });
        return;
      }

      expect.assertions(2);
      let capturedEvent: { tool: string; category: string; resolve: (v: boolean) => void } | null = null;

      bus.once('permission:request', (evt) => {
        capturedEvent = evt as typeof capturedEvent;
        evt.resolve(true);
      });

      await manager.check('file_write', { path: 'test.ts' });
      expect(capturedEvent!.tool).toBe('file_write');
      expect(capturedEvent!.category).toBe('write');
    });
  });

  describe('check - prompt-flow for non-read tools in default prompt mode', () => {
    test('write tool triggers permission prompt', async () => {
      expect.assertions(2);
      let eventFired = false;

      bus.once('permission:request', ({ resolve }) => {
        eventFired = true;
        resolve(true);
      });

      const result = await manager.check('write', { path: 'output.ts' });
      expect(eventFired).toBe(true);
      expect(result).toBe(true);
    });

    test('exec tool triggers permission prompt', async () => {
      expect.assertions(2);
      let eventFired = false;

      bus.once('permission:request', ({ resolve }) => {
        eventFired = true;
        resolve(true);
      });

      const result = await manager.check('exec', { command: 'npm run build' });
      expect(eventFired).toBe(true);
      expect(result).toBe(true);
    });

    test('agent tool triggers permission prompt', async () => {
      expect.assertions(2);
      let eventFired = false;

      bus.once('permission:request', ({ resolve }) => {
        eventFired = true;
        resolve(true);
      });

      const result = await manager.check('agent', { task: 'do something' });
      expect(eventFired).toBe(true);
      expect(result).toBe(true);
    });

    test('workflow tool triggers permission prompt', async () => {
      expect.assertions(2);
      let eventFired = false;

      bus.once('permission:request', ({ resolve }) => {
        eventFired = true;
        resolve(true);
      });

      const result = await manager.check('workflow', { name: 'deploy' });
      expect(eventFired).toBe(true);
      expect(result).toBe(true);
    });
  });

  describe('session approval cache', () => {
    test('caches approval when remember=true — only 1 prompt for 2 identical calls', async () => {
      if (config.autoApprove) {
        // autoApprove skips prompts; cache logic isn't exercised
        await manager.check('file_write', { path: 'cached.ts' });
        await manager.check('file_write', { path: 'cached.ts' });
        return;
      }

      expect.assertions(1);
      let promptCount = 0;

      bus.on('permission:request', ({ resolve }) => {
        promptCount++;
        resolve(true, true); // approve and remember
      });

      await manager.check('file_write', { path: 'cached.ts' });
      await manager.check('file_write', { path: 'cached.ts' });

      // Second call should hit the cache, not fire a new event
      expect(promptCount).toBe(1);
    });

    test('different paths get separate cache entries — up to 2 prompts', async () => {
      if (config.autoApprove) {
        await manager.check('file_write', { path: 'file-a.ts' });
        await manager.check('file_write', { path: 'file-b.ts' });
        return;
      }

      expect.assertions(1);
      let promptCount = 0;

      bus.on('permission:request', ({ resolve }) => {
        promptCount++;
        resolve(true, true);
      });

      await manager.check('file_write', { path: 'file-a.ts' });
      await manager.check('file_write', { path: 'file-b.ts' });

      expect(promptCount).toBe(2);
    });

    test('cached denial is returned without prompting again', async () => {
      if (config.autoApprove) {
        // autoApprove=true means the denial path can't be reached
        return;
      }

      expect.assertions(3);
      let promptCount = 0;

      bus.on('permission:request', ({ resolve }) => {
        promptCount++;
        resolve(false, true); // deny and remember
      });

      const first = await manager.check('file_edit', { path: 'denied.ts' });
      const second = await manager.check('file_edit', { path: 'denied.ts' });

      expect(first).toBe(false);
      expect(second).toBe(false);
      expect(promptCount).toBe(1);
    });
  });
});
