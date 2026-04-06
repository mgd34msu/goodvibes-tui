import { describe, expect, test } from 'bun:test';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { RemotePanel } from '../../panels/remote-panel.ts';
import type { Line } from '../../types/grid.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import { _resetRemoteRunnerRegistryForTesting, getRemoteRunnerRegistry } from '../../runtime/remote/index.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('RemotePanel', () => {
  test('renders runner contract and recent review artifact details', () => {
    AgentManager.resetInstance();
    _resetRemoteRunnerRegistryForTesting();
    const manager = AgentManager.getInstance();
    const agent = manager.spawn({
      mode: 'spawn',
      task: 'Inspect remote artifact panel',
      template: 'engineer',
      tools: ['read', 'edit'],
      dangerously_disable_wrfc: true,
    });
    agent.status = 'completed';
    agent.fullOutput = 'Remote artifact export complete.';
    agent.completedAt = Date.now();

    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      daemon: {
        ...state.daemon,
        transportState: 'connected',
        isRunning: true,
      },
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
            messageCount: 11,
            errorCount: 0,
            taskId: 'task-remote-artifact',
          }],
        ]),
      },
    }));
    const registry = getRemoteRunnerRegistry();
    registry.captureArtifactForAgent(agent.id, store);

    const text = linesText(new RemotePanel(store).render(140, 22));
    expect(text).toContain('runner contracts');
    expect(text).toContain('review artifacts');
    expect(text).toContain('Contract:');
    expect(text).toContain('Recent Review Artifact');
    expect(text).toContain('remote implementer');
  });

  test('renders empty guidance without a runtime store', () => {
    const text = linesText(new RemotePanel().render(120, 12));
    expect(text).toContain('Remote Control Room');
    expect(text).toContain('Runtime store not wired');
  });

  test('renders daemon posture and selected ACP connection detail', () => {
    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      daemon: {
        ...state.daemon,
        transportState: 'connected',
        isRunning: true,
        reconnectAttempts: 1,
        runningJobCount: 2,
      },
      acp: {
        ...state.acp,
        managerTransportState: 'syncing',
        activeConnectionIds: ['agent-1', 'agent-2'],
        totalMessages: 18,
        connections: new Map([
          ['agent-1', {
            agentId: 'agent-1',
            label: 'remote implementer',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 14,
            errorCount: 0,
            taskId: 'task-1',
          }],
          ['agent-2', {
            agentId: 'agent-2',
            label: 'remote reviewer',
            transportState: 'reconnecting',
            connectedAt: Date.now() - 1_000,
            completing: true,
            messageCount: 4,
            errorCount: 1,
            lastError: 'connection lost',
            taskId: 'task-2',
          }],
        ]),
      },
    }));

    const panel = new RemotePanel(store);
    expect(panel.handleInput('down')).toBe(true);
    const text = linesText(panel.render(140, 18));
    expect(text).toContain('daemon');
    expect(text).toContain('ACP');
    expect(text).toContain('active connections');
    expect(text).toContain('Selected Connection');
    expect(text).toContain('agent-2');
    expect(text).toContain('remote reviewer');
    expect(text).toContain('connection lost');
    expect(text).toContain('Task:');
  });
});
