import { beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { registerBuiltinPanels } from '../../panels/builtin-panels.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { ForensicsRegistry } from '@/runtime/index.ts';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { ConversationManager } from '../../core/conversation';
import { createOperatorClientServices } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createUiRuntimeServices } from '../../runtime/ui-services.ts';
import { createRuntimeHookApi } from '@/runtime/index.ts';
import { createRuntimeKnowledgeApi } from '@/runtime/index.ts';
import { createRuntimeMcpApi } from '@/runtime/index.ts';
import { createRuntimeProviderApi } from '@/runtime/index.ts';
import { createOperatorClient } from '@/runtime/index.ts';
import { createPeerClient } from '@/runtime/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import { MemoryRegistry, MemoryStore } from '@pellux/goodvibes-sdk/platform/state';
import { SystemMessagesPanel } from '../../panels/system-messages-panel.ts';
import { createOrchestrationReadModel } from '../helpers/ui-read-models.ts';
import { listHookPointContracts } from '@pellux/goodvibes-sdk/platform/hooks';

type CommandContextOverrides =
  Omit<Partial<CommandContext>, 'session' | 'provider' | 'workspace' | 'platform' | 'ops' | 'extensions'> & {
    session?: Partial<CommandContext['session']> & {
      runtime?: Partial<CommandContext['session']['runtime']>;
    };
    provider?: Partial<CommandContext['provider']>;
    workspace?: Partial<CommandContext['workspace']>;
    platform?: Partial<CommandContext['platform']>;
    ops?: Partial<CommandContext['ops']>;
    extensions?: Partial<CommandContext['extensions']>;
  };
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';

