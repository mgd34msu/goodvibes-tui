import { join } from 'node:path';
import { FocusTracker } from '../core/focus-tracker.ts';
import { ConfigManager, ServiceRegistry, SubscriptionManager, ToolLLM } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../config/secrets.ts';
import { AutomationDeliveryManager, AutomationManager } from '@pellux/goodvibes-sdk/platform/automation';
import { ChannelDeliveryRouter, ChannelPolicyManager, type ChannelPluginRegistry, type RouteBindingManager, type SurfaceRegistry } from '@pellux/goodvibes-sdk/platform/channels';
import { ApprovalBroker, GatewayMethodCatalog, SessionLiveTurnControlsHolder, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { PowerManager } from '@pellux/goodvibes-sdk/platform/power';
import { wireIdlePowerAndLiveTurn } from './idle-power-services.ts';
import { StepUpService } from '@pellux/goodvibes-sdk/daemon';
import { PairingTokenManager } from '@pellux/goodvibes-sdk/platform/pairing';
import { resolvePairingWebOrigin } from '../core/pairing-origin.ts';
import { attachWsOnlyGatewayVerbHandlers } from '@pellux/goodvibes-terminal-shell';
import { createDisposalScope, registerSurfaceRuntimePollers } from './disposal-wiring.ts';
import { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts';
import { createWebKnowledgeGapRepairer } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { HomeGraphService, KnowledgeService, ProjectPlanningService } from '@pellux/goodvibes-sdk/platform/knowledge';
import { createKnowledgeServices } from './knowledge-services.ts';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '@pellux/goodvibes-sdk/platform/media';
import { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal';
import { AgentMessageBus, AgentOrchestrator, ArchetypeLoader, WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { AgentManager, ContextAccountingHolder, OverflowHandler, ProcessManager, cancelAllAgentRuns, createWorkflowServices, type WorkflowServices } from '@pellux/goodvibes-sdk/platform/tools';
import { FileStateCache, FileUndoManager, MemoryConsolidationScheduler, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, ModeManager, ProjectIndex, resolveCanonicalMemoryDbPath, type CodeIndexStore, type CodeIndexReindexScheduler } from '@pellux/goodvibes-sdk/platform/state';
import type { StoreSnapshotScheduler } from '@pellux/goodvibes-sdk/platform/state/store-snapshots';
import type { UserPermissionRuleStore } from '@pellux/goodvibes-sdk/platform/permissions';
import { buildExecPromptAnswerHandler } from '@pellux/goodvibes-sdk/platform/runtime/permissions/exec-prompt-wiring';
import { buildLocalhostFetchApproval } from '@pellux/goodvibes-sdk/platform/runtime/permissions/localhost-fetch-approval';
import { createNotificationDispatcher, wireRuntimeNotificationBridge, wireMemoryPressureNotice, type NotificationDispatcher } from './notification-dispatch.ts';
import { createDurabilityServices } from './durability-services.ts';
import { MemorySpineClient, createLocalMemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import { createWorkspaceCheckpointing } from './workspace-checkpointing.ts';
import { createSessionConversationRewindPort } from './conversation-rewind-port.ts';
import { createDomainDispatch } from './store/index.ts';
import type { DomainDispatch, RuntimeStore } from './store/index.ts';
import {
  type RuntimeEventBus, DistributedRuntimeManager, RemoteRunnerRegistry, RemoteSupervisor, IntegrationHelperService,
  IdempotencyStore, ComponentHealthMonitor, WorktreeRegistry, SandboxSessionRegistry, createShellPathService,
  type ShellPathService, type FeatureFlagManager, createFeatureFlagManager, PolicyRuntimeState, type SessionSurface,
} from '@/runtime/index.ts';
import { createSessionStorageServices } from './session-storage-services.ts';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '@pellux/goodvibes-sdk/platform/voice';
import { CacheRegistry, PauseController, type MemoryGovernor } from '@pellux/goodvibes-sdk/platform/runtime/memory';
import { wireMemoryGovernance } from './memory-governance-services.ts';
import { wireVoiceSetup } from './voice-setup-services.ts';
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
import { createRemoteExecutionServices } from './remote-execution-composition.ts';
import { createAgentGraph } from './agent-graph-composition.ts';
import { BenchmarkStore, CacheHitTracker, FavoritesStore, ModelLimitsService, ProviderCapabilityRegistry, ProviderOptimizer, ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { KeybindingsManager } from '../input/keybindings.ts';
import { AdaptivePlanner, DeterministicReplayEngine, ExecutionPlanManager, SessionLineageTracker, SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import { deriveFeatureStates, bindFeatureSettingsBridge } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { createChannelComposition } from './channel-composition.ts';
import { applyProviderOptimizerConfigMode, bindProviderOptimizerFeatureFlag } from './provider-optimizer-wiring.ts';
import { type ArchivableProcessRegistry } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { createFleetServices } from './fleet-services.ts';
import { createWorkstreamServices, type OrchestrationEngine, type WorkstreamCommandService } from './workstream-services.ts';
import { wireFleetNeedsInputPush } from './fleet-needs-input-push.ts';
import { codeIndexDbPath, createCodeIndexServices, createStoreRerooter, isCodeInjectionSettingEnabled } from './code-index-services.ts';
import type { WorkPlanStore } from '../work-plans/work-plan-store.ts';
import type { DaemonHandlerSurfaces } from '../daemon/handlers/index.ts';
import { createDaemonHandlerComposition } from './daemon-handler-composition.ts';
import { createClusterServices, startClusterServices, type ClusterGroupComposition } from './cluster-group-composition.ts';
import type { ClusterCoordinator } from '@pellux/goodvibes-sdk/platform/cluster';
import { WorkspaceTrustManager } from './trust/workspace-trust.ts';
import { ensureConfiguredModelIsRoutable } from './provider-fallback.ts';

export interface RuntimeServicesOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly featureFlags?: FeatureFlagManager;
  readonly getConversationTitle?: () => string | undefined;
  readonly workingDir: string;
  readonly homeDirectory: string;
  /** Opt-in (daemon-side only): fold host-observed external coding-agent sessions
   * into the fleet as 'observed-external' rows. Interactive leaves it off and reads
   * the daemon snapshot. Mirrors the SDK's own createRuntimeServices option. */
  readonly observeExternalAgents?: boolean | undefined;
  /** Host power seam opt-in. Fork mirrors the SDK: non-spawning unavailable-seam
   * default (idle-power-services.ts); daemon + embedded runtime pass createHostPowerSeam(). */
  readonly powerSeam?: Parameters<typeof wireIdlePowerAndLiveTurn>[0]['powerSeam'];
  /** Live session id, read per crash-residue sweep so the running session is exempt — see durability-services.ts. */
  readonly currentSessionId?: (() => string | null) | undefined;
}

export interface RuntimeServices {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** The declare-once session-storage handle every session reader and writer threads through — see session-storage-services.ts. */
  readonly surface: SessionSurface;
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
  /** Loopback-fetch approval that rides the approval broker; shared by the tool registry and orchestrator so every surface asks the same way. */
  readonly localhostFetchApproval: ReturnType<typeof buildLocalhostFetchApproval>;
  /** Terminal prompt-answer handler that rides the approval broker; shared by the tool registry and orchestrator so an interactive command's prompt gets an ask/card on every surface. */
  readonly execPromptAnswerHandler: ReturnType<typeof buildExecPromptAnswerHandler>;
  /** Routes curated runtime-domain events into the panel_only notification feed (the panel's live producer). */
  readonly notificationDispatcher: NotificationDispatcher;
  /** Durable user-origin permission rules (remembered approvals); permissions.rules.* surface. Mirrors the SDK composition. */
  readonly userPermissionRuleStore: UserPermissionRuleStore;
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
  readonly stepUpService: StepUpService;
  readonly pairingTokens: PairingTokenManager; // backs pairing.tokens.* verbs + the settings device surface (mirrors the SDK composition)
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
  /** Terminal focus tracker — fed by input/handler-feed.ts, read by the alert notifiers in core/. */
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
  /** Elects the one node on this network that consumes inbound messages; hand it to the DaemonServer so its consumers share this leadership instead of holding a second election. */
  readonly clusterCoordinator: ClusterCoordinator;
  /** LAN group membership: identity, keys, roster, and the `cluster` verbs. */
  readonly clusterGroup: ClusterGroupComposition;
  /** Start the group layer and then the election, in that order. Idempotent. */
  readonly startCluster: () => Promise<void>;
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
  readonly contextAccountingHolder: ContextAccountingHolder; // bound at bootstrap.ts; see context-accounting-source.ts
  readonly wrfcController: WrfcController;
  readonly processManager: ProcessManager;
  /** The phase/work-item orchestration engine — see runtime/workstream-services.ts. */
  readonly orchestrationEngine: OrchestrationEngine;
  readonly workstreamCommands: WorkstreamCommandService;
  /** The repo source-tree code index — see runtime/code-index-services.ts. */
  readonly codeIndexStore: CodeIndexStore;
  readonly codeIndexReindexScheduler: CodeIndexReindexScheduler; // tool-site reindex
  /** Daily snapshots of every SQLite store this runtime writes, with bounded retention; unref'd timers (mirrors the SDK composition — hosts that tear down a runtime stop() it themselves). */
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  readonly appendOnlyRetentionScheduler: ReturnType<typeof createDurabilityServices>['appendOnlyRetentionScheduler']; // periodic append-only sweep; unref'd timers, stop() on teardown
  /** Stops the recurring crash-residue sweep; idempotent, unref'd timer (hosts that tear a runtime down call it). */
  readonly stopDurabilityHousekeeping: () => void;
  readonly memoryConsolidationScheduler: MemoryConsolidationScheduler;
  readonly powerManager: PowerManager;
  /** The daemon's memory governor (default ON). Backs ops.memory.get and defends the daemon's footprint by tier. */
  readonly memoryGovernor: MemoryGovernor;
  /** Registry of every retained cache the governor can shrink (knowledge stores + shared session broker). */
  readonly cacheRegistry: CacheRegistry;
  /** Controller the governor uses to pause/resume the deferrable background jobs under pressure. */
  readonly pauseController: PauseController;
  readonly sessionLiveTurnControls: SessionLiveTurnControlsHolder;
  /** Unified live process registry (agents, WRFC chains, workflows, watchers, background processes) backing the Fleet panel; archive-aware — finished subtrees can be moved to the session archive view. */
  readonly processRegistry: ArchivableProcessRegistry;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager: WorkspaceCheckpointManager;
  /** Per-workspace trust gate — restricts write/execute/delegate tools until the workspace is trusted. */
  readonly workspaceTrustManager: WorkspaceTrustManager;
  readonly integrationHelpers: IntegrationHelperService;
  /** Re-root path-bound stores (MemoryStore, ProjectIndex) to a new working directory, called by WorkspaceSwapManager after verification; stores needing a process restart just warn-log and keep serving the old path until the daemon restarts with the new --working-dir. */
  rerootStores(newWorkingDir: string): Promise<void>;
  /**
   * Cancel the agent runs this graph is hosting, returning how many.
   *
   * Required by the SDK's RuntimePollerOwners: by dispose() time the fleet
   * registry, orchestration engine, process registry and bus these runs report
   * through are already down, so a run still described as "running" is orphaned
   * rather than preserved.
   */
  cancelHostedAgentRuns(): number;
  dispose(): void; // Stop every poller this graph started; best-effort, total, idempotent. This surface owns its graph — see disposal-wiring.ts.
}

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  const disposalScope = createDisposalScope('RuntimeServices'); const workingDirectory = options.workingDir; // disposal seam: see ./disposal-wiring.ts
  const homeDirectory = options.homeDirectory;
  const shellPaths = createShellPathService({
    workingDirectory,
    homeDirectory,
  });
  // Built before anything that touches session state — see session-storage-services.ts.
  const { surface, sessionManager } = createSessionStorageServices({ workingDirectory, homeDirectory });
  const workspaceTrustManager = new WorkspaceTrustManager({ shellPaths });
  const configManager = options.configManager;
  const featureFlags = options.featureFlags ?? createFeatureFlagManager();
  if (options.featureFlags === undefined) {
    // Owned manager: gate states derive from domain settings keys + live
    // bridge (mirrors the SDK composition root; a passed manager is the caller's to wire).
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    bindFeatureSettingsBridge(configManager, featureFlags);
  }
  const runtimeDispatch = createDomainDispatch(options.runtimeStore);
  // Memory governance seams built EARLY (mirrors the SDK's own createRuntimeServices)
  // so the scheduler gates and the knowledge background jobs can consult the pause
  // controller before the MemoryGovernor (constructed at the composition tail)
  // drives it. The admission gate is late-bound: expensive entry points capture
  // this closure now and the governor binds into it at the tail — until then
  // everything is admitted (the daemon is still booting).
  const cacheRegistry = new CacheRegistry();
  const pauseController = new PauseController();
  const MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'];
  const admitExpensiveWorkRef: { current: ((label: string) => { allowed: boolean; reason?: string | undefined }) | null } = { current: null };
  const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
    admitExpensiveWorkRef.current?.(label) ?? { allowed: true };
  const isKnowledgeBackgroundPaused = (): boolean => pauseController.isPaused('knowledge-self-improvement');
  const gatewayMethods = new GatewayMethodCatalog();
  const panelManager = new PanelManager();
  // (the purge): MIGRATE-TO-MODAL surface + redirect registration moved to
  // registerBuiltinPanels (builtin-panels.ts), where the panels' resolved deps
  // are available for the surfaces to close over.
  const keybindingsManager = new KeybindingsManager({
    configPath: shellPaths.resolveUserPath('tui', 'keybindings.json'),
  });
  // Channel/surface wiring: see channel-composition.ts (incl. the recorded surface-gating divergence note).
  const { routeBindings, surfaceRegistry, channelPlugins } = createChannelComposition({
    configManager,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    featureFlags,
  });
  const secretsManager = new SecretsManager({
    projectRoot: workingDirectory,
    globalHome: homeDirectory,
    configManager,
  });
  // Step-up (WebAuthn) ceremony service, shared between the ceremony gateway verbs and the relay gate's verifier.
  const stepUpService = new StepUpService({ secrets: secretsManager });
  const pairingTokens = new PairingTokenManager(shellPaths.resolveUserPath('control-plane', 'pairing-tokens.json'));
  const subscriptionManager = new SubscriptionManager(shellPaths.resolveUserPath('tui', 'subscriptions.json'));
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
  // Kick off the background, TTL-respecting live model discovery sweep so
  // provider model lists refresh from their own listing APIs — matching the
  // SDK and agent compositions (this call was the one omitted here).
  providerRegistry.initProviderModelDiscovery();
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
  const sessionOrchestration = new CrossSessionTaskRegistry(
    join(surface.sessionsDir, 'task-graph.json'),
  );
  const hookActivityTracker = new HookActivityTracker();
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath('tui', 'watchers.json'),
  });
  watcherRegistry.attachRuntime({
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  // The agent-execution graph, wired in both directions; see
  // agent-graph-composition.ts for why the six are built as one.
  const {
    agentMessageBus, archetypeLoader, agentOrchestrator,
    agentManager, contextAccountingHolder, wrfcController,
  } = createAgentGraph({
    runtimeBus: options.runtimeBus, workingDirectory, configManager, providerRegistry,
  });
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
    conversationGateConfig: configManager, // without this the gate runs on DEFAULTS: an inbound message landing in a live session takes the handover and starts work whatever conversationGate.mode/gatedSurfaces say
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
    // This manager builds the delivery router the daemon actually replies
    // through (bootstrap.ts hands it to the daemon facade). Without the
    // secrets manager it cannot resolve a goodvibes://secrets/... credential,
    // so Telegram accepted every inbound message and dropped every reply with
    // "Missing Telegram bot token" while ntfy — which needs no secret — worked.
    secretsManager,
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
    // Same live registry: a bare model id on an automation job resolves through
    // the shared resolver instead of a format-only rejection.
    providerRegistry,
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
  // Knowledge/wiki + home-graph stack (governor backpressure wired in) — see knowledge-services.ts.
  const {
    knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore,
    knowledgeSemanticService, homeGraphSemanticService, agentKnowledgeSemanticService,
    knowledgeService, agentKnowledgeService, homeGraphService,
    projectPlanningService, projectPlanningProjectId, workPlanStore,
  } = createKnowledgeServices({ configManager, providerRegistry, artifactStore, memoryRegistry, runtimeBus: options.runtimeBus, workingDirectory, homeDirectory, isBackgroundPaused: isKnowledgeBackgroundPaused, admitExpensiveWork });
  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders, { readConfig: (key) => configManager.get(key as Parameters<typeof configManager.get>[0]) });
  const voiceService = new VoiceService(voiceProviders);
  const webSearchProviders = new WebSearchProviderRegistry({
    env: process.env,
    serviceRegistry,
  });
  const webSearchService = new WebSearchService(webSearchProviders, {
    serviceRegistry,
    featureFlags,
  });
  for (const [semantic, ingest] of [[knowledgeSemanticService, knowledgeService], [agentKnowledgeSemanticService, agentKnowledgeService], [homeGraphSemanticService, homeGraphService]] as const) {
    semantic.setGapRepairer(createWebKnowledgeGapRepairer({ searchService: webSearchService, ingestService: ingest }));
  }
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

  // Which machines on this network are "us", and which of them reads the
  // shared inbox. Both inert until startCluster() — no socket, no key material
  // read; see cluster-group-composition.ts for why they are built together.
  const { clusterGroup, clusterCoordinator } = createClusterServices({
    configManager, shellPaths, secretsManager,
  });
  // Daemon handler surfaces (see daemon-handler-composition.ts); the inbox
  // poller registers itself with the coordinator rather than starting eagerly.
  const daemonHandlers = createDaemonHandlerComposition({
    gatewayMethods,
    secretsManager,
    configManager,
    workingDirectory,
    homeDirectory,
    distributedRuntime,
    clusterCoordinator,
  });

  // Remote runners and the sandboxes tool calls are confined to; see
  // remote-execution-composition.ts for why the four are built as one.
  const { remoteRunnerRegistry, remoteSupervisor, sandboxSessionRegistry, mcpRegistry }
    = createRemoteExecutionServices({
      agentManager, workingDirectory, hookDispatcher, configManager, runtimeBus: options.runtimeBus,
    });
  const tokenAuditor = new ApiTokenAuditor({ managed: false });
  const componentHealthMonitor = new ComponentHealthMonitor();
  const worktreeRegistry = new WorktreeRegistry(workingDirectory);
  const webhookNotifier = new WebhookNotifier();
  const focusTracker = new FocusTracker();
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  const providerOptimizer = new ProviderOptimizer(providerRegistry, providerCapabilityRegistry, false); // dark until its gate flips it (see provider-optimizer-wiring.ts)
  bindProviderOptimizerFeatureFlag(featureFlags, providerOptimizer);
  applyProviderOptimizerConfigMode(configManager, providerOptimizer);
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker(); const sessionChangeTracker = new SessionChangeTracker();
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
  const { codeIndexStore, codeIndexReindexScheduler } = createCodeIndexServices({ workingDirectory, configManager, memoryEmbeddingRegistry, isReindexPaused: () => pauseController.isPaused('code-index-reindex'), admitExpensiveWork });
  // Store snapshots, the periodic append-only sweep, durable remembered-approval rules + the live credential chain — see durability-services.ts.
  const { storeSnapshotScheduler, appendOnlyRetentionScheduler, userPermissionRuleStore, stopDurabilityHousekeeping, stopConfigWatch } = createDurabilityServices({
    configManager, secretsManager, providerRegistry, memoryDbPath, codeIndexDbPath: codeIndexDbPath(workingDirectory), surface, shellPaths, // + retention-sweep roots & live config watch (mirrors the SDK)
    ...(options.currentSessionId ? { currentSessionId: options.currentSessionId } : {}), // exempts the running session from crash-residue reaping
  });
  const codeInjectionOrchestratorDeps = { codeIndex: codeIndexStore, isCodeInjectionSettingEnabled: () => isCodeInjectionSettingEnabled(configManager), codeIndexReindexScheduler }; // Code-injection seam (agent here; main via orchestrator-core-services.ts)
  const { processRegistry } = createFleetServices({ // Shared archive-aware fleet registry (+ daemon observed rows) — see fleet-services.ts
    agentManager, wrfcController,
    orchestrationEngine, // Folds workstream/phase/work-item nodes into the fleet
    codeIndexService: codeIndexStore, // Folds a single 'code-index' node into the fleet
    processManager, watcherRegistry, workflow, approvalBroker, sessionBroker,
    messageBus: agentMessageBus, // Backs steer()/`steerable` (the Fleet steer composer builds on top)
    automationManager, // Folds /schedule AutomationJobs into the fleet as 'schedule' nodes
    runtimeBus: options.runtimeBus,
    observeExternalAgents: options.observeExternalAgents, providerRegistry, // observeExternalAgents is daemon-side only
  });
  const modeManager = new ModeManager(); const fileUndoManager = new FileUndoManager();
  const workspaceCheckpointManager = createWorkspaceCheckpointing({ workspaceRoot: workingDirectory, surface, runtimeBus: options.runtimeBus, configManager });
  // memory-consolidation honors governor backpressure: it ticks only when idle
  // AND the 'memory-consolidation' job is not paused AND expensive work is
  // admitted (mirrors the SDK's own createRuntimeServices idle gate).
  const { memoryConsolidationScheduler, powerManager, sessionLiveTurnControls } = wireIdlePowerAndLiveTurn({ configManager, memoryRegistry, runtimeBus: options.runtimeBus, isIdle: () => sessionBroker.countBusySessions() === 0 && !pauseController.isPaused('memory-consolidation') && admitExpensiveWork('memory consolidation').allowed, snapshotTick: () => storeSnapshotScheduler.tick(), heartbeat: async () => { await automationManager.triggerHeartbeat({ source: 'wake-catchup' }); }, powerSeam: options.powerSeam });

  // Construct + start the MemoryGovernor (default ON — a safety feature) with
  // the standard KNOWN cache adapters (knowledge stores + shared session
  // broker), then late-bind the admission gate the expensive entry points
  // captured earlier. Mirrors the SDK's own createRuntimeServices composition tail.
  const { memoryGovernor } = wireMemoryGovernance({
    configManager,
    runtimeBus: options.runtimeBus,
    cacheRegistry,
    pauseController,
    jobIds: MEMORY_BACKGROUND_JOB_IDS,
    receiptPath: shellPaths.resolveProjectPath('tui', 'memory', 'tripwire-receipt.json'),
    knowledgeStores: [knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore],
    sessionBroker,
    // Graceful tripwire shutdown flushes in-flight state via ASYNC store
    // snapshots so the governor's 10s shutdown ceiling stays enforceable.
    onTripwireShutdown: async () => { await storeSnapshotScheduler.snapshotAllAsync('tripwire'); },
  });
  admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label);

  // Managed local-voice provisioning (voice.local.status/install) — single-flight
  // one-act install + no-network status; see voice-setup-services.ts.
  const { voiceSetup } = wireVoiceSetup({ configManager, shellPaths, voiceProviders, admitExpensiveWork });

  // Terminal-shell wrapper over the SDK registerGatewayVerbGroups (gateway-verbs.ts); checkin.*/fleet-needs-input/pairing.* register only when their deps are present. memoryGovernor lights up ops.memory.get; voiceSetup lights up voice.local.status/install.
  attachWsOnlyGatewayVerbHandlers(gatewayMethods, { processRegistry, workspaceCheckpointManager, conversationRewindPort: createSessionConversationRewindPort(), sessionBroker, secretsManager, stepUpService, approvalBroker, requestApproval: (input) => approvalBroker.requestApproval(input), watcherRegistry, userPermissionRuleStore, shellPaths, configManager, runtimeStore: options.runtimeStore, channelDeliveryRouter, providerRegistry, automationManager, sessionLister: sessionBroker, sessionIntake: sessionBroker, workingDirectory, memoryRegistry, pairingTokens, sessionLiveTurnControls, powerManager, memoryGovernor, voiceSetup, relayAvailable: () => configManager.get('relay.enabled') === true, pairingWebOrigin: () => resolvePairingWebOrigin(configManager).origin, disposal: disposalScope.registry, ...wireFleetNeedsInputPush({ registry: processRegistry, runtimeBus: options.runtimeBus, sessionBroker }) });
  const integrationHelpers = new IntegrationHelperService({
    surface, // surface-scoped: continuity's recovery-file check must read the SAME paths the app writes with, not the unscoped legacy pair.
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
  // A loopback fetch that isn't allow-listed asks once through the approval
  // broker; "allow for this project" persists and later fetches never ask. Built
  // once and shared with the tool registry (bootstrap-core) so both ask alike.
  const localhostFetchApproval = buildLocalhostFetchApproval({ requestApproval: (input) => approvalBroker.requestApproval(input), configManager });
  // Exec stuck on a terminal prompt rides the approval broker; the typed answer feeds the continuing run. Built once and shared (like localhostFetchApproval) so the tool registry AND every setDependencies site — incl. the post-clobber rewire in bootstrap-core — install the SAME handler; otherwise a wholesale replace drops it and interactive prompts hang.
  const execPromptAnswerHandler = buildExecPromptAnswerHandler({ requestApproval: (input) => approvalBroker.requestApproval(input) });
  agentOrchestrator.setDependencies({
    surfaceRoot: surface.surfaceRoot,
    execPromptAnswerHandler,
    localhostFetchApproval,
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
    contextAccountingHolder,
  });

  // Give the panel_only notification target a live producer: curated
  // runtime-domain events route through the notification router into the shared
  // panel feed (panel_only and burst-collapsed decisions land there).
  const notificationDispatcher = createNotificationDispatcher(configManager);
  wireRuntimeNotificationBridge(options.runtimeBus, notificationDispatcher);
  // OPS_MEMORY_PRESSURE is lifted into the notice feed on its own targeted
  // bridge (the high-churn 'ops' domain stays out of the wholesale allowlist).
  wireMemoryPressureNotice(options.runtimeBus, notificationDispatcher);

  const services: RuntimeServices = {
    workingDirectory,
    homeDirectory,
    surface,
    shellPaths,
    workspaceTrustManager,
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
    localhostFetchApproval,
    execPromptAnswerHandler,
    notificationDispatcher,
    userPermissionRuleStore,
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
    stepUpService,
    pairingTokens,
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
    clusterCoordinator,
    clusterGroup,
    startCluster: () => startClusterServices({ clusterGroup, clusterCoordinator }),
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
    contextAccountingHolder,
    wrfcController,
    processManager,
    orchestrationEngine,
    workstreamCommands,
    codeIndexStore,
    codeIndexReindexScheduler,
    storeSnapshotScheduler, appendOnlyRetentionScheduler, stopDurabilityHousekeeping,
    memoryConsolidationScheduler,
    powerManager,
    memoryGovernor,
    cacheRegistry,
    pauseController,
    sessionLiveTurnControls,
    processRegistry,
    modeManager,
    fileUndoManager,
    workspaceCheckpointManager,
    integrationHelpers,
    rerootStores: createStoreRerooter({ codeIndexStore, projectIndex }),
    // Cancels the agent runs this graph was hosting. By dispose() time the
    // fleet registry, orchestration engine, process registry and bus these runs
    // report through are already down, so a run still described as "running" is
    // orphaned rather than preserved — and this is the only shutdown-reachable
    // way to abort its in-flight provider call instead of letting it sleep out
    // a retry backoff nobody is waiting on.
    cancelHostedAgentRuns: () => cancelAllAgentRuns(agentManager),
    dispose: (): void => disposalScope.dispose(),
  };
  registerSurfaceRuntimePollers(disposalScope.registry, services, { stopConfigWatch }); return services;
}
