import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { SecretsManager } from '../config/secrets.ts';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { AutomationDeliveryManager, AutomationManager, AutomationRouteStore } from '@pellux/goodvibes-sdk/platform/automation/index';
import { ChannelPluginRegistry, ChannelPolicyManager, RouteBindingManager, SurfaceRegistry } from '@pellux/goodvibes-sdk/platform/channels/index';
import { ChannelDeliveryRouter } from '@pellux/goodvibes-sdk/platform/channels/delivery-router';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers/index';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import { KnowledgeService, KnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '@pellux/goodvibes-sdk/platform/media/index';
import { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal/index';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents/message-bus';
import { WrfcController } from '@pellux/goodvibes-sdk/platform/agents/wrfc-controller';
import { AgentOrchestrator } from '@pellux/goodvibes-sdk/platform/agents/orchestrator';
import { ArchetypeLoader } from '@pellux/goodvibes-sdk/platform/agents/archetypes';
import { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools/shared/process-manager';
import { ModeManager } from '@pellux/goodvibes-sdk/platform/state/mode-manager';
import { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state/file-undo';
import { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/memory-registry';
import { MemoryStore } from '@pellux/goodvibes-sdk/platform/state/memory-store';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { createDomainDispatch } from './store/index.ts';
import type { DomainDispatch, RuntimeStore } from './store/index.ts';
import { DistributedRuntimeManager } from '@pellux/goodvibes-sdk/platform/runtime/remote/distributed-runtime-manager';
import { RemoteRunnerRegistry, RemoteSupervisor } from '@pellux/goodvibes-sdk/platform/runtime/remote/index';
import { IntegrationHelperService } from '@pellux/goodvibes-sdk/platform/runtime/integration/helpers';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '@pellux/goodvibes-sdk/platform/voice/index';
import { WebSearchProviderRegistry, WebSearchService } from '@pellux/goodvibes-sdk/platform/web-search/index';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state/memory-embeddings';
import { PanelManager } from '../panels/panel-manager.ts';
import { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks/activity';
import { HookDispatcher, createHookWorkbench, type HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks/index';
import { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins/manager';
import { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks/manager';
import { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles/manager';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions/manager';
import { CrossSessionTaskRegistry } from '@pellux/goodvibes-sdk/platform/sessions/orchestration/index';
import { ApiTokenAuditor } from '@pellux/goodvibes-sdk/platform/security/token-audit';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations/webhooks';
import { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp/registry';
import { DeterministicReplayEngine } from '@pellux/goodvibes-sdk/platform/core/deterministic-replay';
import { ProviderOptimizer } from '@pellux/goodvibes-sdk/platform/providers/optimizer';
import { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import { ProviderCapabilityRegistry } from '@pellux/goodvibes-sdk/platform/providers/capabilities';
import { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import { FavoritesStore } from '@pellux/goodvibes-sdk/platform/providers/favorites';
import { BenchmarkStore } from '@pellux/goodvibes-sdk/platform/providers/model-benchmarks';
import { ModelLimitsService } from '@pellux/goodvibes-sdk/platform/providers/model-limits';
import { KeybindingsManager } from '../input/keybindings.ts';
import { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core/session-memory';
import { SessionLineageTracker } from '@pellux/goodvibes-sdk/platform/core/session-lineage';
import { SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions/change-tracker';
import { ExecutionPlanManager } from '@pellux/goodvibes-sdk/platform/core/execution-plan';
import { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
import { FileStateCache } from '@pellux/goodvibes-sdk/platform/state/file-cache';
import { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state/project-index';
import { IdempotencyStore } from '@pellux/goodvibes-sdk/platform/runtime/idempotency/index';
import { OverflowHandler } from '@pellux/goodvibes-sdk/platform/tools/shared/overflow';
import { ToolLLM } from '@pellux/goodvibes-sdk/platform/config/tool-llm';
import { ComponentHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/component-health-monitor';
import { WorktreeRegistry } from '@pellux/goodvibes-sdk/platform/runtime/worktree/registry';
import { SandboxSessionRegistry } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/session-registry';
import { createShellPathService, type ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import type { FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';
import { createFeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';
import { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';
import {
  createWorkflowServices,
  type WorkflowServices,
} from '@pellux/goodvibes-sdk/platform/tools/workflow/index';

export interface RuntimeServicesOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly featureFlags?: FeatureFlagManager;
  readonly getConversationTitle?: () => string | undefined;
  readonly workingDir: string;
  readonly homeDirectory: string;
}

export interface RuntimeServices {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly shellPaths: ShellPathService;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeDispatch: DomainDispatch;
  readonly panelManager: PanelManager;
  readonly keybindingsManager: KeybindingsManager;
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelDeliveryRouter: ChannelDeliveryRouter;
  readonly watcherRegistry: WatcherRegistry;
  readonly approvalBroker: ApprovalBroker;
  readonly sessionBroker: SharedSessionBroker;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly automationManager: AutomationManager;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly artifactStore: ArtifactStore;
  readonly knowledgeService: KnowledgeService;
  readonly memoryStore: MemoryStore;
  readonly memoryRegistry: MemoryRegistry;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  readonly subscriptionManager: SubscriptionManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly profileManager: ProfileManager;
  readonly bookmarkManager: BookmarkManager;
  readonly sessionManager: SessionManager;
  readonly sessionOrchestration: CrossSessionTaskRegistry;
  readonly hookDispatcher: HookDispatcher;
  readonly hookActivityTracker: HookActivityTracker;
  readonly hookWorkbench: HookWorkbench;
  readonly pluginManager: PluginManager;
  readonly workflow: WorkflowServices;
  readonly voiceProviders: VoiceProviderRegistry;
  readonly voiceService: VoiceService;
  readonly webSearchProviders: WebSearchProviderRegistry;
  readonly webSearchService: WebSearchService;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly channelPolicy: ChannelPolicyManager;
  readonly mcpRegistry: McpRegistry;
  readonly tokenAuditor: ApiTokenAuditor;
  readonly componentHealthMonitor: ComponentHealthMonitor;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly webhookNotifier: WebhookNotifier;
  readonly replayEngine: DeterministicReplayEngine;
  readonly providerOptimizer: ProviderOptimizer;
  readonly providerCapabilityRegistry: ProviderCapabilityRegistry;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly modelLimitsService: ModelLimitsService;
  readonly providerRegistry: ProviderRegistry;
  readonly toolLLM: ToolLLM;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly sessionLineageTracker: SessionLineageTracker;
  readonly sessionChangeTracker: SessionChangeTracker;
  readonly planManager: ExecutionPlanManager;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly idempotencyStore: IdempotencyStore;
  readonly overflowHandler: OverflowHandler;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly wrfcController: WrfcController;
  readonly processManager: ProcessManager;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly integrationHelpers: IntegrationHelperService;
  /**
   * Re-root path-bound stores (MemoryStore, ProjectIndex) to a new working directory.
   * Called by WorkspaceSwapManager after the new directory has been verified.
   * Stores that require a process restart emit a warn-level log; they continue serving
   * the old path until the daemon restarts with the new --working-dir.
   */
  rerootStores(newWorkingDir: string): Promise<void>;
}

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const shellPaths = createShellPathService({
    workingDirectory,
    homeDirectory,
  });
  const configManager = options.configManager;
  const featureFlags = options.featureFlags ?? createFeatureFlagManager();
  const runtimeDispatch = createDomainDispatch(options.runtimeStore);
  const gatewayMethods = new GatewayMethodCatalog();
  const panelManager = new PanelManager();
  const keybindingsManager = new KeybindingsManager({
    configPath: shellPaths.resolveUserPath('tui', 'keybindings.json'),
  });
  const routeBindings = new RouteBindingManager({
    store: new AutomationRouteStore({ configManager }),
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  const surfaceRegistry = new SurfaceRegistry(configManager, options.runtimeStore);
  const channelPlugins = new ChannelPluginRegistry();
  surfaceRegistry.attachPluginRegistry(channelPlugins);
  const secretsManager = new SecretsManager({
    projectRoot: workingDirectory,
    globalHome: homeDirectory,
    configManager,
  });
  const subscriptionManager = new SubscriptionManager(
    shellPaths.resolveUserPath('tui', 'subscriptions.json'),
  );
  const serviceRegistry = new ServiceRegistry(shellPaths.resolveProjectPath('tui', 'services.json'), {
    secretsManager,
    subscriptionManager,
  });
  const providerCapabilityRegistry = new ProviderCapabilityRegistry();
  const cacheHitTracker = new CacheHitTracker();
  const favoritesStore = new FavoritesStore({ dir: shellPaths.resolveUserPath('tui') });
  const benchmarkStore = new BenchmarkStore({ dir: shellPaths.resolveUserPath('tui') });
  const modelLimitsService = new ModelLimitsService({
    cachePath: shellPaths.resolveUserPath('tui', 'model-limits.json'),
  });
  const providerRegistry = new ProviderRegistry({
    configManager,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    capabilityRegistry: providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    featureFlags,
    runtimeBus: options.runtimeBus,
  });
  providerRegistry.initCustomProviders();
  const toolLLM = new ToolLLM({
    configManager,
    providerRegistry,
  });
  const localUserAuthManager = options.localUserAuthManager ?? new UserAuthManager({
    bootstrapFilePath: shellPaths.resolveUserPath('tui', 'auth-users.json'),
    bootstrapCredentialPath: shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt'),
  });
  const profileManager = new ProfileManager(shellPaths.resolveUserPath('tui', 'profiles'));
  const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath('tui', 'bookmarks'));
  const sessionManager = new SessionManager(workingDirectory, { surfaceRoot: 'tui' });
  const sessionOrchestration = new CrossSessionTaskRegistry(
    shellPaths.resolveProjectPath('tui', 'sessions', 'task-graph.json'),
  );
  const hookActivityTracker = new HookActivityTracker();
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath('tui', 'watchers.json'),
  });
  watcherRegistry.attachRuntime({
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  const agentMessageBus = new AgentMessageBus();
  agentMessageBus.setRuntimeBus(options.runtimeBus);
  const archetypeLoader = new ArchetypeLoader(join(workingDirectory, '.goodvibes', 'agents'));
  const agentOrchestrator = new AgentOrchestrator({
    messageBus: agentMessageBus,
  });
  agentOrchestrator.setRuntimeBus(options.runtimeBus);
  const agentManager = new AgentManager({
    archetypeLoader,
    messageBus: agentMessageBus,
    executor: agentOrchestrator,
    configManager,
  });
  agentManager.setRuntimeBus(options.runtimeBus);
  const wrfcController = new WrfcController(options.runtimeBus, agentMessageBus, {
    agentManager,
    configManager,
    projectRoot: workingDirectory,
  });
  agentManager.setWrfcController(wrfcController);
  const hookDispatcher = new HookDispatcher({ agentManager, toolLLM, projectRoot: workingDirectory }, hookActivityTracker);
  configManager.attachHookDispatcher(hookDispatcher);
  const hookWorkbench = createHookWorkbench({
    hookDispatcher,
    configManager,
  });
  const approvalBroker = new ApprovalBroker({
    storePath: shellPaths.resolveProjectPath('tui', 'control-plane', 'approvals.json'),
  });
  const sessionBroker = new SharedSessionBroker({
    storePath: shellPaths.resolveProjectPath('tui', 'control-plane', 'sessions.json'),
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
  });
  sessionBroker.setContinuationRunner(async ({ task, input }) => {
    const record = agentManager.spawn({
      mode: 'spawn',
      task,
      ...(input.routing?.modelId ? { model: input.routing.modelId } : {}),
      ...(input.routing?.providerId ? { provider: input.routing.providerId } : {}),
      ...(input.routing?.tools?.length ? { tools: [...input.routing.tools], restrictTools: true } : {}),
      ...(input.routing
        ? {
            routing: {
              providerSelection: input.routing.providerSelection ?? (input.routing.providerId ? 'concrete' : 'inherit-current'),
              unresolvedModelPolicy: input.routing.unresolvedModelPolicy ?? 'fallback-to-current',
              providerFailurePolicy: input.routing.providerFailurePolicy ?? 'ordered-fallbacks',
              ...(input.routing.fallbackModels?.length ? { fallbackModels: [...input.routing.fallbackModels] } : {}),
            },
          }
        : {}),
      ...(input.routing?.reasoningEffort ? { reasoningEffort: input.routing.reasoningEffort } : {}),
      context: `shared-session:${input.sessionId}`,
    });
    return { agentId: record.id };
  });
  const artifactStore = new ArtifactStore({ configManager });
  const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const memoryDbPath = join(workingDirectory, '.goodvibes', 'tui', 'memory.sqlite');
  const memoryStore = new MemoryStore(memoryDbPath, {
    embeddingRegistry: memoryEmbeddingRegistry,
  });
  const memoryRegistry = new MemoryRegistry(memoryStore);
  const deliveryManager = new AutomationDeliveryManager({
    configManager,
    serviceRegistry,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    routeBindings,
    artifactStore,
  });
  const automationManager = new AutomationManager({
    configManager,
    defaultSurfaceKind: 'tui',
    routeBindings,
    sessionBroker,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    deliveryManager,
    spawnTask: (input) => {
      const record = agentManager.spawn({
        mode: 'spawn',
        task: input.prompt,
        ...(input.modelId ? { model: input.modelId } : {}),
        ...(input.modelProvider ? { provider: input.modelProvider } : {}),
        ...(input.fallbackModels !== undefined ? { fallbackModels: [...input.fallbackModels] } : {}),
        ...(input.routing ? { routing: input.routing } : {}),
        ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
        ...(input.template ? { template: input.template } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.toolAllowlist?.length ? { tools: [...input.toolAllowlist], restrictTools: true } : {}),
        ...(input.context ? { context: input.context } : {}),
      });
      return record.id;
    },
  });
  const knowledgeStore = new KnowledgeStore({ configManager });
  const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
  });
  knowledgeService.attachRuntimeBus(options.runtimeBus);
  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders);
  const voiceService = new VoiceService(voiceProviders);
  const webSearchProviders = new WebSearchProviderRegistry({
    env: process.env,
    serviceRegistry,
  });
  const webSearchService = new WebSearchService(webSearchProviders, {
    serviceRegistry,
    featureFlags,
  });
  const mediaProviders = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry);
  const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, knowledgeService);
  const pluginManager = new PluginManager({
    pathOptions: {
      cwd: shellPaths.workingDirectory,
      homeDir: shellPaths.homeDirectory,
    },
    stateFilePath: shellPaths.resolveUserPath('tui', 'plugins.json'),
  });
  const workflow = createWorkflowServices();
  hookDispatcher.setTriggerManager(workflow.triggerManager);
  const channelPolicy = new ChannelPolicyManager({
    storePath: shellPaths.resolveProjectPath('tui', 'channels', 'policies.json'),
  });
  const distributedRuntime = new DistributedRuntimeManager(
    shellPaths.resolveProjectPath('tui', 'remote', 'distributed-runtime.json'),
  );
  distributedRuntime.attachRuntime({
    sessionBridge: sessionBroker,
    approvalBridge: approvalBroker,
    automationBridge: automationManager,
  });
  const remoteRunnerRegistry = new RemoteRunnerRegistry(agentManager);
  const remoteSupervisor = new RemoteSupervisor(remoteRunnerRegistry);
  const sandboxSessionRegistry = new SandboxSessionRegistry(workingDirectory);
  const mcpRegistry = new McpRegistry({
    hookDispatcher,
    sandboxSessions: sandboxSessionRegistry,
  });
  mcpRegistry.setRuntimeBus(options.runtimeBus);
  mcpRegistry.setSandboxRuntime(configManager, sandboxSessionRegistry);
  const tokenAuditor = new ApiTokenAuditor({ managed: false });
  const componentHealthMonitor = new ComponentHealthMonitor();
  const worktreeRegistry = new WorktreeRegistry(workingDirectory);
  const webhookNotifier = new WebhookNotifier();
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  const providerOptimizer = new ProviderOptimizer(providerRegistry, providerCapabilityRegistry, false);
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker();
  const sessionChangeTracker = new SessionChangeTracker();
  const planManager = new ExecutionPlanManager(workingDirectory);
  const adaptivePlanner = new AdaptivePlanner();
  const idempotencyStore = new IdempotencyStore();
  const overflowHandler = new OverflowHandler({ baseDir: workingDirectory });
  const policyRuntimeState = new PolicyRuntimeState();
  const fileCache = new FileStateCache();
  const projectIndex = new ProjectIndex(workingDirectory);
  const channelDeliveryRouter = new ChannelDeliveryRouter({
    configManager,
    serviceRegistry,
    artifactStore,
  });
  const processManager = new ProcessManager();
  const modeManager = new ModeManager();
  const fileUndoManager = new FileUndoManager();
  const integrationHelpers = new IntegrationHelperService({
    workingDirectory,
    homeDirectory,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    configManager,
    getConversationTitle: options.getConversationTitle,
    automationManager,
    approvalBroker,
    sessionBroker,
    distributedRuntime,
    remoteRunnerRegistry,
    remoteSupervisor,
    panelManager,
    localUserAuthManager,
    providerRegistry,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
  });
  agentOrchestrator.setDependencies({
    surfaceRoot: 'tui',
    fileCache,
    projectIndex,
    workingDirectory,
    fileUndoManager,
    modeManager,
    processManager,
    agentMessageBus,
    webSearchService,
    channelRegistry: channelPlugins,
    remoteRunnerRegistry,
    knowledgeService,
    memoryRegistry,
    archetypeLoader,
    configManager,
    providerRegistry,
    providerOptimizer,
    toolLLM,
    serviceRegistry,
    sessionOrchestration,
    featureFlags,
    overflowHandler,
    sandboxSessionRegistry,
    workflowServices: workflow,
  });

  return {
    workingDirectory,
    homeDirectory,
    shellPaths,
    configManager,
    featureFlags,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    runtimeDispatch,
    panelManager,
    keybindingsManager,
    routeBindings,
    surfaceRegistry,
    channelPlugins,
    channelDeliveryRouter,
    watcherRegistry,
    approvalBroker,
    sessionBroker,
    deliveryManager,
    automationManager,
    gatewayMethods,
    artifactStore,
    knowledgeService,
    memoryStore,
    memoryRegistry,
    serviceRegistry,
    secretsManager,
    subscriptionManager,
    localUserAuthManager,
    profileManager,
    bookmarkManager,
    sessionManager,
    sessionOrchestration,
    hookDispatcher,
    hookActivityTracker,
    hookWorkbench,
    pluginManager,
    workflow,
    voiceProviders,
    voiceService,
    webSearchProviders,
    webSearchService,
    mediaProviders,
    multimodalService,
    memoryEmbeddingRegistry,
    channelPolicy,
    mcpRegistry,
    tokenAuditor,
    componentHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
    webhookNotifier,
    replayEngine,
    providerOptimizer,
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    providerRegistry,
    toolLLM,
    distributedRuntime,
    remoteRunnerRegistry,
    remoteSupervisor,
    sessionMemoryStore,
    sessionLineageTracker,
    sessionChangeTracker,
    planManager,
    adaptivePlanner,
    idempotencyStore,
    overflowHandler,
    policyRuntimeState,
    archetypeLoader,
    agentManager,
    agentMessageBus,
    agentOrchestrator,
    wrfcController,
    processManager,
    modeManager,
    fileUndoManager,
    integrationHelpers,
    async rerootStores(newWorkingDir: string): Promise<void> {
      const newMemoryDbPath = join(newWorkingDir, '.goodvibes', 'tui', 'memory.sqlite');
      await memoryStore.reroot(newMemoryDbPath);
      await projectIndex.reroot(newWorkingDir);
    },
  };
}
