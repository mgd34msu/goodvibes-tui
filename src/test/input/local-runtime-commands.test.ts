import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerRemoteRuntimeCommands } from '../../input/commands/remote-runtime.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import {
  getTestAgentManager,
  getTestRemoteRunnerRegistry,
  getTestRemoteSupervisor,
  resetTestRuntimeServices,
} from '../helpers/runtime-services.ts';

function makeContext(store = createRuntimeStore()) {
  const printed: string[] = [];
  return {
    printed,
    context: {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: 'mock',
        provider: 'mock',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'session-test',
      },
      renderRequest: () => {},
      print: (text: string) => { printed.push(text); },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
      remoteRunnerRegistry: getTestRemoteRunnerRegistry(),
      remoteSupervisor: getTestRemoteSupervisor(),
      agentManager: getTestAgentManager(),
    },
  };
}

describe('local runtime remote commands', () => {
  test('shows active remote connection details', async () => {
    const registry = new CommandRegistry();
    registerRemoteRuntimeCommands(registry);
    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: ['agent-remote'],
        connections: new Map([
          ['agent-remote', {
            agentId: 'agent-remote',
            label: 'remote researcher',
            transportState: 'connected',
            connectedAt: 1_700_000_000_000,
            completing: false,
            messageCount: 5,
            errorCount: 1,
            lastError: 'network blip',
            taskId: 'task-remote',
          }],
        ]),
      },
    }));
    const { context, printed } = makeContext(store);

    await registry.execute('remote', ['show', 'agent-remote'], context);

    expect(printed.join('\n')).toContain('Remote connection agent-remote');
    expect(printed.join('\n')).toContain('remote researcher');
    expect(printed.join('\n')).toContain('task-remote');
  });

  test('cancels a remote agent through the normal agent manager path', async () => {
    resetTestRuntimeServices();
    const manager = getTestAgentManager();
    const record = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [], orchestrationNodeId: 'remote-node', orchestrationGraphId: 'graph-remote' });

    const registry = new CommandRegistry();
    registerRemoteRuntimeCommands(registry);
    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      acp: {
        ...state.acp,
        activeConnectionIds: [record.id],
        connections: new Map([
          [record.id, {
            agentId: record.id,
            label: 'remote worker',
            transportState: 'connected',
            connectedAt: Date.now(),
            completing: false,
            messageCount: 0,
            errorCount: 0,
          }],
        ]),
      },
    }));
    const { context, printed } = makeContext(store);

    await registry.execute('remote', ['cancel', record.id], context);

    expect(manager.getStatus(record.id)?.status).toBe('cancelled');
    expect(printed.join('\n')).toContain(`Cancelled remote agent ${record.id}`);
  });
});
