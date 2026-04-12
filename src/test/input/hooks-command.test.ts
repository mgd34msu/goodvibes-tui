import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { ConfigManager } from '../../config/manager.ts';
import { HookWorkbench } from '../../hooks/workbench.ts';
import {
  getTestHookDispatcher,
} from '../helpers/runtime-services.ts';

const configManager = new ConfigManager({
  configDir: join(tmpdir(), `gv-hooks-config-${Date.now()}-${Math.random().toString(36).slice(2)}`),
});

describe('hooks command', () => {
  let originalHooksFile: string;
  let tempDir: string;
  let hookWorkbench: HookWorkbench;

  beforeEach(() => {
    originalHooksFile = configManager.get('tools.hooksFile') as string;
    tempDir = mkdtempSync(join(tmpdir(), 'gv-hooks-command-'));
    configManager.set('tools.hooksFile', join(tempDir, 'hooks.json'));
    getTestHookDispatcher().clear();
    hookWorkbench = new HookWorkbench(
      getTestHookDispatcher(),
      () => configManager.get('tools.hooksFile') as string,
    );
  });

  afterEach(() => {
    configManager.set('tools.hooksFile', originalHooksFile);
    getTestHookDispatcher().clear();
  });

  test('scaffolds and simulates managed hooks through the command surface', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const hooks = registry.get('hooks');
    expect(hooks).toBeDefined();

    const out: string[] = [];
    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-hooks-command',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      hookWorkbench,
    };

    await hooks!.handler(['scaffold', 'guard-edit', 'Pre:tool:*', 'command'], ctx);
    expect(existsSync(configManager.get('tools.hooksFile') as string)).toBe(true);
    expect(out.join('\n')).toContain('Scaffolded managed hook');
    expect(getTestHookDispatcher().listHooks().length).toBe(1);

    out.length = 0;
    await hooks!.handler(['simulate', 'Pre:tool:edit'], ctx);
    expect(out.join('\n')).toContain('matched hooks: 1');
  });

  test('inspects and imports managed hook bundles', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const hooks = registry.get('hooks');
    expect(hooks).toBeDefined();

    const bundlePath = join(tempDir, 'incoming-hooks.json');
    writeFileSync(bundlePath, JSON.stringify({
      hooks: {
        'Post:tool:*': [{
          name: 'after-tool',
          match: 'Post:tool:*',
          type: 'command',
          command: 'echo after',
          enabled: true,
        }],
      },
      chains: [{
        name: 'review-loop',
        steps: [{ match: 'Post:tool:edit' }],
        action: {
          name: 'review-loop-action',
          match: 'Post:tool:edit',
          type: 'command',
          command: 'echo review',
        },
      }],
    }, null, 2));

    const out: string[] = [];
    const ctx = {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-hooks-import',
      },
      renderRequest: () => {},
      print: (text: string) => { out.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      hookWorkbench,
    };

    await hooks!.handler(['inspect', bundlePath], ctx);
    expect(out.join('\n')).toContain('Hook bundle inspection');
    expect(out.join('\n')).toContain('hooks: 1');

    out.length = 0;
    await hooks!.handler(['import', bundlePath, 'replace'], ctx);
    expect(out.join('\n')).toContain('Imported managed hooks');
    expect(readFileSync(configManager.get('tools.hooksFile') as string, 'utf-8')).toContain('after-tool');
  });
});
