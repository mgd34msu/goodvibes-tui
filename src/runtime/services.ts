import { join } from 'node:path';
import { ConfigManager } from '../config/manager.ts';
import { SecretsManager } from '../config/secrets.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import { SubscriptionManager } from '../config/subscriptions.ts';
import { AutomationDeliveryManager, AutomationManager } from '../automation/index.ts';
import { ChannelPluginRegistry, ChannelPolicyManager, RouteBindingManager, SurfaceRegistry } from '../channels/index.ts';
import { ChannelDeliveryRouter } from '../channels/delivery-router.ts';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker } from '../control-plane/index.ts';
import { WatcherRegistry } from '../watchers/index.ts';
import { ArtifactStore } from '../artifacts/index.ts';
import { KnowledgeService, KnowledgeStore } from '../knowledge/index.ts';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '../media/index.ts';
import { MultimodalService } from '../multimodal/index.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { AgentMessageBus } from '../agents/message-bus.ts';
import { WrfcController } from '../agents/wrfc-controller.ts';
import { AgentOrchestrator } from '../agents/orchestrator.ts';
import { ArchetypeLoader } from '../agents/archetypes.ts';
import { ProcessManager } from '../tools/shared/process-manager.ts';
import { ModeManager } from '../state/mode-manager.ts';
import { FileUndoManager } from '../state/file-undo.ts';
import { MemoryRegistry } from '../state/memory-registry.ts';
import { MemoryStore } from '../state/memory-store.ts';
import type { RuntimeEventBus } from './events/index.ts';
import { createDomainDispatch } from './store/index.ts';
import type { DomainDispatch, RuntimeStore } from './store/index.ts';
import { DistributedRuntimeManager } from './remote/distributed-runtime-manager.ts';
import { RemoteRunnerRegistry, RemoteSupervisor } from './remote/index.ts';
import { IntegrationHelperService } from './integration/helpers.ts';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '../voice/index.ts';
import { WebSearchProviderRegistry, WebSearchService } from '../web-search/index.ts';
import { MemoryEmbeddingProviderRegistry } from '../state/memory-embeddings.ts';
import { PanelManager } from '../panels/panel-manager.ts';
import { HookActivityTracker } from '../hooks/activity.ts';
import { HookDispatcher, createHookWorkbench, type HookWorkbench } from '../hooks/index.ts';
import { PluginManager } from '../plugins/manager.ts';
import { BookmarkManager } from '../bookmarks/manager.ts';
import { ProfileManager } from '../profiles/manager.ts';
import { SessionManager } from '../sessions/manager.ts';
import { CrossSessionTaskRegistry } from '../sessions/orchestration/index.ts';
import { ApiTokenAuditor } from '../security/token-audit.ts';
import { UserAuthManager } from '../security/user-auth.ts';
import { WebhookNotifier } from '../integrations/webhooks.ts';
import { McpRegistry } from '../mcp/registry.ts';
import { DeterministicReplayEngine } from '../core/deterministic-replay.ts';
import { ProviderOptimizer } from '../providers/optimizer.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { ProviderCapabilityRegistry } from '../providers/capabilities.ts';
import { CacheHitTracker } from '../providers/cache-strategy.ts';
import { FavoritesStore } from '../providers/favorites.ts';
import { BenchmarkStore } from '../providers/model-benchmarks.ts';
import { ModelLimitsService } from '../providers/model-limits.ts';
import { KeybindingsManager } from '../input/keybindings.ts';
import { SessionMemoryStore } from '../core/session-memory.ts';
import { SessionLineageTracker } from '../core/session-lineage.ts';
import { SessionChangeTracker } from '../sessions/change-tracker.ts';
import { ExecutionPlanManager } from '../core/execution-plan.ts';
import { AdaptivePlanner } from '../core/adaptive-planner.ts';
import { FileStateCache } from '../state/file-cache.ts';
import { ProjectIndex } from '../state/project-index.ts';
import { IdempotencyStore } from './idempotency/index.ts';
import { OverflowHandler } from '../tools/shared/overflow.ts';
import { ToolLLM } from '../config/tool-llm.ts';
import { PanelHealthMonitor } from './perf/panel-health-monitor.ts';
import { WorktreeRegistry } from './worktree/registry.ts';
import { SandboxSessionRegistry } from './sandbox/session-registry.ts';
import type { FeatureFlagManager } from './feature-flags/index.ts';
import { createFeatureFlagManager } from './feature-flags/index.ts';
import { PolicyRuntimeState } from './permissions/policy-runtime.ts';
import {
  createWorkflowServices,
  type WorkflowServices,
} from '../tools/workflow/index.ts';

export interface RuntimeServicesOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager?: ConfigManager;
  readonly featureFlags?: FeatureFlagManager;
  readonly getConversationTitle?: () => string | undefined;
  readonly workingDir?: string;
}

