/**
 * services.ts — the terminal app's composition root, as a CLIENT.
 *
 * ── What this stopped being ────────────────────────────────────────────────
 *
 * Until the daemon became its own product, this function built a daemon: a
 * `GatewayMethodCatalog` that SERVED verbs, the inbox/triage/drafts/routing
 * handlers, the cluster group and its election, the device-posture runtime and
 * its housekeeping, the mail service deps — all constructed here and all
 * answered from this process. A second copy ran in the standalone daemon binary
 * built out of this same repository, and the two drifted.
 *
 * Every one of those pieces now lives in the daemon product. This composition
 * serves no verbs, elects nothing, polls no mailbox, and supervises no remote
 * runner. It builds what a TURN needs in this process and reaches the daemon
 * for the rest.
 *
 * ── The floor comes from the SDK ───────────────────────────────────────────
 *
 * The loop essentials — the agent graph, the model stack, config/secrets/
 * services, hooks, plugins, MCP, the file-tool caches, permissions as a client,
 * the spine clients — are composed by `createClientRuntimeServices`, the SDK's
 * one implementation of that shape. Not a fork of it and not a copy of it: the
 * agent product composes the same function, so a wiring step added there cannot
 * silently miss this product the way `registerGatewayVerbGroups` once did.
 *
 * The SDK's own note on that shape applies here literally: it is a FLOOR, not a
 * ceiling. Everything below the `createClientRuntimeServices` call is what THIS
 * surface adds on top — panels, keybindings, the WRFC controller wired over the
 * client's own `agentManager`, the workstream engine, the fleet read model, the
 * voice stack with its local playback sink, the knowledge stack the recall
 * surfaces read. None of those need daemon furniture; they are simply not
 * required for a turn to run, which is why they are here and not in the SDK's
 * client floor.
 *
 * ── The two things that look like daemon furniture and are not ─────────────
 *
 * `sessionBroker` and `approvalBroker` are still constructed. They are this
 * surface's own record of the sessions it is running and the asks it raised —
 * what the transcript, the session panel and the approval card read. They are
 * NOT authoritative: session identity is mirrored to the daemon's spine
 * (register/heartbeat/inputs) and an ask is raised on the daemon
 * (`approvals.raise`) so every other surface can see and answer it. Where the
 * two disagree the daemon's record is the truth, and the client seams in
 * runtime/client/ are what keep them in step.
 */
