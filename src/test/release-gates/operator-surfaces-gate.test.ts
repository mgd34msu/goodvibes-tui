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
import { MemorySpineClient, createLocalMemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
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
import { trackDisposables } from '../helpers/disposables.ts';

/**
 * registerBuiltinPanels wants a `MemoryAccess` client (the async facade), not
 * the raw synchronous `MemoryRegistry`, mirrors the real wiring in
 * runtime/services.ts (`new MemorySpineClient({ local: createLocalMemoryAccess(memoryRegistry) })`).
 */
function makeMemoryAccess(registry: MemoryRegistry): MemorySpineClient {
  return new MemorySpineClient({ local: createLocalMemoryAccess(registry) });
}

/**
 * A composed runtime graph starts a dozen pollers while it builds, the fleet
 * registry tick, the config-file watch, the memory governor, the knowledge
 * scheduler, the cross-session sweep, the orchestration snapshot writer, the
 * push-subscription sweep and the snapshot / retention / consolidation
 * schedulers. Nothing upstream stops a graph it did not compose itself, so the
 * test that built it owns stopping it.
 */
const disposables = trackDisposables();

describe('operator surfaces gate', () => {
  let configManager: ConfigManager;
  let runtimeServices: ReturnType<typeof createRuntimeServices>;
  let policyRuntimeState: PolicyRuntimeState;

  beforeEach(() => {
    policyRuntimeState = new PolicyRuntimeState();
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(tmpdir(), `gv-operator-surfaces-${Date.now()}-${Math.random().toString(36).slice(2)}`) });
    configManager.set('fleet.maxSize', 8);
    configManager.set('orchestration.maxDepth', 1);
    configManager.set('orchestration.recursionEnabled', true);
    runtimeServices = disposables.add(createRuntimeServices({
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      configManager,
      workingDir: configManager.getControlPlaneConfigDir(),
      homeDirectory: tmpdir(),
      getConversationTitle: () => 'operator-surfaces',
    }));
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
      memoryRegistry: makeMemoryAccess(new MemoryRegistry(new MemoryStore(':memory:', {
        embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
      }))),
      tokenAuditor: runtimeServices.tokenAuditor,
      componentHealthMonitor: runtimeServices.componentHealthMonitor,
      worktreeRegistry: runtimeServices.worktreeRegistry,
      sandboxSessionRegistry: runtimeServices.sandboxSessionRegistry,
    });
    const ids = manager.getRegisteredTypes().map((entry) => entry.id);

    // (the purge), group B: the 12 ecosystem/governance panels
    // migrated to config-modal SURFACES registered centrally in
    // registerBuiltinModals. Each old panel id is gone and redirects to its
    // '-modal' surface; 'sessions' folds into the existing session picker.
    const GROUP_B_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
      ['marketplace', 'marketplace-modal'], ['plugins', 'plugins-modal'], ['skills', 'skills-modal'],
      ['hooks', 'hooks-modal'], ['policy', 'policy-modal'], ['security', 'security-modal'],
      ['knowledge', 'knowledge-modal'], ['memory', 'memory-modal'], ['docs', 'keybindings-modal'],
      ['qr-code', 'pairing-modal'], ['work-plan', 'work-plan-modal'], ['project-planning', 'planning-modal'],
      ['sessions', 'sessionPicker'],
    ];
    for (const [panelId, modalName] of GROUP_B_REDIRECTS) {
      expect(ids).not.toContain(panelId);
      expect(manager.getModalRedirect(panelId)).toBe(modalName);
    }
    // All 12 group-B surfaces resolve (registration completeness 12/12).
    for (const name of ['marketplace-modal', 'plugins-modal', 'skills-modal', 'hooks-modal', 'security-modal', 'policy-modal', 'knowledge-modal', 'memory-modal', 'work-plan-modal', 'keybindings-modal', 'pairing-modal', 'planning-modal']) {
      expect(manager.getModalSurface(name)?.name).toBe(name);
    }
    expect(ids).toContain('fleet');
    // local-auth stays a registered panel, it is the host for the
    // masked password-entry sub-mode (LocalAuthPanel.openMaskedEntry) and cannot
    // be retired without regressing that secure input path.
    expect(ids).toContain('local-auth');

    // (the purge): services, subscription, remote, provider-health,
    // settings-sync, and sandbox were MIGRATE-TO-MODAL, no longer registered as
    // panels; each id resolves to a config-modal surface via
    // registerModalRedirect. 'providers'/'accounts' (former provider-health
    // panel aliases) now redirect to the same providers-modal.
    for (const id of ['services', 'subscription', 'remote', 'provider-health', 'settings-sync', 'sandbox']) {
      expect(ids).not.toContain(id);
    }
    expect(manager.getModalRedirect('services')).toBe('services-modal');
    expect(manager.getModalRedirect('subscription')).toBe('subscription-modal');
    expect(manager.getModalRedirect('remote')).toBe('remote-modal');
    expect(manager.getModalRedirect('provider-health')).toBe('providers-modal');
    expect(manager.getModalRedirect('providers')).toBe('providers-modal');
    expect(manager.getModalRedirect('accounts')).toBe('providers-modal');
    expect(manager.getModalRedirect('settings-sync')).toBe('settings-sync-modal');
    expect(manager.getModalRedirect('sandbox')).toBe('sandbox-modal');
    // local-auth is deliberately NOT redirected (masked-entry host).
    expect(manager.getModalRedirect('local-auth')).toBeUndefined();

    // (the purge): communication, cockpit, approval, incident,
    // orchestration, and ops were RETIRE-INTO-FLEET, they no longer appear
    // as standalone registered types; each id now resolves (via
    // PanelManager.registerAlias) to the same Fleet instance.
    for (const retiredId of ['communication', 'cockpit', 'approval', 'incident', 'orchestration', 'ops']) {
      expect(ids).not.toContain(retiredId);
      expect(manager.open(retiredId)).toBe(manager.open('fleet'));
    }
    // the 'forensics' panel merged into the incident console, which
    // itself later retired into fleet, both ids now resolve straight
    // to fleet (alias resolution is a single hop; forensics does not chain
    // through the also-retired 'incident').
    expect(manager.open('forensics')).toBe(manager.open('fleet'));
    // the 'agent-logs' console merged into inspector, which itself
    // later retired into fleet, both ids now resolve straight to
    // fleet.
    expect(manager.open('agent-logs')).toBe(manager.open('fleet'));
    expect(manager.open('inspector')).toBe(manager.open('fleet'));
    // WRFC retired into fleet alongside inspector.
    expect(manager.open('wrfc')).toBe(manager.open('fleet'));
    // the 'context' visualizer merged into the tokens console; the
    // retired id survives only as a PanelManager alias.
    expect(manager.open('context')).toBe(manager.open('tokens'));
    // (the purge), group B: 'sessions' folded into the existing session
    // picker modal, no longer a registered panel; redirects to 'sessionPicker'.
    expect(ids).not.toContain('sessions');
    expect(manager.getModalRedirect('sessions')).toBe('sessionPicker');
    // panel-list was DELETE-disposition, it no longer resolves at all
    // (no alias, unlike the RETIRE ids above).
    expect(ids).not.toContain('panel-list');
  });

  test('prewarmRegistered() only constructs tokens after the panel-consolidation cleanup (thinking/tools/inspector/wrfc/communication/provider-health/system-messages no longer preload)', () => {
    const manager = new PanelManager();
    const uiServices = createUiRuntimeServices(runtimeServices);
    const factoryCalls: string[] = [];
    registerBuiltinPanels(manager, {
      providerRegistry: runtimeServices.providerRegistry,
      uiServices,
      forensicsRegistry: new ForensicsRegistry(),
      policyRuntimeState,
      memoryRegistry: makeMemoryAccess(new MemoryRegistry(new MemoryStore(':memory:', {
        embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
      }))),
      tokenAuditor: runtimeServices.tokenAuditor,
      componentHealthMonitor: runtimeServices.componentHealthMonitor,
      worktreeRegistry: runtimeServices.worktreeRegistry,
      sandboxSessionRegistry: runtimeServices.sandboxSessionRegistry,
    });
    // Wrap every registered factory to record which ids actually get built by
    // prewarmRegistered(), without changing what they return.
    for (const reg of manager.getRegisteredTypes()) {
      const originalFactory = reg.factory;
      manager.registerType({ ...reg, factory: () => { factoryCalls.push(reg.id); return originalFactory(); } });
    }

    manager.prewarmRegistered();

    expect(factoryCalls).toEqual(['tokens']);
  });

  test('cost/memory are always registered and open to a "not configured" state without their optional dependency', () => {
    const manager = new PanelManager();
    const uiServices = createUiRuntimeServices(runtimeServices);
    // Deliberately omit memoryRegistry and getOrchestratorUsage, the exact
    // conditions that used to skip registration entirely and make
    // `/panel open <id>` report "Unknown panel".
    // (forensicsRegistry/evalRegistry are also omitted here, but that
    // no longer matters for this assertion, incident retired into fleet and
    // eval was deleted outright; see the next assertions below.)
    registerBuiltinPanels(manager, {
      providerRegistry: runtimeServices.providerRegistry,
      uiServices,
      policyRuntimeState,
      tokenAuditor: runtimeServices.tokenAuditor,
      componentHealthMonitor: runtimeServices.componentHealthMonitor,
      worktreeRegistry: runtimeServices.worktreeRegistry,
      sandboxSessionRegistry: runtimeServices.sandboxSessionRegistry,
    });
    const ids = manager.getRegisteredTypes().map((entry) => entry.id);
    expect(ids).toContain('cost');
    // (the purge), group B: 'memory' migrated to the 'memory-modal'
    // config-modal surface. It no longer registers as a panel (the modal owns
    // the "not configured" degraded state now, see memory-modal.ts); it redirects.
    expect(ids).not.toContain('memory');
    expect(manager.getModalRedirect('memory')).toBe('memory-modal');

    for (const id of ['cost']) {
      // Must not throw "Unknown panel", the registration always exists now.
      const panel = manager.open(id);
      expect(panel.id).toBe(id);
      const text = panel.render(80, 24).map((line) => line.map((c) => c.char ?? ' ').join('')).join('\n');
      expect(text.toLowerCase()).toContain('not configured');
      manager.close(id);
    }

    // (the purge): 'incident' retired into fleet (no "not configured"
    // empty state anymore, it just opens Fleet); 'eval' was deleted
    // outright (DELETE-disposition, no surviving human surface).
    expect(ids).not.toContain('eval');
    expect(manager.open('incident')).toBe(manager.open('fleet'));
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

  test('subscription command opens the subscription config modal', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const subscription = registry.get('subscription');
    expect(subscription).toBeDefined();

    // the subscription panel migrated to a config-modal surface, the bare
    // command now opens it via ctx.openModal, not ctx.openSubscriptionPanel.
    let openedModal: string | null = null;
    await subscription!.handler([], makeCommandContext('sess-subscription-panel', {
      openModal: (name: string) => {
        openedModal = name;
      },
    }));

    expect(openedModal as string | null).toBe('subscription-modal');
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

  test('project-memory open subcommand calls openMemoryPanel, not openKnowledgePanel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const pmem = registry.get('project-memory');
    expect(pmem).toBeDefined();

    let memoryOpened = false;
    let knowledgeOpened = false;
    await pmem!.handler(['open'], makeCommandContext('sess-pmem-panel', {
      openMemoryPanel: () => {
        memoryOpened = true;
      },
      openKnowledgePanel: () => {
        knowledgeOpened = true;
      },
    }));

    expect(memoryOpened).toBe(true);
    expect(knowledgeOpened).toBe(false);
  });

  test('project-memory alias pmem open subcommand calls openMemoryPanel', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const pmem = registry.get('pmem');
    expect(pmem).toBeDefined();

    let memoryOpened = false;
    await pmem!.handler(['open'], makeCommandContext('sess-pmem-alias-panel', {
      openMemoryPanel: () => {
        memoryOpened = true;
      },
    }));

    expect(memoryOpened).toBe(true);
  });

  test('remote command opens the remote config modal', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const remote = registry.get('remote');
    expect(remote).toBeDefined();

    // the remote panel migrated to a config-modal surface, the bare
    // command now opens it via ctx.openModal, not ctx.openRemotePanel.
    let openedModal: string | null = null;
    await remote!.handler([], makeCommandContext('sess-remote-panel', {
      openModal: (name: string) => {
        openedModal = name;
      },
    }));

    expect(openedModal as string | null).toBe('remote-modal');
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

  test('mcp command opens the fullscreen mcp workspace when no subcommand is supplied', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const mcp = registry.get('mcp');
    expect(mcp).toBeDefined();

    let opened = false;
    await mcp!.handler([], makeCommandContext('sess-mcp-workspace', {
      openMcpWorkspace: () => {
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