describe('operator surfaces gate', () => {
  let configManager: ConfigManager;
  let runtimeServices: ReturnType<typeof createRuntimeServices>;
  let policyRuntimeState: PolicyRuntimeState;

  beforeEach(() => {
    policyRuntimeState = new PolicyRuntimeState();
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(tmpdir(), `gv-operator-surfaces-${Date.now()}-${Math.random().toString(36).slice(2)}`) });
    configManager.set('orchestration.maxActiveAgents', 8);
    configManager.set('orchestration.maxDepth', 1);
    configManager.set('orchestration.recursionEnabled', true);
    runtimeServices = createRuntimeServices({
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      configManager,
      workingDir: configManager.getControlPlaneConfigDir(),
      homeDirectory: tmpdir(),
      getConversationTitle: () => 'operator-surfaces',
    });
  });

  function makeCommandContext(
    sessionId: string,
    overrides: CommandContextOverrides = {},
  ): CommandContext {
    const { session: sessionOverride, ...rest } = overrides;
    const providerRegistry = runtimeServices.providerRegistry;
    const conversationManager = new ConversationManager(() => 80);
    const uiServices = createUiRuntimeServices(runtimeServices);
    const base: CommandContext = {
      session: {
        conversationManager,
        sessionManager: runtimeServices.sessionManager,
        runtime: {
          model: '',
          provider: '',
          debugMode: false,
          systemPrompt: '',
          reasoningEffort: '',
          sessionId,
        },
      },
      provider: {
        providerRegistry,
      },
      workspace: {
        shellPaths: runtimeServices.shellPaths,
        worktreeRegistry: runtimeServices.worktreeRegistry,
        sandboxSessionRegistry: runtimeServices.sandboxSessionRegistry,
        bookmarkManager: runtimeServices.bookmarkManager,
        profileManager: runtimeServices.profileManager,
      },
      platform: {
        config: configManager.getRaw(),
        configManager,
        readModels: uiServices.readModels,
        subscriptionManager: runtimeServices.subscriptionManager,
      },
      ops: {
        agentManager: runtimeServices.agentManager,
      },
      extensions: {
        toolRegistry: new ToolRegistry(),
        mcpRegistry: runtimeServices.mcpRegistry,
        knowledgeService: runtimeServices.knowledgeService,
        hookWorkbench: runtimeServices.hookWorkbench,
        pluginManager: runtimeServices.pluginManager,
      },
      clients: {
        operator: createOperatorClient(createOperatorClientServices(runtimeServices)),
        peer: createPeerClient({
          runtimeStore: runtimeServices.runtimeStore,
          distributedRuntime: runtimeServices.distributedRuntime,
          remoteRunnerRegistry: runtimeServices.remoteRunnerRegistry,
          remoteSupervisor: runtimeServices.remoteSupervisor,
        }),
        providerApi: createRuntimeProviderApi(runtimeServices),
        knowledgeApi: createRuntimeKnowledgeApi(runtimeServices),
        hookApi: createRuntimeHookApi({
          dispatcher: {
            listHooks: () => runtimeServices.hookDispatcher.listHooks(),
            listChains: () => runtimeServices.hookWorkbench.listManagedChains(),
          },
          workbench: runtimeServices.hookWorkbench,
          listContracts: () => listHookPointContracts(),
        }),
        mcpApi: createRuntimeMcpApi(runtimeServices.mcpRegistry),
      },
      renderRequest: () => {},
      print: () => {},
      exit: () => {},
    };
    return {
      ...base,
      ...rest,
      session: {
        ...base.session,
        ...sessionOverride,
        runtime: {
          ...base.session.runtime,
          ...sessionOverride?.runtime,
        },
      },
      provider: {
        ...base.provider,
        ...overrides.provider,
      },
      workspace: {
        ...base.workspace,
        ...overrides.workspace,
      },
      platform: {
        ...base.platform,
        ...overrides.platform,
      },
      ops: {
        ...base.ops,
        ...overrides.ops,
      },
      extensions: {
        ...base.extensions,
        ...overrides.extensions,
      },
    };
  }

  test('built-in strategic operator panels are registered on the active runtime surface', () => {
    const manager = new PanelManager();
    const uiServices = createUiRuntimeServices(runtimeServices);
    registerBuiltinPanels(manager, {
      providerRegistry: runtimeServices.providerRegistry,
      uiServices,
      forensicsRegistry: new ForensicsRegistry(),
      policyRuntimeState,
      memoryRegistry: new MemoryRegistry(new MemoryStore(':memory:', {
        embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
      })),
      tokenAuditor: runtimeServices.tokenAuditor,
      componentHealthMonitor: runtimeServices.componentHealthMonitor,
      worktreeRegistry: runtimeServices.worktreeRegistry,
      sandboxSessionRegistry: runtimeServices.sandboxSessionRegistry,
      systemMessagesPanel: new SystemMessagesPanel(runtimeServices.configManager, runtimeServices.componentHealthMonitor),
    });
    const ids = manager.getRegisteredTypes().map((entry) => entry.id);

    expect(ids).toContain('policy');
    expect(ids).toContain('hooks');
    expect(ids).toContain('communication');
    expect(ids).toContain('cockpit');
    expect(ids).toContain('security');
    expect(ids).toContain('marketplace');
    expect(ids).toContain('sandbox');
    expect(ids).toContain('approval');
    expect(ids).toContain('subscription');
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
    expect(registry.get('marketplace')).toBeDefined();
    expect(registry.get('sandbox')).toBeDefined();
    expect(registry.get('approval')).toBeDefined();
    expect(registry.get('subscription')).toBeDefined();
    expect(registry.get('storage')).toBeDefined();
    expect(registry.get('deeplink')).toBeDefined();
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
    await policy!.handler([], makeCommandContext('sess-operator-surfaces', {
      openPolicyPanel: () => {
        opened = true;
      },
      extensions: {
        policyRegistry: policyRuntimeState.getRegistry(),
      },
    }));

    expect(opened).toBe(true);
  });

  test('hooks command opens the hooks panel when no filter is supplied', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const hooks = registry.get('hooks');
    expect(hooks).toBeDefined();

    let opened = false;
    await hooks!.handler([], makeCommandContext('sess-hooks-panel', {
      openHooksPanel: () => {
        opened = true;
      },
    }));

    expect(opened).toBe(true);
  });

  test('communication command opens the communication panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const communication = registry.get('communication');
    expect(communication).toBeDefined();

    let opened = false;
    await communication!.handler([], makeCommandContext('sess-communication-panel', {
      openCommunicationPanel: () => {
        opened = true;
      },
    }));

    expect(opened).toBe(true);
  });

  test('subscription command opens the subscription panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const subscription = registry.get('subscription');
    expect(subscription).toBeDefined();

    let opened = false;
    await subscription!.handler([], makeCommandContext('sess-subscription-panel', {
      openSubscriptionPanel: () => {
        opened = true;
      },
    }));

    expect(opened).toBe(true);
  });

  test('security command opens the security panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const security = registry.get('security');
    expect(security).toBeDefined();

    let opened = false;
    await security!.handler([], makeCommandContext('sess-security-panel', {
      openSecurityPanel: () => {
        opened = true;
      },
    }));

    expect(opened).toBe(true);
  });

  test('knowledge command opens the knowledge panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const knowledge = registry.get('knowledge');
    expect(knowledge).toBeDefined();

    let opened = false;
    await knowledge!.handler([], makeCommandContext('sess-knowledge-panel', {
      openKnowledgePanel: () => {
        opened = true;
      },
    }));

    expect(opened).toBe(true);
  });

  test('remote command opens the remote panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    let opened = false;
    await remote!.handler([], makeCommandContext('sess-remote-panel', {
      openRemotePanel: () => {
        opened = true;
      },
    }));

    expect(opened).toBe(true);
  });

  test('cockpit command opens the cockpit panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const cockpit = registry.get('cockpit');
    expect(cockpit).toBeDefined();

    let opened = false;
    await cockpit!.handler([], makeCommandContext('sess-cockpit-panel', {
      openCockpitPanel: () => {
        opened = true;
      },
    }));

    expect(opened).toBe(true);
  });

  test('incident command opens the incident review panel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const incident = registry.get('incident');
    expect(incident).toBeDefined();

    let opened = false;
    await incident!.handler([], makeCommandContext('sess-incident-panel', {
      openIncidentPanel: () => {
        opened = true;
      },
    }));

    expect(opened).toBe(true);
  });

  test('orchestration command opens the orchestration panel when no subcommand is supplied', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const orchestration = registry.get('orchestration');
    expect(orchestration).toBeDefined();

    let opened = false;
    await orchestration!.handler([], makeCommandContext('sess-orchestration-panel', {
      openOrchestrationPanel: () => {
        opened = true;
      },
    }));

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
    await orchestration!.handler(['show', 'graph-1'], makeCommandContext('sess-orchestration-show', {
      print: (text: string) => {
        printed.push(text);
      },
      platform: {
        readModels: {
          orchestration: createOrchestrationReadModel(store),
        } as never,
      },
    }));

    expect(printed.join('\n')).toContain('Graph graph-1');
    expect(printed.join('\n')).toContain('Graph One');
    expect(printed.join('\n')).toContain('Engineer');
  });

  test('orchestration cancel graph cancels active agents in the target graph', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const orchestration = registry.get('orchestration');
    expect(orchestration).toBeDefined();

    const manager = new AgentManager({ configManager });
    const a = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'engineer', tools: ['read'], restrictTools: true, cohort: 'alpha' });
    const b = manager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'engineer', tools: ['read'], restrictTools: true, cohort: 'alpha' });
    const printed: string[] = [];

    await orchestration!.handler(['cancel', 'graph', 'cohort:alpha'], makeCommandContext('sess-orchestration-cancel', {
      print: (text: string) => {
        printed.push(text);
      },
      ops: {
        agentManager: manager,
      },
    }));

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
    await mcp!.handler([], makeCommandContext('sess-mcp-panel', {
      openMcpPanel: () => {
        opened = true;
      },
    }));

    expect(opened).toBe(true);
  });

  test('mcp allow-all escalation requires the settings surface', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const mcp = registry.get('mcp');
    expect(mcp).toBeDefined();

    let openedSettings = false;
    const printed: string[] = [];
    await mcp!.handler(['trust', 'docs-server', 'allow-all'], makeCommandContext('sess-mcp-allow-all', {
      print: (text: string) => {
        printed.push(text);
      },
      openSettingsModal: () => {
        openedSettings = true;
      },
    }));

    expect(openedSettings).toBe(true);
    expect(printed.join('\n')).toContain('Use /settings');
  });
});