export interface RuntimeServices {
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
  readonly panelHealthMonitor: PanelHealthMonitor;
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
}

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  const configManager = options.configManager ?? new ConfigManager();
  const featureFlags = options.featureFlags ?? createFeatureFlagManager();
  const runtimeDispatch = createDomainDispatch(options.runtimeStore);
  const gatewayMethods = new GatewayMethodCatalog();
  const panelManager = new PanelManager();
  const keybindingsManager = new KeybindingsManager();
  const routeBindings = new RouteBindingManager({
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  const surfaceRegistry = new SurfaceRegistry(configManager, options.runtimeStore);
  const channelPlugins = new ChannelPluginRegistry();
  surfaceRegistry.attachPluginRegistry(channelPlugins);
  const secretsManager = new SecretsManager({
    projectRoot: options.workingDir ?? process.cwd(),
  });
  const subscriptionManager = new SubscriptionManager();
  const serviceRegistry = new ServiceRegistry(undefined, {
    secretsManager,
    subscriptionManager,
  });
  const providerCapabilityRegistry = new ProviderCapabilityRegistry();
  const cacheHitTracker = new CacheHitTracker();
  const favoritesStore = new FavoritesStore();
  const benchmarkStore = new BenchmarkStore();
  const modelLimitsService = new ModelLimitsService();
  const providerRegistry = new ProviderRegistry({
    configManager,
    subscriptionManager,
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
  const localUserAuthManager = new UserAuthManager();
  const profileManager = new ProfileManager();
  const bookmarkManager = new BookmarkManager();
  const sessionManager = new SessionManager(options.workingDir);
  const sessionOrchestration = new CrossSessionTaskRegistry(options.workingDir);
  const hookActivityTracker = new HookActivityTracker();
  const watcherRegistry = new WatcherRegistry();
  watcherRegistry.attachRuntime({
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  const agentMessageBus = new AgentMessageBus();
  agentMessageBus.setRuntimeBus(options.runtimeBus);
  const archetypeLoader = new ArchetypeLoader();
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
  });
  agentManager.setWrfcController(wrfcController);
  const hookDispatcher = new HookDispatcher({ agentManager, toolLLM }, hookActivityTracker);
  configManager.attachHookDispatcher(hookDispatcher);
  const hookWorkbench = createHookWorkbench({
    hookDispatcher,
    configManager,
  });
  const approvalBroker = new ApprovalBroker();
  const sessionBroker = new SharedSessionBroker({
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
  });
  const artifactStore = new ArtifactStore({ configManager });
  const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const memoryDbPath = join(options.workingDir ?? process.cwd(), '.goodvibes', 'tui', 'memory.sqlite');
  const memoryStore = new MemoryStore(memoryDbPath, {
    embeddingRegistry: memoryEmbeddingRegistry,
  });
  const memoryRegistry = new MemoryRegistry(memoryStore);
  const deliveryManager = new AutomationDeliveryManager({
    configManager,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    routeBindings,
    artifactStore,
  });
  const automationManager = new AutomationManager({
    configManager,
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
  const webSearchProviders = new WebSearchProviderRegistry();
  const webSearchService = new WebSearchService(webSearchProviders, {
    serviceRegistry,
    featureFlags,
  });
  const mediaProviders = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry);
  const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, knowledgeService);
  const pluginManager = new PluginManager();
  const workflow = createWorkflowServices();
  hookDispatcher.setTriggerManager(workflow.triggerManager);
  const channelPolicy = new ChannelPolicyManager();
  const distributedRuntime = new DistributedRuntimeManager();
  distributedRuntime.attachRuntime({
    sessionBridge: sessionBroker,
    approvalBridge: approvalBroker,
    automationBridge: automationManager,
  });
  const remoteRunnerRegistry = new RemoteRunnerRegistry(agentManager);
  const remoteSupervisor = new RemoteSupervisor(remoteRunnerRegistry);
  const sandboxSessionRegistry = new SandboxSessionRegistry();
  const mcpRegistry = new McpRegistry({
    hookDispatcher,
    sandboxSessions: sandboxSessionRegistry,
  });
  mcpRegistry.setRuntimeBus(options.runtimeBus);
  mcpRegistry.setSandboxRuntime(configManager, sandboxSessionRegistry);
  const tokenAuditor = new ApiTokenAuditor({ managed: false });
  const panelHealthMonitor = new PanelHealthMonitor();
  const worktreeRegistry = new WorktreeRegistry(options.workingDir);
  const webhookNotifier = new WebhookNotifier();
  const replayEngine = new DeterministicReplayEngine();
  const providerOptimizer = new ProviderOptimizer(providerRegistry, providerCapabilityRegistry, false);
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker();
  const sessionChangeTracker = new SessionChangeTracker();
  const planManager = new ExecutionPlanManager(options.workingDir);
  const adaptivePlanner = new AdaptivePlanner();
  const idempotencyStore = new IdempotencyStore();
  const overflowHandler = new OverflowHandler();
  const policyRuntimeState = new PolicyRuntimeState();
  const fileCache = new FileStateCache();
  const projectIndex = new ProjectIndex(options.workingDir);
  const channelDeliveryRouter = new ChannelDeliveryRouter({
    configManager,
    serviceRegistry,
    artifactStore,
  });
  const processManager = new ProcessManager();
  const modeManager = new ModeManager();
  const fileUndoManager = new FileUndoManager();
  const integrationHelpers = new IntegrationHelperService({
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
    fileCache,
    projectIndex,
    fileUndoManager,
    modeManager,
    processManager,
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
    featureFlags,
    overflowHandler,
    sandboxSessionRegistry,
  });

  return {
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
    panelHealthMonitor,
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
  };
}
