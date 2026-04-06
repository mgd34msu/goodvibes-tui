import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import {
  _resetRemoteRunnerRegistryForTesting,
  exportRemoteArtifactForAgent,
  importRemoteArtifact,
} from '../../runtime/remote/index.ts';
import { configManager } from '../../config/index.ts';
import { _resetHookWorkbenchForTesting, getHookDispatcher, getHookWorkbench } from '../../hooks/index.ts';

describe('remote and hooks authoring gate', () => {
  let originalHooksFile: string;

  beforeEach(() => {
    AgentManager.resetInstance();
    _resetRemoteRunnerRegistryForTesting();
    originalHooksFile = configManager.get('tools.hooksFile') as string;
    _resetHookWorkbenchForTesting();
    getHookDispatcher().clear();
  });

  afterEach(() => {
    AgentManager.getInstance().clear();
    configManager.set('tools.hooksFile', originalHooksFile);
    _resetHookWorkbenchForTesting();
    getHookDispatcher().clear();
  });

  test('remote runner execution can be exported into a portable review artifact', async () => {
    const manager = AgentManager.getInstance();
    const agent = manager.spawn({
      mode: 'spawn',
      task: 'Produce portable remote evidence',
      template: 'engineer',
      tools: ['read', 'edit'],
      dangerously_disable_wrfc: true,
    });
    agent.status = 'completed';
    agent.fullOutput = 'Portable remote evidence is available for review.';
    agent.completedAt = Date.now();

    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: [agent.id],
        connections: new Map([
          [agent.id, {
            agentId: agent.id,
            label: 'remote certifier',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 5,
            errorCount: 0,
            taskId: 'task-remote-gate',
          }],
        ]),
      },
    }));

    const dir = mkdtempSync(join(tmpdir(), 'gv-remote-gate-'));
    const path = join(dir, 'remote-artifact.json');
    const exported = await exportRemoteArtifactForAgent(agent.id, store, path);

    expect(exported).not.toBeNull();
    expect(existsSync(path)).toBe(true);

    const imported = await importRemoteArtifact(path);
    expect(imported.runnerContract.trustClass).toBe('self-hosted-acp');
    expect(imported.task.summary).toContain('Portable remote evidence');
  });

  test('managed hooks can be scaffolded, reloaded, and simulated through the persisted workflow path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-hooks-gate-'));
    const path = join(dir, 'hooks.json');
    configManager.set('tools.hooksFile', path);

    const workbench = getHookWorkbench();
    workbench.loadManagedConfig(path);
    workbench.scaffoldHook('remote-guard', 'Pre:tool:edit', 'command');
    workbench.scaffoldChain('edit-review', ['Post:tool:edit', 'Fail:tool:edit']);
    await workbench.saveManagedConfig(path);
    await workbench.loadAndApplyManagedHooks(path);

    expect(getHookDispatcher().listHooks().length).toBeGreaterThan(0);
    expect(getHookDispatcher().getChains().length).toBeGreaterThan(0);

    const simulation = workbench.simulate('Pre:tool:edit');
    expect(simulation.matchedHooks[0]?.name).toBe('remote-guard');
    expect(simulation.matchedChains.length).toBe(0);
  });
});
