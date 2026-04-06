import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetHookWorkbenchForTesting, getHookWorkbench, getHookDispatcher } from '../../hooks/index.ts';

describe('HookWorkbench', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-hook-workbench-'));
    _resetHookWorkbenchForTesting();
    getHookDispatcher().clear();
  });

  afterEach(() => {
    getHookDispatcher().clear();
  });

  test('scaffolds managed hooks and chains, saves them, and simulates matches', async () => {
    const filePath = join(dir, 'hooks.json');
    const workbench = getHookWorkbench();
    workbench.loadManagedConfig(filePath);
    workbench.scaffoldHook('guard-edit', 'Pre:tool:*', 'command');
    workbench.scaffoldChain('edit-review-loop', ['Post:tool:edit', 'Fail:tool:edit']);
    await workbench.saveManagedConfig(filePath);
    await workbench.loadAndApplyManagedHooks(filePath);

    expect(getHookDispatcher().listHooks().length).toBe(1);
    expect(getHookDispatcher().getChains().length).toBe(1);

    const simulation = workbench.simulate('Pre:tool:edit');
    expect(simulation.matchedHooks.length).toBe(1);
    expect(simulation.matchedHooks[0]?.name).toBe('guard-edit');
    expect(workbench.listRecentActions(2)[0]?.kind).toBe('simulate');
  });
});
