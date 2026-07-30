import { join } from 'node:path';
import { FocusTracker } from '../core/focus-tracker.ts';
import { ServiceRegistry, SubscriptionManager, ToolLLM } from '@pellux/goodvibes-sdk/platform/config';
import { AutomationDeliveryManager, AutomationManager } from '@pellux/goodvibes-sdk/platform/automation';
import { ChannelDeliveryRouter, ChannelPolicyManager } from '@pellux/goodvibes-sdk/platform/channels';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import { wireIdlePowerAndLiveTurn } from './idle-power-services.ts';
import { resolvePairingWebOrigin } from '../core/pairing-origin.ts';
import { attachWsOnlyGatewayVerbHandlers } from '@pellux/goodvibes-terminal-shell';
import { composeMailDeps } from './mail-composition.ts';
import { composeCredentialServices } from './credential-composition.ts';
import { createDisposalScope, registerSurfaceRuntimePollers } from './disposal-wiring.ts';
import { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts';
import { createWebKnowledgeGapRepairer } from '@pellux/goodvibes-sdk/platform/knowledge';
import { createKnowledgeServices } from './knowledge-services.ts';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '@pellux/goodvibes-sdk/platform/media';
import { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal';
import { OverflowHandler, ProcessManager, cancelAllAgentRuns, createWorkflowServices } from '@pellux/goodvibes-sdk/platform/tools';
import { FileStateCache, FileUndoManager, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, ModeManager, ProjectIndex, resolveCanonicalMemoryDbPath } from '@pellux/goodvibes-sdk/platform/state';
import { buildExecPromptAnswerHandler } from '@pellux/goodvibes-sdk/platform/runtime/permissions/exec-prompt-wiring';
import { buildLocalhostFetchApproval } from '@pellux/goodvibes-sdk/platform/runtime/permissions/localhost-fetch-approval';
import { createNotificationDispatcher, wireRuntimeNotificationBridge, wireMemoryPressureNotice } from './notification-dispatch.ts';
import { createDurabilityServices } from './durability-services.ts';
import { MemorySpineClient, createLocalMemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import { createWorkspaceCheckpointing } from './workspace-checkpointing.ts';
import { createSessionConversationRewindPort } from './conversation-rewind-port.ts';
import { createDomainDispatch } from './store/index.ts';
import { DistributedRuntimeManager, IntegrationHelperService, IdempotencyStore, ComponentHealthMonitor, WorktreeRegistry, createShellPathService, createFeatureFlagManager, PolicyRuntimeState } from '@/runtime/index.ts';
import { createSessionStorageServices } from './session-storage-services.ts';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '@pellux/goodvibes-sdk/platform/voice';
import { CacheRegistry, PauseController } from '@pellux/goodvibes-sdk/platform/runtime/memory';
import { wireMemoryGovernance } from './memory-governance-services.ts';
import { wireVoiceSetup } from './voice-setup-services.ts';
import { WebSearchProviderRegistry, WebSearchService } from '@pellux/goodvibes-sdk/platform/web-search';
import { PanelManager } from '../panels/panel-manager.ts';
import { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks';
import { HookDispatcher, createHookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins';
import { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks';
import { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles';
import { CrossSessionTaskRegistry, SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions';
import { ApiTokenAuditor, UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { createRemoteExecutionServices } from './remote-execution-composition.ts';
import { createAgentGraph } from './agent-graph-composition.ts';
import { BenchmarkStore, CacheHitTracker, FavoritesStore, ModelLimitsService, ProviderCapabilityRegistry, ProviderOptimizer, ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { KeybindingsManager } from '../input/keybindings.ts';
import { AdaptivePlanner, DeterministicReplayEngine, ExecutionPlanManager, SessionLineageTracker, SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import { deriveFeatureStates, bindFeatureSettingsBridge } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { createChannelComposition } from './channel-composition.ts';
import { applyProviderOptimizerConfigMode, bindProviderOptimizerFeatureFlag } from './provider-optimizer-wiring.ts';
import { createFleetServices } from './fleet-services.ts';
import { createWorkstreamServices } from './workstream-services.ts';
import { wireFleetNeedsInputPush } from './fleet-needs-input-push.ts';
import { codeIndexDbPath, createCodeIndexServices, createStoreRerooter, isCodeInjectionSettingEnabled } from './code-index-services.ts';
import { createDaemonHandlerComposition } from './daemon-handler-composition.ts';
import { createDevicePostureServices } from './device-posture-composition.ts';
// Re-exported so the shell's bootstrap reaches the install through the same
// module it already imports the runtime graph from.
export { installDevicePosture } from './device-posture-composition.ts';
import { createClusterServices, startClusterServices } from './cluster-group-composition.ts';
import { WorkspaceTrustManager } from './trust/workspace-trust.ts';
import { ensureConfiguredModelIsRoutable } from './provider-fallback.ts';
import type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';
export type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';

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
  // The credential/identity seam (credential-composition.ts).
  const { secretsManager, stepUpService, pairingTokens } = composeCredentialServices({
    workingDirectory, homeDirectory, configManager,
    daemonHomeDirectory: options.daemonHomeDirectory,
    pairingTokenPath: shellPaths.resolveUserPath('control-plane', 'pairing-tokens.json'),
  });
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
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design — a
  // narrow embed with no manager wired gets the capability rather than a
  // silent off — so omitting it did not disable the watcher framework when
  // watchers.enabled is turned off; it made the setting configure nothing.
  // Threading it preserves current effective behaviour rather than changing
  // it: watchers.enabled defaults true, the watcher-framework flag's own
  // defaultState is 'enabled', and the flag declares no notOperable record —
  // so with nothing configured the gate reads exactly as before, and the
  // difference is only that turning it OFF now turns it off. This composes
  // with bootstrap-core.ts's own `if (configManager.get('watchers.enabled'))`
  // check around the built-in polling watcher registration: that check reads
  // the same key, so the two never disagree, and this fix only reaches the
  // watcher registry's OTHER entry points (registerWatcher/startWatcher/etc.)
  // that bootstrap-core.ts's narrower check does not cover.
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath('tui', 'watchers.json'),
    featureFlags,
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
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design, so
  // omitting it did not disable delivery tracking when
  // integrations.deliveryTracking is turned off — it made the setting
  // configure nothing: deliverText/deliverJobRun kept running either way.
  // Threading it preserves current effective behaviour rather than changing
  // it: the config default is true, the delivery-engine flag's own
  // defaultState is 'enabled', and the flag declares no notOperable record —
  // so with nothing configured the gate reads exactly as before.
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
    featureFlags,
  });
  // Same shape as deliveryManager above: automation.enabled defaults true,
  // the automation-domain flag's own defaultState is 'enabled', so threading
  // featureFlags here does not change what a default install does — it only
  // makes turning automation.enabled off actually turn AutomationManager's own
  // create/update/run/list surface off. This composes with bootstrap.ts's own
  // `if (configManager.get('automation.enabled'))` gate around scheduling
  // automationManager.start(): that check reads the same key, and
  // AutomationManager.start() re-checks the same gate internally (it no-ops
  // and stops rather than starting when disabled), so the two can never
  // disagree — this fix only reaches the manager's OTHER entry points
  // (createJob/updateJob/runNow/etc.) that the bootstrap.ts gate does not
  // cover, the same way watchers.enabled and the watcher registry above do.
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
    featureFlags,
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
  // The paired-phone feature for this host, on the SAME runtime phones pair onto
  // and the SAME approval broker every other confirmation rides. Every `device.*`
  // setting is read live through this; see device-posture-composition.ts.
  const { devicePosture } = createDevicePostureServices({
    configManager,
    distributedRuntime,
    approvals: approvalBroker,
    stateDirectory: shellPaths.resolveProjectPath('tui', 'devices'),
    gatewayMethods,
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
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design, so
  // omitting it did not disable managed blocking when
  // security.tokenAudit.enabled is turned off. Threading it preserves current
  // effective behaviour rather than changing it: managed is hardcoded false
  // here (advisory reporting only; excess-scope/overdue tokens are reported,
  // never blocked, regardless of this flag — see isBlocked()'s
  // `this._config.managed && this._managedBlockingEnabled()` guard), the
  // config default for security.tokenAudit.enabled is true, and the
  // token-scope-rotation-audit flag's own defaultState is 'enabled' — so with
  // nothing configured the gate reads exactly as before either way.
  const tokenAuditor = new ApiTokenAuditor({ managed: false, featureFlags });
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
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design, so
  // omitting it did not disable the HITL UX mode system when
  // behavior.hitlMode is set to 'off' — setHITLMode/setDomainVerbosity kept
  // accepting writes either way. Threading it preserves current effective
  // behaviour rather than changing it: behavior.hitlMode defaults to
  // 'balanced' (not 'off'), and the hitl-ux-modes flag's own defaultState is
  // 'enabled' — so with nothing configured the gate reads exactly as before.
  const modeManager = new ModeManager({ featureFlags }); const fileUndoManager = new FileUndoManager();
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
  const { voiceSetup, stopWakeHousekeeping } = wireVoiceSetup({ configManager, shellPaths, voiceProviders, admitExpensiveWork,
    // Boot provisioning of the wake-word model + its recovery sweep, opted into
    // by the real entrypoints only (same treatment as powerSeam) so a one-shot
    // CLI command and a test composing this graph fetch nothing and start no timer.
    provisionWakeModelsAtBoot: options.provisionWakeModelsAtBoot === true });

  // Terminal-shell wrapper over the SDK registerGatewayVerbGroups (gateway-verbs.ts); checkin.*/fleet-needs-input/pairing.* register only when their deps are present. memoryGovernor lights up ops.memory.get; voiceSetup lights up voice.local.status/install.
  // calendar.*/email.* are platform-served; these two let it register (mail-composition.ts).
  const { emailServiceDeps, describeEmailConfigProblem } = composeMailDeps({ configManager, secretsManager });
  attachWsOnlyGatewayVerbHandlers(gatewayMethods, { homeDirectory, emailServiceDeps, describeEmailConfigProblem, processRegistry, workspaceCheckpointManager, conversationRewindPort: createSessionConversationRewindPort(), sessionBroker, secretsManager, stepUpService, approvalBroker, requestApproval: (input) => approvalBroker.requestApproval(input), watcherRegistry, userPermissionRuleStore, shellPaths, configManager, runtimeStore: options.runtimeStore, channelDeliveryRouter, providerRegistry, automationManager, sessionLister: sessionBroker, sessionIntake: sessionBroker, workingDirectory, memoryRegistry, pairingTokens, sessionLiveTurnControls, powerManager, memoryGovernor, voiceSetup, relayAvailable: () => configManager.get('relay.enabled') === true, pairingWebOrigin: () => resolvePairingWebOrigin(configManager).origin, disposal: disposalScope.registry, ...wireFleetNeedsInputPush({ registry: processRegistry, runtimeBus: options.runtimeBus, sessionBroker }) });
  // surface-scoped: continuity's recovery-file check must read the SAME paths
  // the app writes with, not the unscoped legacy pair.
  const integrationHelpers = new IntegrationHelperService({
    surface, configManager, automationManager, approvalBroker, sessionBroker, distributedRuntime,
    remoteRunnerRegistry, remoteSupervisor, panelManager, localUserAuthManager, providerRegistry,
    serviceRegistry, subscriptionManager, secretsManager,
    runtimeStore: options.runtimeStore, runtimeBus: options.runtimeBus,
    getConversationTitle: options.getConversationTitle,
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
    devicePosture,
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
    storeSnapshotScheduler, appendOnlyRetentionScheduler, stopDurabilityHousekeeping, stopWakeHousekeeping,
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
