import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { configManager } from '../../config/index.ts';
import { _resetHookWorkbenchForTesting, getHookDispatcher } from '../../hooks/index.ts';

describe('hooks command', () => {
  let originalHooksFile: string;
  let tempDir: string;

  beforeEach(() => {
    originalHooksFile = configManager.get('tools.hooksFile') as string;
    tempDir = mkdtempSync(join(tmpdir(), 'gv-hooks-command-'));
    configManager.set('tools.hooksFile', join(tempDir, 'hooks.json'));
    _resetHookWorkbenchForTesting();
    getHookDispatcher().clear();
  });

  afterEach(() => {
    configManager.set('tools.hooksFile', originalHooksFile);
    _resetHookWorkbenchForTesting();
    getHookDispatcher().clear();
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
    };

    await hooks!.handler(['scaffold', 'guard-edit', 'Pre:tool:*', 'command'], ctx);
    expect(existsSync(configManager.get('tools.hooksFile') as string)).toBe(true);
    expect(out.join('\n')).toContain('Scaffolded managed hook');
    expect(getHookDispatcher().listHooks().length).toBe(1);

    out.length = 0;
    await hooks!.handler(['simulate', 'Pre:tool:edit'], ctx);
    expect(out.join('\n')).toContain('matched hooks: 1');
  });
});