import { FocusTracker } from '../core/focus-tracker.ts';
import { AutomationDeliveryManager, AutomationManager } from '@pellux/goodvibes-sdk/platform/automation';
import { ChannelPolicyManager } from '@pellux/goodvibes-sdk/platform/channels';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import { createClientRuntimeServices } from '@pellux/goodvibes-sdk/platform/runtime/client-services';
import { wireIdlePowerAndLiveTurn } from './idle-power-services.ts';
import { createDisposalScope, registerSurfaceRuntimePollers } from './disposal-wiring.ts';
import { composeCredentialServices } from './credential-composition.ts';
import { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers';
import { createWebKnowledgeGapRepairer } from '@pellux/goodvibes-sdk/platform/knowledge';
import { createKnowledgeServices } from './knowledge-services.ts';
import { cancelAllAgentRuns } from '@pellux/goodvibes-sdk/platform/tools';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '@pellux/goodvibes-sdk/platform/media';
import { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, resolveCanonicalMemoryDbPath } from '@pellux/goodvibes-sdk/platform/state';
import { buildExecPromptAnswerHandler } from '@pellux/goodvibes-sdk/platform/runtime/permissions/exec-prompt-wiring';
import { buildLocalhostFetchApproval } from '@pellux/goodvibes-sdk/platform/runtime/permissions/localhost-fetch-approval';
import { createNotificationDispatcher, wireRuntimeNotificationBridge, wireMemoryPressureNotice } from './notification-dispatch.ts';
import { createDurabilityServices } from './durability-services.ts';
import { MemorySpineClient, createLocalMemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import { createWorkspaceCheckpointing } from './workspace-checkpointing.ts';
import { createDomainDispatch } from './store/index.ts';
import { DistributedRuntimeManager, IntegrationHelperService, IdempotencyStore, ComponentHealthMonitor, WorktreeRegistry, createFeatureFlagManager, createShellPathService } from '@/runtime/index.ts';
import { createSessionStorageServices } from './session-storage-services.ts';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '@pellux/goodvibes-sdk/platform/voice';
import { CacheRegistry, PauseController } from '@pellux/goodvibes-sdk/platform/runtime/memory';
import { wireMemoryGovernance } from './memory-governance-services.ts';
import { wireVoiceSetup } from './voice-setup-services.ts';
import { PanelManager } from '../panels/panel-manager.ts';
import { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks';
import { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles';
import { SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions';
import { ApiTokenAuditor, UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { createRemoteExecutionServices } from './remote-execution-composition.ts';
import { WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { KeybindingsManager } from '../input/keybindings.ts';
import { AdaptivePlanner, DeterministicReplayEngine, ExecutionPlanManager, SessionLineageTracker, SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import { deriveFeatureStates, bindFeatureSettingsBridge } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { createChannelComposition } from './channel-composition.ts';
import { applyProviderOptimizerConfigMode, bindProviderOptimizerFeatureFlag } from './provider-optimizer-wiring.ts';
import { createFleetServices } from './fleet-services.ts';
import { createWorkstreamServices } from './workstream-services.ts';
import { codeIndexDbPath, createCodeIndexServices, createStoreRerooter, isCodeInjectionSettingEnabled } from './code-index-services.ts';
import { WorkspaceTrustManager } from './trust/workspace-trust.ts';
import { ensureConfiguredModelIsRoutable } from '@pellux/goodvibes-sdk/platform/providers';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { createDaemonVerbCaller } from './client/operator-endpoint.ts';
import { createTerminalApprovalUpdateSubscriber } from './client/approval-updates.ts';
import { createHostedSessionsClient } from './client/hosted-sessions.ts';
import { getSharedHostedSessionRoster } from './client/hosted-roster.ts';
import {
  createClientApprovalRaiser,
  createConversationRewindHost,
  createDaemonConfigClient,
  createDaemonCredentialsClient,
  createDevicesClient,
  createWireSessionDispatch,
} from '@pellux/goodvibes-sdk/platform/runtime/client';
import { createFleetUnionReadModel } from './client/fleet-union.ts';
import { createSessionConversationRewindPort, hasSessionConversation } from './conversation-rewind-port.ts';
import { createFleetReadModel } from '../panels/fleet-read-model.ts';
import type { PermissionPromptDecision, PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';
export type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  const disposalScope = createDisposalScope('RuntimeServices'); const workingDirectory = options.workingDir; // disposal seam: see ./disposal-wiring.ts
  const homeDirectory = options.homeDirectory;
  // Built before anything that touches session state — see session-storage-services.ts.
  const { surface, sessionManager } = createSessionStorageServices({ workingDirectory, homeDirectory });
  const configManager = options.configManager;
  const featureFlags = options.featureFlags ?? createFeatureFlagManager();
  if (options.featureFlags === undefined) {
    // Owned manager: gate states derive from domain settings keys + live
    // bridge (mirrors the SDK composition root; a passed manager is the caller's to wire).
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    bindFeatureSettingsBridge(configManager, featureFlags);
  }

  // ── The client seams: one resolution of "which daemon", shared by all of them.
  const verbs = createDaemonVerbCaller({ configManager, homeDirectory });
  const daemonConfig = createDaemonConfigClient(verbs);
  const devices = createDevicesClient(verbs);
  // Daemon-hosted sessions: the session picker (built in the input layer, which
  // has no config manager to resolve a daemon from) reads the roster; this is
  // the one place that can give it a client. See client/hosted-roster.ts.
  getSharedHostedSessionRoster().bindClient(createHostedSessionsClient(verbs));

  // Built here rather than read off the client composition below because the
  // approval seam it feeds is an INPUT to that composition: the path service is
  // pure (it derives paths, it opens nothing), so building it twice costs
  // nothing and keeps the ordering honest.
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  // The surface's own record of the asks it raised — what the approval card and
  // the panel read. The AUTHORITATIVE record is the daemon's; the raiser below
  // keeps the two in step (see the SDK's client/approval-raiser.ts).
  const approvalBroker = new ApprovalBroker({
    storePath: shellPaths.resolveProjectPath('tui', 'control-plane', 'approvals.json'),
  });
  // The late-bound terminal prompt: the UI layer patches the real implementation
  // in after boot, exactly as it always did.
  const localPromptRef: { requestPermission: (request: PermissionPromptRequest) => Promise<PermissionPromptDecision> } = {
    requestPermission: async () => ({ approved: false, remember: false }),
  };
  const liveSessionIdRef: { value: string | null } = { value: null };
  const requestApproval = createClientApprovalRaiser({
    verbs,
    // The SDK's raiser cannot honestly default this: it names how THIS surface
    // reports its own decision back to the daemon (`actorSurface`), so every
    // other surface can see where the answer came from. Reproduces the
    // previous hard-coded `actor: 'tui', actorSurface: 'tui'` write-back exactly.
    actor: 'tui',
    sessionId: () => liveSessionIdRef.value,
    // The "local prompt" is this surface's own broker plus the terminal ask:
    // that is what puts the ask on the approval card and in the panel while the
    // daemon holds the record every other surface reads.
    localPrompt: () => (request) => approvalBroker.requestApproval({
      request,
      ...(liveSessionIdRef.value ? { sessionId: liveSessionIdRef.value } : {}),
      localPrompt: (prompt) => localPromptRef.requestPermission(prompt),
    }),
    // The push channel for a decision made on another surface. Without it the
    // raiser learns by re-reading the record on an interval; with it a phone's
    // answer reaches this terminal in the time one SSE frame takes. The interval
    // stays as the fallback — see client/approval-updates.ts.
    subscribeApprovalUpdates: createTerminalApprovalUpdateSubscriber({ configManager, homeDirectory }),
  });

  // ── The SDK's client floor: everything a turn needs in this process.
  const client = createClientRuntimeServices({
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    configManager,
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDirectory,
    featureFlags,
    requestApproval,
    ...(options.daemonHomeDirectory === undefined ? {} : { daemonHome: options.daemonHomeDirectory }),
  });
  const runtimeDispatch = createDomainDispatch(options.runtimeStore);
  const workspaceTrustManager = new WorkspaceTrustManager({ shellPaths });
  const {
    agentManager, agentMessageBus, agentOrchestrator, archetypeLoader,
    contextAccountingHolder, providerRegistry, providerCapabilityRegistry, cacheHitTracker,
    favoritesStore, benchmarkStore, modelLimitsService, toolLLM,
    secretsManager, serviceRegistry, subscriptionManager, hookDispatcher, hookActivityTracker,
    hookWorkbench, pluginManager, workflow, artifactStore, webSearchProviders, webSearchService,
    mcpRegistry: clientMcpRegistry, sandboxSessionRegistry: clientSandboxRegistry,
    processManager, modeManager, fileUndoManager, overflowHandler, policyRuntimeState,
    fileCache, projectIndex, sessionOrchestration,
  } = client;
  void clientMcpRegistry; void clientSandboxRegistry;
  disposalScope.registry.add('client runtime services', () => client.dispose());

  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
  providerRegistry.initCustomProviders();
  // Background, TTL-respecting live model discovery so provider model lists
  // refresh from their own listing APIs.
  providerRegistry.initProviderModelDiscovery();

  // A daemon-scoped credential goes to the daemon over `credentials.set`, which
  // writes the value AND points the config key at it in one verified sequence.
  // Everything else stays in this surface's own store.
  const daemonCredentials = createDaemonCredentialsClient(verbs);

  // Memory governance seams built EARLY so the scheduler gates and the knowledge
  // background jobs can consult the pause controller before the MemoryGovernor
  // (constructed at the composition tail) drives it.
  const cacheRegistry = new CacheRegistry();
  const pauseController = new PauseController();
  const MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'];
  const admitExpensiveWorkRef: { current: ((label: string) => { allowed: boolean; reason?: string | undefined }) | null } = { current: null };
  const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
    admitExpensiveWorkRef.current?.(label) ?? { allowed: true };
  const isKnowledgeBackgroundPaused = (): boolean => pauseController.isPaused('knowledge-self-improvement');
  const panelManager = new PanelManager();
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
  // An EMPTY catalog. This product answers no verbs; the field exists only
  // because the SDK's startExternalServices takes a daemon-grade graph even in
  // the adopt-only mode this surface runs in, and because plugin loading is
  // handed one. With adoptOnly no DaemonServer is constructed, so nothing is
  // ever served off it.
  const gatewayMethods = new GatewayMethodCatalog();
  // The credential/identity seam (credential-composition.ts) — this
  // installation's own pairing tokens and step-up service.
  const { stepUpService, pairingTokens } = composeCredentialServices({
    workingDirectory, homeDirectory, configManager,
    ...(options.daemonHomeDirectory === undefined ? {} : { daemonHomeDirectory: options.daemonHomeDirectory }),
    pairingTokenPath: shellPaths.resolveUserPath('control-plane', 'pairing-tokens.json'),
  });
  const localUserAuthManager = options.localUserAuthManager ?? new UserAuthManager({
    bootstrapFilePath: shellPaths.resolveUserPath('tui', 'auth-users.json'),
    bootstrapCredentialPath: shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt'),
  });
  const profileManager = new ProfileManager(shellPaths.resolveUserPath('tui', 'profiles'));
  const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath('tui', 'bookmarks'));
  // The watcher framework is the daemon's to RUN; this registry is the surface's
  // read/edit handle on the same store, so `/watch` still lists and edits.
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath('tui', 'watchers.json'),
    featureFlags,
  });
  watcherRegistry.attachRuntime({
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  // WRFC over the client's own agent graph — the "floor, not ceiling" case,
  // verbatim: the review/fix workstream controller needs the agent manager and
  // the message bus, and nothing daemon-side at all.
  const wrfcController = new WrfcController(options.runtimeBus, agentMessageBus, {
    agentManager,
    configManager,
    projectRoot: workingDirectory,
  });
  agentManager.setWrfcController(wrfcController);
  const sessionBroker = new SharedSessionBroker({
    storePath: shellPaths.resolveProjectPath('tui', 'control-plane', 'sessions.json'),
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
    conversationGateConfig: configManager, // without this the gate runs on DEFAULTS
  });
  // Work that arrives for a session THIS surface hosts reaches the loop through
  // the same runner whether it came from the local broker or from the daemon's
  // queue. The wire half is inert until bootstrap.ts adopts a daemon (see
  // the SDK's client/session-dispatch.ts); binding one runner to both is what stops a
  // continuation delivered over the wire from taking a different path — and a
  // different set of routing options — than one raised locally.
  const wireSessionDispatch = createWireSessionDispatch({
    hostedSessionIds: () => (liveSessionIdRef.value ? [liveSessionIdRef.value] : []),
  });
  disposalScope.registry.add('wire session dispatch', () => wireSessionDispatch.stop());
  // The parameter type comes from the broker's own runner rather than being
  // re-declared: a hand-written copy would drift from the routing options the
  // spawn actually forwards, and the drift would be silent.
  type ContinuationRequest = Parameters<NonNullable<Parameters<typeof sessionBroker.setContinuationRunner>[0]>>[0];
  const continuationRunner = async ({ task, input }: ContinuationRequest): Promise<{ agentId: string }> => {
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
  };
  sessionBroker.setContinuationRunner(continuationRunner);
  wireSessionDispatch.setContinuationRunner(continuationRunner);
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
    secretsManager,
    serviceRegistry,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    routeBindings,
    artifactStore,
    featureFlags,
  });
  const automationManager = new AutomationManager({
    configManager,
    defaultSurfaceKind: 'tui',
    routeBindings,
    sessionBroker,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    deliveryManager,
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
  // Voice: the PROVIDERS are local (a spoken turn plays out of this terminal's
  // own speaker) — synthesis reaches `voice.tts.stream` when a daemon serves it
  // and falls back to a local provider otherwise; see audio/spoken-turn-wiring.ts.
  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders, { readConfig: (key) => configManager.get(key as Parameters<typeof configManager.get>[0]) });
  const voiceService = new VoiceService(voiceProviders);
  for (const [semantic, ingest] of [[knowledgeSemanticService, knowledgeService], [agentKnowledgeSemanticService, agentKnowledgeService], [homeGraphSemanticService, homeGraphService]] as const) {
    semantic.setGapRepairer(createWebKnowledgeGapRepairer({ searchService: webSearchService, ingestService: ingest }));
  }
  const mediaProviders = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry);
  const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, knowledgeService);
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

  // Remote runners and the sandboxes tool calls are confined to; see
  // remote-execution-composition.ts for why the four are built as one.
  const { remoteRunnerRegistry, remoteSupervisor, sandboxSessionRegistry, mcpRegistry }
    = createRemoteExecutionServices({
      agentManager, workingDirectory, hookDispatcher, configManager, runtimeBus: options.runtimeBus,
    });
  const tokenAuditor = new ApiTokenAuditor({ managed: false, featureFlags });
  const componentHealthMonitor = new ComponentHealthMonitor();
  const worktreeRegistry = new WorktreeRegistry(workingDirectory);
  const webhookNotifier = new WebhookNotifier();
  const focusTracker = new FocusTracker();
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  const providerOptimizer = client.providerOptimizer;
  bindProviderOptimizerFeatureFlag(featureFlags, providerOptimizer);
  applyProviderOptimizerConfigMode(configManager, providerOptimizer);
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker(); const sessionChangeTracker = new SessionChangeTracker();
  const planManager = new ExecutionPlanManager(workingDirectory);
  const adaptivePlanner = new AdaptivePlanner();
  const idempotencyStore = new IdempotencyStore();
  // ONE router, not two. This surface used to build a second ChannelDeliveryRouter
  // from the same four arguments AutomationDeliveryManager builds its own from,
  // and expose that second one — so the router on the service surface and the
  // router replies actually leave through were different objects, and a delivery
  // strategy registered on the exposed one reached nothing. The SDK's
  // RuntimeServices contract requires the field; it now names the real router.
  const channelDeliveryRouter = deliveryManager.getDeliveryRouter();
  // The phase/work-item orchestration engine, constructed before the process
  // registry so its fleet nodes can be folded in below.
  const { orchestrationEngine, workstreamCommands } = createWorkstreamServices({
    agentManager, configManager, adaptivePlanner, runtimeBus: options.runtimeBus, projectRoot: workingDirectory,
  });
  // Repo source-tree code index, sharing memoryEmbeddingRegistry with MemoryStore.
  const { codeIndexStore, codeIndexReindexScheduler } = createCodeIndexServices({ workingDirectory, configManager, memoryEmbeddingRegistry, isReindexPaused: () => pauseController.isPaused('code-index-reindex'), admitExpensiveWork });
  const codeInjectionOrchestratorDeps = { codeIndex: codeIndexStore, isCodeInjectionSettingEnabled: () => isCodeInjectionSettingEnabled(configManager), codeIndexReindexScheduler };
  // Store snapshots, the periodic append-only sweep, durable remembered-approval rules + the live credential chain.
  const { storeSnapshotScheduler, appendOnlyRetentionScheduler, userPermissionRuleStore, stopDurabilityHousekeeping, stopConfigWatch } = createDurabilityServices({
    configManager, secretsManager, providerRegistry, memoryDbPath, codeIndexDbPath: codeIndexDbPath(workingDirectory), surface, shellPaths,
    ...(options.currentSessionId ? { currentSessionId: options.currentSessionId } : {}),
  });
  const { processRegistry } = createFleetServices({ // Shared archive-aware fleet registry — see fleet-services.ts
    agentManager, wrfcController,
    orchestrationEngine,
    codeIndexService: codeIndexStore,
    processManager, watcherRegistry, workflow, approvalBroker, sessionBroker,
    messageBus: agentMessageBus,
    automationManager,
    runtimeBus: options.runtimeBus,
    providerRegistry,
  });
  // What the Fleet panel reads: this surface's own live registry UNION the
  // adopted daemon's rows. The daemon runs work no registry here knows about
  // (scheduled jobs, channel-driven runs, sessions other surfaces started, the
  // external agents it observes), and a panel showing only half the fleet is
  // worse than one showing none — the half it shows looks complete.
  const fleetReadModel = createFleetUnionReadModel({
    local: createFleetReadModel(processRegistry, options.runtimeBus),
    verbs,
  });
  disposalScope.registry.add('fleet union refresh', () => fleetReadModel.stop());
  // Conversation-scope rewind, from ANY surface. The daemon holds the
  // checkpoint store and answers the files half; the messages live in this
  // process, so this offers them and answers the daemon's questions about them.
  // Started on adoption (bootstrap.ts), released on disposal.
  const conversationRewindHost = createConversationRewindHost({
    verbs,
    port: createSessionConversationRewindPort(),
    hosts: hasSessionConversation,
    label: 'the terminal app',
  });
  disposalScope.registry.add('conversation rewind host', () => { void conversationRewindHost.stop(); });
  const workspaceCheckpointManager = createWorkspaceCheckpointing({ workspaceRoot: workingDirectory, surface, runtimeBus: options.runtimeBus, configManager });
  const { memoryConsolidationScheduler, powerManager, sessionLiveTurnControls } = wireIdlePowerAndLiveTurn({ configManager, memoryRegistry, runtimeBus: options.runtimeBus, isIdle: () => sessionBroker.countBusySessions() === 0 && !pauseController.isPaused('memory-consolidation') && admitExpensiveWork('memory consolidation').allowed, snapshotTick: () => storeSnapshotScheduler.tick(), heartbeat: async () => { await automationManager.triggerHeartbeat({ source: 'wake-catchup' }); }, powerSeam: options.powerSeam });

  const { memoryGovernor } = wireMemoryGovernance({
    configManager,
    runtimeBus: options.runtimeBus,
    cacheRegistry,
    pauseController,
    jobIds: MEMORY_BACKGROUND_JOB_IDS,
    receiptPath: shellPaths.resolveProjectPath('tui', 'memory', 'tripwire-receipt.json'),
    knowledgeStores: [knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore],
    sessionBroker,
    onTripwireShutdown: async () => { await storeSnapshotScheduler.snapshotAllAsync('tripwire'); },
  });
  admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label);

  // Managed local-voice provisioning (voice.local.status/install) — single-flight
  // one-act install + no-network status; see voice-setup-services.ts.
  const { voiceSetup, stopWakeHousekeeping } = wireVoiceSetup({ configManager, shellPaths, voiceProviders, admitExpensiveWork,
    provisionWakeModelsAtBoot: options.provisionWakeModelsAtBoot === true });
  void voiceSetup;

  const integrationHelpers = new IntegrationHelperService({
    surface, configManager, automationManager, approvalBroker, sessionBroker, distributedRuntime,
    remoteRunnerRegistry, remoteSupervisor, panelManager, localUserAuthManager, providerRegistry,
    serviceRegistry, subscriptionManager, secretsManager,
    runtimeStore: options.runtimeStore, runtimeBus: options.runtimeBus,
    getConversationTitle: options.getConversationTitle,
  });
  // A loopback fetch that isn't allow-listed asks once through the CLIENT raiser;
  // "allow for this project" persists and later fetches never ask.
  const localhostFetchApproval = buildLocalhostFetchApproval({ requestApproval: (input) => requestApproval(input), configManager });
  // Exec stuck on a terminal prompt rides the same raiser; the typed answer feeds
  // the continuing run. Built once and shared with every setDependencies site —
  // a wholesale replace that forgets it hangs interactive prompts.
  const execPromptAnswerHandler = buildExecPromptAnswerHandler({ requestApproval: (input) => requestApproval(input) });
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

  // Give the panel_only notification target a live producer.
  const notificationDispatcher = createNotificationDispatcher(configManager);
  wireRuntimeNotificationBridge(options.runtimeBus, notificationDispatcher);
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
    requestApproval,
    daemonVerbs: verbs,
    wireSessionDispatch,
    conversationRewindHost,
    gatewayMethods,
    stepUpService,
    pairingTokens,
    devices,
    daemonConfig,
    daemonCredentials,
    localPromptRef,
    liveSessionIdRef,
    localhostFetchApproval,
    execPromptAnswerHandler,
    notificationDispatcher,
    userPermissionRuleStore,
    sessionBroker,
    deliveryManager,
    automationManager,
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
    fleetReadModel,
    modeManager,
    fileUndoManager,
    workspaceCheckpointManager,
    integrationHelpers,
    rerootStores: createStoreRerooter({ codeIndexStore, projectIndex }),
    cancelHostedAgentRuns: () => cancelAllAgentRuns(agentManager),
    dispose: (): void => disposalScope.dispose(),
  };
  registerSurfaceRuntimePollers(disposalScope.registry, services, { stopConfigWatch }); return services;
}
