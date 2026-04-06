import { beforeEach, describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { registerBuiltinPanels } from '../../panels/builtin-panels.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { ForensicsRegistry } from '../../runtime/forensics/registry.ts';
import { getPolicyRuntimeState, resetPolicyRuntimeStateForTests } from '../../runtime/permissions/policy-runtime.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import { configManager } from '../../config/index.ts';
import { MemoryRegistry, MemoryStore } from '../../state/memory-store.ts';

describe('operator surfaces gate', () => {
  beforeEach(() => {
    resetPolicyRuntimeStateForTests();
    AgentManager.resetInstance();
    configManager.set('orchestration.maxActiveAgents', 8);
    configManager.set('orchestration.maxDepth', 1);
    configManager.set('orchestration.recursionEnabled', true);
  });

  test('built-in strategic operator panels are registered on the active runtime surface', () => {
    const manager = new PanelManager();
    registerBuiltinPanels(manager, {
      runtimeBus: new RuntimeEventBus(),
      forensicsRegistry: new ForensicsRegistry(),
      policyRuntimeState: getPolicyRuntimeState(),
      memoryRegistry: new MemoryRegistry(new MemoryStore(':memory:')),
    });
    const ids = manager.getRegisteredTypes().map((entry) => entry.id);

    expect(ids).toContain('policy');
    expect(ids).toContain('hooks');
    expect(ids).toContain('communication');
    expect(ids).toContain('cockpit');
    expect(ids).toContain('security');
    expect(ids).toContain('knowledge');
    expect(ids).toContain('remote');
    expect(ids).toContain('incident');
    expect(ids).toContain('orchestration');
    expect(ids).toContain('mcp');
    expect(ids).toContain('forensics');
    expect(ids).toContain('providers');
    expect(ids).toContain('sessions');
    expect(ids).toContain('ops');
  });

  test('command registry exposes the provider, policy, and session control surfaces', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    expect(registry.get('policy')).toBeDefined();
    expect(registry.get('cockpit')).toBeDefined();
    expect(registry.get('incident')).toBeDefined();
    expect(registry.get('orchestration')).toBeDefined();
    expect(registry.get('hooks')).toBeDefined();
    expect(registry.get('communication')).toBeDefined();
    expect(registry.get('security')).toBeDefined();
    expect(registry.get('knowledge')).toBeDefined();
    expect(registry.get('remote')).toBeDefined();
    expect(registry.get('mcp')).toBeDefined();
    expect(registry.get('provider')).toBeDefined();
    expect(registry.get('session')).toBeDefined();
  });

  test('policy command opens the policy panel when no subcommand is supplied', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const policy = registry.get('policy');
    expect(policy).toBeDefined();

    let opened = false;
    await policy!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-operator-surfaces',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openPolicyPanel: () => {
        opened = true;
      },
      policyRegistry: getPolicyRuntimeState().getRegistry(),
    });

    expect(opened).toBe(true);
  });

  test('hooks command opens the hooks panel when no filter is supplied', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const hooks = registry.get('hooks');
    expect(hooks).toBeDefined();

    let opened = false;
    await hooks!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-hooks-panel',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openHooksPanel: () => {
        opened = true;
      },
    });

    expect(opened).toBe(true);
  });

  test('communication command opens the communication panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const communication = registry.get('communication');
    expect(communication).toBeDefined();

    let opened = false;
    await communication!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-communication-panel',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openCommunicationPanel: () => {
        opened = true;
      },
    });

    expect(opened).toBe(true);
  });

  test('security command opens the security panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const security = registry.get('security');
    expect(security).toBeDefined();

    let opened = false;
    await security!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-security-panel',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openSecurityPanel: () => {
        opened = true;
      },
    });

    expect(opened).toBe(true);
  });

  test('knowledge command opens the knowledge panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const knowledge = registry.get('knowledge');
    expect(knowledge).toBeDefined();

    let opened = false;
    await knowledge!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-knowledge-panel',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openKnowledgePanel: () => {
        opened = true;
      },
    });

    expect(opened).toBe(true);
  });

  test('remote command opens the remote panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    let opened = false;
    await remote!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-remote-panel',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openRemotePanel: () => {
        opened = true;
      },
    });

    expect(opened).toBe(true);
  });

  test('cockpit command opens the cockpit panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const cockpit = registry.get('cockpit');
    expect(cockpit).toBeDefined();

    let opened = false;
    await cockpit!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-cockpit-panel',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openCockpitPanel: () => {
        opened = true;
      },
    });

    expect(opened).toBe(true);
  });

  test('incident command opens the incident review panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const incident = registry.get('incident');
    expect(incident).toBeDefined();

    let opened = false;
    await incident!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-incident-panel',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openIncidentPanel: () => {
        opened = true;
      },
    });

    expect(opened).toBe(true);
  });

  test('orchestration command opens the orchestration panel when no subcommand is supplied', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const orchestration = registry.get('orchestration');
    expect(orchestration).toBeDefined();

    let opened = false;
    await orchestration!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-orchestration-panel',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      openOrchestrationPanel: () => {
        opened = true;
      },
    });

    expect(opened).toBe(true);
  });

  test('orchestration show prints the selected graph summary', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const orchestration = registry.get('orchestration');
    expect(orchestration).toBeDefined();

    const store = createRuntimeStore();
    store.setState((state) => ({
      ...state,
      orchestration: {
        ...state.orchestration,
        graphs: new Map([
          ['graph-1', {
            id: 'graph-1',
            title: 'Graph One',
            mode: 'parallel-workers',
            status: 'running',
            nodeOrder: ['node-1'],
            nodes: new Map([
              ['node-1', {
                id: 'node-1',
                title: 'Engineer',
                role: 'engineer',
                status: 'running',
                childNodeIds: [],
                dependencyNodeIds: [],
              }],
            ]),
            createdAt: Date.now(),
          }],
        ]),
        activeGraphIds: ['graph-1'],
        totalGraphs: 1,
      },
    }));

    const printed: string[] = [];
    await orchestration!.handler(['show', 'graph-1'], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-orchestration-show',
      },
      renderRequest: () => {},
      print: (text: string) => {
        printed.push(text);
      },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: store,
    });

    expect(printed.join('\n')).toContain('Graph graph-1');
    expect(printed.join('\n')).toContain('Graph One');
    expect(printed.join('\n')).toContain('Engineer');
  });

  test('orchestration cancel graph cancels active agents in the target graph', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const orchestration = registry.get('orchestration');
    expect(orchestration).toBeDefined();

    const manager = AgentManager.getInstance();
    const a = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'engineer', tools: ['read'], restrictTools: true, cohort: 'alpha' });
    const b = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'engineer', tools: ['read'], restrictTools: true, cohort: 'alpha' });
    const printed: string[] = [];

    await orchestration!.handler(['cancel', 'graph', 'cohort:alpha'], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-orchestration-cancel',
      },
      renderRequest: () => {},
      print: (text: string) => {
        printed.push(text);
      },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      runtimeStore: createRuntimeStore(),
    });

    expect(manager.getStatus(a.id)?.status).toBe('cancelled');
    expect(manager.getStatus(b.id)?.status).toBe('cancelled');
    expect(printed.join('\n')).toContain('Cancelled 2 agents in graph cohort:alpha.');
  });

  test('mcp command opens the mcp panel when no subcommand is supplied', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const mcp = registry.get('mcp');
    expect(mcp).toBeDefined();

    let opened = false;
    await mcp!.handler([], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-mcp-panel',
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {
        listServerSecurity: () => [],
      } as never,
      openMcpPanel: () => {
        opened = true;
      },
    });

    expect(opened).toBe(true);
  });

  test('mcp allow-all escalation requires the settings surface', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const mcp = registry.get('mcp');
    expect(mcp).toBeDefined();

    let openedSettings = false;
    let changedTrust = false;
    const printed: string[] = [];
    await mcp!.handler(['trust', 'docs-server', 'allow-all'], {
      providerRegistry: {} as never,
      conversationManager: {} as never,
      config: {} as never,
      configManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'sess-mcp-allow-all',
      },
      renderRequest: () => {},
      print: (text: string) => {
        printed.push(text);
      },
      exit: () => {},
      toolRegistry: {} as never,
      mcpRegistry: {
        setServerTrustMode: () => {
          changedTrust = true;
        },
      } as never,
      openSettingsModal: () => {
        openedSettings = true;
      },
    });

    expect(openedSettings).toBe(true);
    expect(changedTrust).toBe(false);
    expect(printed.join('\n')).toContain('Use /settings');
  });
});
