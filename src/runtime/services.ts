import { join } from 'node:path';
import { FocusTracker } from '../core/focus-tracker.ts';
import { ConfigManager, ServiceRegistry, SubscriptionManager, ToolLLM } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../config/secrets.ts';
import { AutomationDeliveryManager, AutomationManager, AutomationRouteStore } from '@pellux/goodvibes-sdk/platform/automation';
import { ChannelDeliveryRouter, ChannelPluginRegistry, ChannelPolicyManager, RouteBindingManager, SurfaceRegistry } from '@pellux/goodvibes-sdk/platform/channels';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import { attachWsOnlyGatewayVerbHandlers, createArchivableFleetRegistry } from '@pellux/goodvibes-terminal-shell';
import { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts';
import {
  HomeGraphService,
  GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  HOME_GRAPH_KNOWLEDGE_EXTENSION,
  KnowledgeService,
  KnowledgeSemanticService,
  KnowledgeStore,
  ProjectPlanningService,
  createProviderBackedKnowledgeSemanticLlm,
  createWebKnowledgeGapRepairer,
  projectPlanningProjectIdFromPath,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '@pellux/goodvibes-sdk/platform/media';
import { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal';
import { AgentMessageBus, AgentOrchestrator, ArchetypeLoader, WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { AgentManager, OverflowHandler, ProcessManager, createWorkflowServices, type WorkflowServices } from '@pellux/goodvibes-sdk/platform/tools';
import { FileStateCache, FileUndoManager, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, ModeManager, ProjectIndex, resolveCanonicalMemoryDbPath, type CodeIndexStore, type CodeIndexReindexScheduler } from '@pellux/goodvibes-sdk/platform/state';
import { MemorySpineClient, createLocalMemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import { withCheckpointGuardSettings } from '../config/tui-extension-settings.ts';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { createDomainDispatch } from './store/index.ts';
import type { DomainDispatch, RuntimeStore } from './store/index.ts';
import { DistributedRuntimeManager } from '@/runtime/index.ts';
import { RemoteRunnerRegistry, RemoteSupervisor } from '@/runtime/index.ts';
import { IntegrationHelperService } from '@/runtime/index.ts';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '@pellux/goodvibes-sdk/platform/voice';
import { WebSearchProviderRegistry, WebSearchService } from '@pellux/goodvibes-sdk/platform/web-search';
import { PanelManager } from '../panels/panel-manager.ts';
import { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks';
import { HookDispatcher, createHookWorkbench, type HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins';
import { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks';
import { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles';
import { SessionManager, CrossSessionTaskRegistry, SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions';
import { ApiTokenAuditor, UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { BenchmarkStore, CacheHitTracker, FavoritesStore, inferFallbackContextWindow, type ModelDefinition, ModelLimitsService, ProviderCapabilityRegistry, ProviderOptimizer, ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { KeybindingsManager } from '../input/keybindings.ts';
import { AdaptivePlanner, DeterministicReplayEngine, ExecutionPlanManager, SessionLineageTracker, SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import { IdempotencyStore } from '@/runtime/index.ts';
import { ComponentHealthMonitor } from '@/runtime/index.ts';
import { WorktreeRegistry } from '@/runtime/index.ts';
import { SandboxSessionRegistry } from '@/runtime/index.ts';
import { createShellPathService, type ShellPathService } from '@/runtime/index.ts';
import { isFeatureFlagEnabled } from './surface-feature-flags.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { type ArchivableProcessRegistry } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { calcSessionCost, isModelPriced } from '../export/cost-utils.ts';
import { createWorkstreamServices, type OrchestrationEngine, type WorkstreamCommandService } from './workstream-services.ts';
import { codeIndexDbPath, createCodeIndexServices, isCodeInjectionSettingEnabled } from './code-index-services.ts';
import { WorkPlanStore } from '../work-plans/work-plan-store.ts';
import {
  registerDaemonHandlers,
  type DaemonHandlerSurfaces,
} from '../daemon/handlers/index.ts';
import type { HandlerContext, HandlerLogger } from '../daemon/handlers/context.ts';
import { createDaemonCredentialStore } from '../daemon/handlers/credentials.ts';
import { registerRouting } from '../daemon/handlers/routing/index.ts';
import { registerInboxMethods } from '../daemon/handlers/inbox/index.ts';
import { registerTriagedInbox } from '../daemon/handlers/triage/index.ts';
import { registerDraftMethods } from '../daemon/handlers/drafts/index.ts';
import { registerCalendar } from '../daemon/handlers/calendar/index.ts';
import { registerEmailMethods } from '../daemon/handlers/email/index.ts';
import { registerRemoteSurface } from '../daemon/handlers/remote/index.ts';

const REGULAR_KNOWLEDGE_DB_FILE = 'knowledge-wiki.sqlite';
const HOME_GRAPH_KNOWLEDGE_DB_FILE = 'knowledge-home-graph.sqlite';

function buildFallbackModelDefinition(provider: string, modelId: string): ModelDefinition {
  const providerLower = provider.toLowerCase();
  const isReasoningProvider = providerLower.includes('openai')
    || providerLower.includes('anthropic')
    || providerLower.includes('gemini')
    || providerLower.includes('google');

  return {
    id: modelId,
    provider,
    registryKey: `${provider}:${modelId}`,
    displayName: modelId,
    description: 'Configured model available before the model catalog cache has loaded.',
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: isReasoningProvider,
      multimodal: isReasoningProvider,
    },
    // Pre-catalog fallback uses the SDK's family-aware inference (SDK 0.35.0+),
    // matching the post-catalog window so the meter/compaction denominator agrees.
    contextWindow: inferFallbackContextWindow(provider, modelId),
    contextWindowProvenance: 'fallback',
    selectable: true,
    tier: 'standard',
    ...(isReasoningProvider ? { reasoningEffort: ['instant', 'low', 'medium', 'high'] } : {}),
  };
}

function ensureConfiguredModelIsRoutable(providerRegistry: ProviderRegistry, configManager: ConfigManager): void {
  const configuredModel = String(configManager.get('provider.model') ?? '').trim();
  if (!configuredModel.includes(':')) return;
  if (providerRegistry.listModels().some((model) => model.registryKey === configuredModel)) return;

  const [providerId, ...modelParts] = configuredModel.split(':');
  const modelId = modelParts.join(':').trim();
  if (!providerId || !modelId) return;

  const provider = providerRegistry.tryGet(providerId);
  if (!provider) return;

  providerRegistry.registerRuntimeProvider({
    provider,
    replace: true,
    models: [buildFallbackModelDefinition(providerId, modelId)],
  });
}

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
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  readonly workPlanStore: WorkPlanStore;
  readonly memoryStore: MemoryStore;
  readonly memoryRegistry: MemoryRegistry;
  /** Host-vs-client memory access: local until bootstrap.ts activates it for an adopted 'external' daemon (mirrors sessionSpine). */
  readonly memorySpine: MemorySpineClient;
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
  /** Terminal focus tracker (W2.3) — fed by input/handler-feed.ts, read by the alert notifiers in core/. */
  readonly focusTracker: FocusTracker;
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
  readonly daemonHandlers: DaemonHandlerSurfaces;
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
  /** The phase/work-item orchestration engine — see runtime/workstream-services.ts. */
  readonly orchestrationEngine: OrchestrationEngine;
  readonly workstreamCommands: WorkstreamCommandService;
  /** The repo source-tree code index — see runtime/code-index-services.ts. */
  readonly codeIndexStore: CodeIndexStore;
  readonly codeIndexReindexScheduler: CodeIndexReindexScheduler; // tool-site reindex
  /** Unified live process registry (agents, WRFC chains, workflows, watchers, background processes) backing the Fleet panel; archive-aware — finished subtrees can be moved to the session archive view. */
  readonly processRegistry: ArchivableProcessRegistry;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager: WorkspaceCheckpointManager;
  readonly integrationHelpers: IntegrationHelperService;
  /** Re-root path-bound stores (MemoryStore, ProjectIndex) to a new working directory, called by WorkspaceSwapManager after verification; stores needing a process restart just warn-log and keep serving the old path until the daemon restarts with the new --working-dir. */
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
  // W6.1 (the purge): MIGRATE-TO-MODAL surface + redirect registration moved to
  // registerBuiltinPanels (builtin-panels.ts), where the panels' resolved deps
  // are available for the surfaces to close over.
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
  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
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
  agentOrchestrator.setConversationSink({ // Conversation-snapshot bridge (mirrors the SDK's own createRuntimeServices)
    register: (agentId, source) => agentManager.registerConversationSource(agentId, source),
    release: (agentId) => agentManager.releaseConversationSource(agentId),
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
  // Open the ONE home-scoped canonical store; legacy per-project TUI memory folds in at boot (foldTuiLegacyMemory).
  const memoryDbPath = resolveCanonicalMemoryDbPath(homeDirectory);
  const memoryStore = new MemoryStore(memoryDbPath, {
    embeddingRegistry: memoryEmbeddingRegistry,
  });
  const memoryRegistry = new MemoryRegistry(memoryStore);
  // Local-until-adopted access facade for spine-shaped consumers (the Memory
  // modal): bootstrap.ts activates the wire transport when a compatible
  // external daemon is adopted, same signal as the session spine.
  const memorySpine = new MemorySpineClient({ local: createLocalMemoryAccess(memoryRegistry) });
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
  const knowledgeStore = new KnowledgeStore({
    configManager,
    dbFileName: REGULAR_KNOWLEDGE_DB_FILE,
  });
  const agentKnowledgeStore = new KnowledgeStore({
    configManager,
    dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  });
  const homeGraphKnowledgeStore = new KnowledgeStore({
    configManager,
    dbFileName: HOME_GRAPH_KNOWLEDGE_DB_FILE,
  });
  const knowledgeSemanticLlm = createProviderBackedKnowledgeSemanticLlm(providerRegistry, {
    timeoutMs: 20_000,
    maxConcurrent: 1,
  });
  const knowledgeSemanticService = new KnowledgeSemanticService(knowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
  });
  const homeGraphSemanticService = new KnowledgeSemanticService(homeGraphKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
    objectProfiles: HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles,
  });
  const agentKnowledgeSemanticService = new KnowledgeSemanticService(agentKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    maxLlmSourcesPerReindex: 3,
  });
  const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    semanticService: knowledgeSemanticService,
  });
  knowledgeService.attachRuntimeBus(options.runtimeBus);
  const agentKnowledgeService = new KnowledgeService(agentKnowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    semanticService: agentKnowledgeSemanticService,
  });
  agentKnowledgeService.attachRuntimeBus(options.runtimeBus);
  const homeGraphService = new HomeGraphService(homeGraphKnowledgeStore, artifactStore, {
    semanticService: homeGraphSemanticService,
  });
  const projectPlanningProjectId = projectPlanningProjectIdFromPath(workingDirectory);
  const projectPlanningService = new ProjectPlanningService(knowledgeStore, {
    defaultProjectId: projectPlanningProjectId,
  });
  const workPlanStore = new WorkPlanStore({
    homeDirectory,
    projectId: projectPlanningProjectId,
    projectRoot: workingDirectory,
  });
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
  knowledgeSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: knowledgeService,
  }));
  agentKnowledgeSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: agentKnowledgeService,
  }));
  homeGraphSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: homeGraphService,
  }));
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

  // Daemon handler surfaces: attach HOST handlers to the SDK-auto-registered builtin
  // gateway descriptors (channels.* / email.* / calendar.*) via catalog.register(descriptor,
  // handler, { replace: true }) — the SDK owns every id/descriptor/schema. The remote
  // surface reuses the SAME DistributedRuntimeManager the SDK facade injects.
  const handlerLogger: HandlerLogger = {
    info: (message, meta) => console.info(message, meta ?? ''),
    warn: (message, meta) => console.warn(message, meta ?? ''),
    error: (message, meta) => console.error(message, meta ?? ''),
  };
  const handlerContext: HandlerContext = {
    catalog: gatewayMethods,
    credentials: createDaemonCredentialStore(secretsManager),
    configManager,
    workingDirectory,
    homeDirectory,
    logger: handlerLogger,
  };
  const daemonHandlers = registerDaemonHandlers(handlerContext, {
    registerRouting,
    registerInbox: (ctx, routing) =>
      registerTriagedInbox(ctx, (inboxCtx) => registerInboxMethods(inboxCtx, routing))
        .unregister,
    registerDrafts: (ctx) => registerDraftMethods(ctx),
    registerCalendar,
    registerEmail: (ctx) => registerEmailMethods(ctx),
    registerRemote: (ctx) => registerRemoteSurface(ctx, { manager: distributedRuntime }),
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
  const focusTracker = new FocusTracker();
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  const providerOptimizer = new ProviderOptimizer(
    providerRegistry,
    providerCapabilityRegistry,
    isFeatureFlagEnabled(configManager, 'provider-optimizer'),
  );
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
    secretsManager,
    serviceRegistry,
    artifactStore,
  });
  const processManager = new ProcessManager();
  // The phase/work-item orchestration engine, constructed
  // before the process registry so its fleet nodes (workstream/phase/
  // work-item) can be folded in below via the registry's optional
  // orchestrationEngine dep.
  const { orchestrationEngine, workstreamCommands } = createWorkstreamServices({
    agentManager, configManager, adaptivePlanner, runtimeBus: options.runtimeBus, projectRoot: workingDirectory,
  });
  // Repo source-tree code index, sharing memoryEmbeddingRegistry
  // with MemoryStore above. Auto-build is config-gated (default off) — see
  // code-index-services.ts's header doc.
  const { codeIndexStore, codeIndexReindexScheduler } = createCodeIndexServices({ workingDirectory, configManager, memoryEmbeddingRegistry });
  const codeInjectionOrchestratorDeps = { codeIndex: codeIndexStore, isCodeInjectionSettingEnabled: () => isCodeInjectionSettingEnabled(configManager), codeIndexReindexScheduler }; // Code-injection seam (agent here; main via orchestrator-core-services.ts)
  // Shared, archive-aware fleet registry — see gateway-verbs.ts's factory doc.
  const processRegistry = createArchivableFleetRegistry({
    agentManager,
    wrfcController,
    orchestrationEngine, // Folds workstream/phase/work-item nodes into the fleet
    codeIndexService: codeIndexStore, // Folds a single 'code-index' node into the fleet
    processManager,
    watcherRegistry,
    workflow,
    approvalBroker,
    sessionBroker,
    messageBus: agentMessageBus, // Backs steer()/`steerable` (the Fleet steer composer builds on top)
    automationManager, // Folds /schedule AutomationJobs into the fleet as 'schedule' nodes
    runtimeBus: options.runtimeBus,
    // Honest pricing: never fabricate a cost for an unrecognized model.
    priceUsage: (model, usage) => {
      const modelId = model ?? 'unknown';
      if (!isModelPriced(modelId)) return null;
      return calcSessionCost(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, modelId);
    },
  });
  const modeManager = new ModeManager();
  const fileUndoManager = new FileUndoManager();
  // Checkpoint root-guard from the user's `checkpoints.*` config (docs/configuration.md;
  // inert until the platform SDK's checkpoint manager exposes the keys — see the reader's note).
  const workspaceCheckpointManager = new WorkspaceCheckpointManager(withCheckpointGuardSettings({ workspaceRoot: workingDirectory, runtimeBus: options.runtimeBus }, configManager));
  // Fire-and-forget: subscriptions go live immediately if init() succeeds.
  // If it rejects, WorkspaceCheckpointManager caches that rejection on
  // `initPromise` and never clears it, so every later call (create/list/
  // diff/restore — each awaits init() first) re-throws the same error
  // forever: checkpointing becomes entirely unavailable for the rest of the
  // session, not "degraded to manual-only". The `.catch(() => {})` here only
  // exists to prevent an unhandled rejection at startup; the checkpoint
  // commands (checkpoint-runtime.ts) are what actually catch and report the
  // failure to the user, on first use.
  void workspaceCheckpointManager.init().catch(() => {});

  // ws-only verbs (fleet/checkpoints/search/push) 501 without this — see gateway-verbs.ts.
  attachWsOnlyGatewayVerbHandlers(gatewayMethods, { processRegistry, workspaceCheckpointManager, sessionBroker, secretsManager, approvalBroker, shellPaths });
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
    ...codeInjectionOrchestratorDeps, // Agent-run code injection + tool-site reindex
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
    agentKnowledgeService,
    homeGraphService,
    projectPlanningService,
    projectPlanningProjectId,
    workPlanStore,
    memoryStore,
    memoryRegistry,
    memorySpine,
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
    focusTracker,
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
    daemonHandlers,
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
    orchestrationEngine,
    workstreamCommands,
    codeIndexStore,
    codeIndexReindexScheduler,
    processRegistry,
    modeManager,
    fileUndoManager,
    workspaceCheckpointManager,
    integrationHelpers,
    async rerootStores(newWorkingDir: string): Promise<void> {
      // The memory store is the home-scoped canonical cross-surface store and
      // deliberately does NOT reroot per-project (that would re-silo memory, the E6
      // regression). Only working-tree-bound stores (code index, project index) reroot.
      await codeIndexStore.reroot(newWorkingDir, codeIndexDbPath(newWorkingDir));
      await projectIndex.reroot(newWorkingDir);
    },
  };
}
