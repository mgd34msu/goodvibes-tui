import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStore } from '../../../runtime/store/index.ts';
import { getTestAgentManager, resetTestRuntimeServices } from '../../helpers/runtime-services.ts';
import { RemoteRunnerRegistry } from '@/runtime/index.ts';
import {
  exportRemoteArtifactForAgent,
  importRemoteArtifact,
} from '@/runtime/index.ts';

describe('RemoteRunnerRegistry', () => {
  beforeEach(() => {
    resetTestRuntimeServices();
  });

  afterEach(() => {
    getTestAgentManager().clear();
  });

  test('builds runner contracts from active ACP-backed agents', () => {
    const manager = getTestAgentManager();
    const agent = manager.spawn({ mode: 'spawn', task: 'Remote contract task', template: 'engineer', tools: ['read', 'edit'], dangerously_disable_wrfc: true });
    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: [agent.id],
        connections: new Map([
          [agent.id, {
            agentId: agent.id,
            label: 'remote implementer',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 7,
            errorCount: 1,
            taskId: 'remote-task-1',
          }],
        ]),
      },
    }));

    const registry = new RemoteRunnerRegistry(getTestAgentManager());
    const contract = registry.upsertContractForAgent(agent.id, store);
    expect(contract).not.toBeNull();
    expect(contract?.trustClass).toBe('self-hosted-acp');
    expect(contract?.capabilityCeiling.executionProtocol).toBe('gather-plan-apply');
    expect(contract?.capabilityCeiling.allowedTools).toContain('edit');
  });

  test('captures, exports, and imports remote review artifacts', async () => {
    const manager = getTestAgentManager();
    const agent = manager.spawn({
      mode: 'spawn',
      task: 'Capture remote artifact export',
      template: 'engineer',
      tools: ['read'],
      dangerously_disable_wrfc: true,
    });
    agent.status = 'completed';
    agent.fullOutput = 'Completed remote review flow successfully.';
    agent.completedAt = Date.now();
    agent.knowledgeInjections = [{
      id: 'mem-remote-1',
      cls: 'runbook',
      summary: 'Use remote artifacts for offline review',
      reason: 'matched task token "remote"',
      confidence: 91,
      reviewState: 'reviewed',
    }];

    const store = createRuntimeStore();
    const registry = new RemoteRunnerRegistry(manager);
    const dir = mkdtempSync(join(tmpdir(), 'gv-remote-artifacts-'));
    const exportPath = join(dir, 'artifact.json');

    const exported = await exportRemoteArtifactForAgent(registry, agent.id, store, exportPath);
    expect(exported).not.toBeNull();
    const exportedArtifact = exported!;
    expect(exportedArtifact.artifact.runnerId).toBe(agent.id);
    expect(exportedArtifact.artifact.knowledgeInjections.length).toBe(1);
    expect(existsSync(exportPath)).toBe(true);

    const imported = await importRemoteArtifact(registry, exportPath);
    expect(imported.id).toBe(exportedArtifact.artifact.id);
    expect(imported.task.summary).toContain('Completed remote review flow');
  });

  test('manages remote runner pools and preserves pool assignment on contracts', () => {
    const manager = getTestAgentManager();
    const agent = manager.spawn({ mode: 'spawn', task: 'Pool-ready runner', template: 'engineer', tools: ['read'], dangerously_disable_wrfc: true });
    const registry = new RemoteRunnerRegistry(manager);
    registry.createPool({ id: 'ops', label: 'Ops Pool', preferredTemplate: 'engineer', maxRunners: 2 });
    registry.registerContract({
      id: `runner:${agent.id}`,
      runnerId: agent.id,
      label: 'ops remote runner',
      sourceTransport: 'acp',
      trustClass: 'self-hosted-acp',
      template: 'engineer',
      capabilityCeiling: Object.freeze({
        allowedTools: ['read'],
        capabilityCeilingTools: ['read'],
        executionProtocol: 'gather-plan-apply',
        reviewMode: 'none',
        communicationLane: 'direct',
        orchestrationDepth: 0,
        successCriteria: [],
        requiredEvidence: [],
        writeScope: [],
      }),
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      transport: Object.freeze({
        state: 'initializing',
        messageCount: 0,
        errorCount: 0,
      }),
    });

    const pool = registry.assignRunnerToPool('ops', agent.id);
    expect(pool).not.toBeNull();
    expect(pool?.runnerIds).toContain(agent.id);
    expect(registry.getContract(agent.id)?.poolId).toBe('ops');

    registry.removeRunnerFromPool('ops', agent.id);
    expect(registry.getContract(agent.id)?.poolId).toBeUndefined();
  });
});
