import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../config/manager.ts';
import { createHookApi, HookWorkbench, listHookPointContracts } from '../../hooks/index.ts';
import { getTestHookDispatcher } from '../helpers/runtime-services.ts';

describe('HookApi', () => {
  const configManager = new ConfigManager({
    configDir: join(tmpdir(), `gv-hook-api-config-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  });
  let originalHooksFile: string;
  let tempDir: string;
  let hookWorkbench: HookWorkbench;

  beforeEach(() => {
    originalHooksFile = configManager.get('tools.hooksFile') as string;
    tempDir = mkdtempSync(join(tmpdir(), 'gv-hook-api-'));
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

  test('wraps managed hook authoring and contract inspection behind a stable api', async () => {
    const api = createHookApi({
      dispatcher: {
        listHooks: () => getTestHookDispatcher().listHooks(),
        listChains: () => getTestHookDispatcher().getChains(),
      },
      workbench: hookWorkbench,
      listContracts: () => listHookPointContracts(),
    });

    expect(api.contracts('tool').length).toBeGreaterThan(0);

    const hook = await api.workbench.scaffoldHook('guard-edit', 'Pre:tool:*', 'command');
    expect(hook.name).toBe('guard-edit');
    expect(api.dispatcher.listHooks()).toHaveLength(1);

    const simulation = api.workbench.simulate('Pre:tool:edit');
    expect(simulation.matchedHooks).toHaveLength(1);

    const removed = await api.workbench.remove('guard-edit');
    expect(removed).toBe(true);
    expect(api.workbench.listManagedHooks()).toHaveLength(0);
  });
});
