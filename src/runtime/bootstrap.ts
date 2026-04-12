/**
 * Bootstrap composition root for goodvibes-tui.
 *
 * Initializes all runtime subsystems in dependency order and returns a
 * RuntimeContext that main.ts uses to drive the render loop and terminal I/O.
 *
 * Separation of concerns:
 *   - bootstrap.ts: initialization, event wiring, manager setup
 *   - main.ts: terminal setup, render loop, stdin/stdout handlers
 *   - lifecycle.ts: save/shutdown helpers
 */
import { ConversationManager } from '../core/conversation.ts';
import { Orchestrator } from '../core/orchestrator.ts';
import { SelectionManager } from '../input/selection.ts';
import { ConfigManager, getConfiguredSystemPrompt, getWorkingDirectory } from '../config/index.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { registerAllTools } from '../tools/index.ts';
import { PermissionManager, createPermissionConfigReader } from '../permissions/manager.ts';
import { AcpManager } from '../acp/manager.ts';
import { Notifier } from '../integrations/notifier.ts';
import { WebhookNotifier } from '../integrations/webhooks.ts';
import { getTierPromptSupplement, getTierForContextWindow } from '../providers/tier-prompts.ts';
import { logger } from '../utils/logger.ts';
import { Compositor } from '../renderer/compositor.ts';
import type { PermissionRequestHandler } from '../permissions/prompt.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHistory } from '../input/input-history.ts';
import type { GitStatusProvider } from '../renderer/git-status.ts';
import type { GitHeaderInfo } from '../renderer/git-status.ts';

import type { RuntimeContext, BootstrapOptions, MutableRuntimeState } from './context.ts';
import { shutdownRuntime, fireSessionStart, saveSession } from './lifecycle.ts';
import { createFeatureFlagManager } from './feature-flags/index.ts';
import { RuntimeEventBus } from './events/index.ts';
import { createRuntimeStore, createDomainDispatch } from './store/index.ts';
import { createTaskManager } from './tasks/index.ts';
import { OpsControlPlane } from './ops/control-plane.ts';
import { AcpTaskAdapter } from './tasks/adapters/acp-adapter.ts';
import { ForensicsCollector, ForensicsRegistry } from './forensics/index.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import { emitSessionReady, emitSessionStarted } from './emitters/index.ts';
import {
  generateUserSessionId,
  getLastSessionPointerPath,
  getRecoveryFilePath,
  loadLastConversation,
  writeLastSessionPointer,
} from './session-persistence.ts';
import { scheduleMcpAutodiscovery, startBackgroundProviderRegistration } from './bootstrap-background.ts';
import { loadBootstrapSystemPrompt, restoreSavedModel, syncConfiguredServices } from './bootstrap-helpers.ts';
import { registerBootstrapHookBridge } from './bootstrap-hook-bridge.ts';
import { registerBootstrapRuntimeEvents } from './bootstrap-runtime-events.ts';
import { startExternalServices, type ExternalServicesHandle } from './bootstrap-services.ts';
import { createRuntimeServices } from './services.ts';
import { createUiRuntimeServices } from './ui-services.ts';
import { createDeferredStartupCoordinator } from './deferred-startup.ts';
import { createBootstrapShell } from './bootstrap-shell.ts';

// ── Bootstrap context type ──────────────────────────────────────────────────

/**
 * The fully-initialized context returned by bootstrapRuntime().
 *
 * A typed superset of RuntimeContext that exposes the additional fields required
 * by main.ts (UI-layer objects that do not belong in the shared RuntimeContext
 * interface, since they are not needed by anything else).
 */
export type BootstrapContext = RuntimeContext & {
  /** Compositor handles double-buffered terminal output. */
  compositor: Compositor;
  /** Manages text selection state. */
  selection: SelectionManager;
  /** Context object passed to slash-command handlers. */
  commandContext: CommandContext;
  /** Persists and navigates input history across sessions. */
  inputHistory: InputHistory;
  /** Provides git branch/dirty state for the header. */
  gitStatusProvider: GitStatusProvider;
  /** Mutable ref so async git refreshes propagate without closure capture issues. */
  lastGitInfoRef: { value: GitHeaderInfo | undefined };
  /** Unsubscribe functions owned by bootstrap (cleared on shutdown). */
  bootstrapUnsubs: Array<() => void>;
  /** Ref holding the periodic agent-status interval (use ref — not local var — to keep shutdown in sync). */
  agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null };
  /** Mutable refs for viewport/scroll/render functions; main.ts patches these after constructing UI state. */
  orchestratorRefs: { getViewportHeight: () => number; scrollToEnd: (vHeight: number) => void; requestRender: () => void };
  /** Patch the bootstrap-owned render bridge after main.ts constructs the real render loop. */
  setRenderRequest: (fn: () => void) => void;
  /** Shell-owned permission prompt bridge that main.ts patches after UI setup. */
  permissionPromptRef: { requestPermission: PermissionRequestHandler };
  /** Load the most recently saved conversation from disk. */
  loadLastConversation: () => { messages: Array<Record<string, unknown>> } | null;
  /** Write the last-session pointer file (used after session resume). */
  _writeLastSessionPointer: (sessionId: string) => void;
  /** Save a conversation snapshot to disk. */
  _saveSession: typeof saveSession;
  /** Retrieve pinned model IDs for the model picker. */
  _getPinned: () => Promise<string[]>;
  /** Retrieve configured provider IDs for the model picker. */
  _getConfiguredProviderIds: () => string[];
  /** Command registry used by InputHandler. main.ts needs this to wire input. */
  commandRegistry: import('../input/command-registry.ts').CommandRegistry;
  /**
   * System message router instantiated at startup, wired to conversation and panel manager.
   *
   * @remarks
   * Route operational messages through this rather than calling
   * conversation.addSystemMessage() directly so that low-priority messages
   * stay out of the main conversation and go to the SystemMessagesPanel instead.
   */
  systemMessageRouter: SystemMessageRouter;
};

// ── Bootstrap function ────────────────────────────────────────────────────

/**
 * Initialize all runtime subsystems and return a fully-wired RuntimeContext.
 *
 * main.ts calls this once, then uses the returned context to:
 *   - Run the render loop
 *   - Handle stdin/stdout events
 *   - Manage terminal lifecycle (alt-screen, raw mode, resize)
 *
 * Phase summary:
 *   1. Config, caches, keybindings
 *   2. Runtime event bus, conversation, compositor, selection
 *   3. Tool registry + agent wiring
 *   4. Runtime bus subscriptions (WRFC, subagent, hook bridge)
 *   5. Providers, webhooks, PermissionManager, HookDispatcher
 *   6. Orchestrator + AcpManager
 *   7. MCP auto-connect + panel manager
 *   8. Command registry + plugin init + CommandContext
 *   9. Input handler wiring
 *  10. Input history, splash options
 *  11. Background: provider auto-registration, persisted providers, scan
 */
export async function bootstrapRuntime(
  stdout: NodeJS.WriteStream,
  options?: BootstrapOptions,
): Promise<BootstrapContext> {
  const workingDir = options?.workingDir ?? getWorkingDirectory();
  const configManager = options?.configManager ?? new ConfigManager({ workingDir });

  // ── Phase 0: Feature flags ──────────────────────────────────────────────

  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({ flags: (configManager.getCategory('featureFlags') as Record<string, import('./feature-flags/types.ts').FlagState>) ?? {} });

  // ── Phase 1: Config, caches, keybindings ────────────────────────────────

  const userSessionId = `user-${generateUserSessionId()}`;

  // ── Phase 2: Core subsystems ─────────────────────────────────────────

  const runtimeBus = new RuntimeEventBus();
  const store = createRuntimeStore();
  const domainDispatch = createDomainDispatch(store);
  let getConversationTitle = (): string | undefined => undefined;
  const services = createRuntimeServices({
    configManager,
    featureFlags,
    runtimeBus,
    runtimeStore: store,
    getConversationTitle: () => getConversationTitle(),
    workingDir,
  });
  const providerRegistry = services.providerRegistry;
  providerRegistry.initModelLimits();
  services.benchmarkStore.initBenchmarks();
  providerRegistry.initCatalog();
  // Load keybindings from disk (merges user overrides with defaults)
  services.keybindingsManager.loadFromDisk();
  domainDispatch.syncControlPlaneState({
    enabled: Boolean(configManager.get('controlPlane.enabled')),
    host: String(configManager.get('controlPlane.host') ?? '127.0.0.1'),
    port: Number(configManager.get('controlPlane.port') ?? 3421),
    connectionState: configManager.get('controlPlane.enabled') ? 'connected' : 'disabled',
    isRunning: Boolean(configManager.get('controlPlane.enabled')),
  }, 'bootstrap.control-plane');
  domainDispatch.syncControlPlaneClient({
    id: 'client:tui',
    kind: 'tui',
    label: 'Terminal UI',
    transport: 'local',
    connected: true,
    sessionId: userSessionId,
    authenticatedAt: Date.now(),
    lastSeenAt: Date.now(),
    capabilities: ['session', 'panels', 'commands', 'automation'],
      metadata: {},
  }, 'bootstrap.control-plane');
  const {
    approvalBroker,
    automationManager,
    deliveryManager,
    hookDispatcher,
    hookWorkbench,
    memoryRegistry,
    memoryStore,
    panelManager,
    pluginManager,
    routeBindings,
    sessionBroker: sharedSessionBroker,
    surfaceRegistry,
    watcherRegistry,
  } = services;
  const uiServices = createUiRuntimeServices(services);
  let getControlPlaneRecentEvents = (_limit: number): readonly import('../control-plane/gateway.ts').ControlPlaneRecentEvent[] => [];
  routeBindings.attachRuntime({ runtimeBus, runtimeStore: store });
  surfaceRegistry.attachRuntime(store);
  surfaceRegistry.syncConfiguredSurfaces();
  watcherRegistry.attachRuntime({ runtimeBus, runtimeStore: store });
  if (configManager.get('watchers.enabled')) {
    watcherRegistry.registerPollingWatcher({
      id: 'runtime-heartbeat',
      label: 'Runtime heartbeat',
      source: {
        id: 'source:runtime-heartbeat',
        kind: 'watcher',
        label: 'Runtime heartbeat',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {},
      },
      intervalMs: Number(configManager.get('watchers.heartbeatIntervalMs') ?? 30_000),
      run: () => new Date().toISOString(),
    });
    watcherRegistry.startWatcher('runtime-heartbeat');
  }
  automationManager.attachRuntime({ runtimeBus, runtimeStore: store, deliveryManager });

  const forensicsRegistry = new ForensicsRegistry();
  const forensicsCollector = new ForensicsCollector(runtimeBus, forensicsRegistry);
  const policyRuntimeState = services.policyRuntimeState;
  const tokenAuditor = services.tokenAuditor;

  const conversation = new ConversationManager(() => {
    const w = stdout.columns || 80;
    if (panelManager.isVisible() && panelManager.getAllOpen().length > 0) {
      return Math.max(1, panelManager.getLeftWidth(w) - 1);
    }
    return w;
  });
  conversation.setConfigManager(configManager);
  getConversationTitle = () => conversation.title;

  const compositor = new Compositor(stdout);
  const selection = new SelectionManager();

  // ── Phase 3: Tool registry + agent wiring ───────────────────────────

  const toolRegistry = new ToolRegistry();
  const { fileCache, projectIndex } = registerAllTools(toolRegistry, {
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus,
    wrfcController: services.wrfcController,
    webSearchService: services.webSearchService,
    channelRegistry: services.channelPlugins,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    workflowServices: services.workflow,
    mcpRegistry: services.mcpRegistry,
    sessionOrchestration: services.sessionOrchestration,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    configManager,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry,
    overflowHandler: services.overflowHandler,
    changeTracker: services.sessionChangeTracker,
  });
  services.agentOrchestrator.setDependencies({
    fileCache,
    projectIndex,
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    webSearchService: services.webSearchService,
    channelRegistry: services.channelPlugins,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    knowledgeService: services.knowledgeService,
    archetypeLoader: services.archetypeLoader,
    configManager,
    providerRegistry: services.providerRegistry,
    providerOptimizer: services.providerOptimizer,
    toolLLM: services.toolLLM,
    serviceRegistry: services.serviceRegistry,
    featureFlags: services.featureFlags,
    overflowHandler: services.overflowHandler,
    memoryRegistry: services.memoryRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
  });

  // ── Phase 4: Event bus subscriptions ──────────────────────────────────

  // These unsubs are owned by bootstrap; cleared via shutdown()
  const bootstrapUnsubs: Array<() => void> = [];
  await memoryStore.init();
  bootstrapUnsubs.push(() => {
    void memoryStore.save();
    memoryStore.close();
  });
  const renderRequestRef = {
    value: (): void => {},
  };
  const requestRender = (): void => {
    renderRequestRef.value();
  };
  const permissionPromptRef = {
    requestPermission: (async () => ({ approved: false, remember: false })) as PermissionRequestHandler,
  };
  void approvalBroker.start();
  void sharedSessionBroker.start();
  let runtimeSessionId = userSessionId;
  let systemMessageRouterRef: SystemMessageRouter | null = null;
  const { unsubs: runtimeUnsubs, agentStatusIntervalRef } = registerBootstrapRuntimeEvents({
    runtimeBus,
    domainDispatch,
    getSystemMessageRouter: () => systemMessageRouterRef,
    requestRender,
    configManager,
    agentManager: services.agentManager,
    wrfcController: services.wrfcController,
  });

  // ── Phase 5: Providers, webhooks, PermissionManager, HookDispatcher ─────────

  // Start watching for custom provider file changes (hot-reload)
  providerRegistry.startWatching(runtimeBus);

  const webhookUrls = (configManager.getCategory('notifications') as { webhookUrls?: string[] }).webhookUrls ?? [];
  if (webhookUrls.length > 0) {
    const webhookNotifier = WebhookNotifier.fromConfig(webhookUrls);
    webhookNotifier.attachToRuntimeBus(runtimeBus);
    domainDispatch.syncIntegration({
      id: 'webhooks',
      displayName: 'Webhooks',
      category: 'communication',
      status: 'healthy',
      enabled: true,
      successCount: 0,
      errorCount: 0,
      meta: { urlCount: webhookUrls.length },
    }, 'bootstrap.webhooks');
  }

  const notifier = await Notifier.fromConfig();
  const queueStatuses = notifier.getQueueStatus();
  if (queueStatuses.length > 0) {
    notifier.attachToRuntimeBus(runtimeBus);
    for (const queueStatus of queueStatuses) {
      domainDispatch.syncIntegration({
        id: queueStatus.channel,
        displayName: queueStatus.channel[0]!.toUpperCase() + queueStatus.channel.slice(1),
        category: 'communication',
        status: queueStatus.metrics.deadLettered > 0 ? 'degraded' : 'healthy',
        enabled: true,
        successCount: queueStatus.metrics.delivered,
        errorCount: queueStatus.metrics.deadLettered,
        ...(queueStatus.dlqEntries[0]?.deadAt ? { lastErrorAt: queueStatus.dlqEntries[0].deadAt } : {}),
        ...(queueStatus.dlqEntries[0]?.finalError ? { lastError: queueStatus.dlqEntries[0].finalError } : {}),
        meta: {
          attempts: queueStatus.metrics.totalAttempts,
          retrying: queueStatus.metrics.retrying,
          deadLetters: queueStatus.metrics.deadLettered,
          dlqSize: queueStatus.metrics.dlqSize,
          sloEnforced: queueStatus.sloEnforced,
        },
      }, 'bootstrap.notifier');
    }
  }

  await syncConfiguredServices(domainDispatch.syncIntegration, services.serviceRegistry);

  const permissionManager = new PermissionManager(
    (request) => approvalBroker.requestApproval({
      request,
      sessionId: runtimeSessionId,
      localPrompt: permissionPromptRef.requestPermission,
    }),
    createPermissionConfigReader(configManager),
    policyRuntimeState,
    services.hookDispatcher,
  );
  await hookWorkbench.loadAndApplyManagedHooks();

  // ── Phase 5b: Runtime state object ───────────────────────────────────────

  const runtime: MutableRuntimeState = {
    model: configManager.get('provider.model') as string,
    provider: configManager.get('provider.provider') as string,
    debugMode: false,
    systemPrompt: loadBootstrapSystemPrompt(configManager) || getConfiguredSystemPrompt(configManager) || '',
    reasoningEffort: (configManager.get('provider.reasoningEffort') as string | undefined) ?? '',
    sessionId: userSessionId,
  };
  runtimeSessionId = runtime.sessionId;
  void sharedSessionBroker.createSession({
    id: runtime.sessionId,
    title: 'Terminal UI session',
    metadata: { source: 'tui' },
    participant: {
      surfaceKind: 'tui',
      surfaceId: 'surface:tui',
      displayName: 'Terminal UI',
      lastSeenAt: Date.now(),
    },
  }).catch(() => {});

  domainDispatch.syncSessionState({
    id: userSessionId,
    projectRoot: getWorkingDirectory(),
    status: 'active',
    startedAt: Date.now(),
    recoveryState: 'ready',
    isResumed: false,
    wasRepaired: false,
    lineageId: userSessionId,
    lineage: [{ sessionId: userSessionId, createdAt: Date.now() }],
  }, 'bootstrap.session');

  // ── Phase 5c: Hook bridge subscriptions ────────────────────────────────

  runtimeUnsubs.push(
    ...registerBootstrapHookBridge({
      runtimeBus,
      hookDispatcher,
      runtime,
    }),
  );

  // ── Phase 6: Orchestrator + AcpManager ───────────────────────────────────

  // Mutable function refs so main.ts can patch these after constructing the scroll/viewport state.
  // The orchestrator closes over these refs, so patching them in main.ts takes immediate effect.
  const orchestratorRefs = {
    getViewportHeight: (): number => 20,
    scrollToEnd: (_vHeight: number): void => { /* patched by main.ts */ },
    requestRender: (): void => { requestRender(); },
  };

  const orchestrator = new Orchestrator(
    conversation,
    () => orchestratorRefs.getViewportHeight(),
    (vHeight: number) => orchestratorRefs.scrollToEnd(vHeight),
    toolRegistry,
    permissionManager,
    () => {
      const currentModel = providerRegistry.getCurrentModel();
      const contextWindow = providerRegistry.getContextWindowForModel(currentModel);
      const tier = getTierForContextWindow(contextWindow);
      const supplement = getTierPromptSupplement(tier);
      return supplement ? runtime.systemPrompt + '\n\n' + supplement : runtime.systemPrompt;
    },
    hookDispatcher,
    null,
    () => orchestratorRefs.requestRender(),
    runtimeBus,
    {
      agentManager: services.agentManager,
      wrfcController: services.wrfcController,
    },
  );
  orchestrator.setCoreServices({
    configManager,
    providerRegistry,
    cacheHitTracker: services.cacheHitTracker,
    planManager: services.planManager,
    adaptivePlanner: services.adaptivePlanner,
    sessionMemoryStore: services.sessionMemoryStore,
    sessionLineageTracker: services.sessionLineageTracker,
    idempotencyStore: services.idempotencyStore,
  });
  conversation.setSessionLineageTracker(services.sessionLineageTracker);

  const acpManager = new AcpManager(
    (request) => permissionPromptRef.requestPermission(request),
    runtimeBus,
    services.hookDispatcher,
  );
  const acpTaskAdapter = new AcpTaskAdapter(store);
  const ACP_TASK_SYNC_INTERVAL_MS = 1_000;
  const acpTaskSyncInterval = setInterval(() => {
    acpTaskAdapter.sync(acpManager);
  }, ACP_TASK_SYNC_INTERVAL_MS);
  bootstrapUnsubs.push(() => clearInterval(acpTaskSyncInterval));
  orchestrator.registerDelegateTool(acpManager);

  const shell = createBootstrapShell({
    configManager,
    runtimeBus,
    runtimeStore: store,
    services,
    conversation,
    runtime,
    orchestrator,
    requestRender,
    permissionPromptRef,
    onSessionIdChanged: (sessionId) => {
      runtimeSessionId = sessionId;
    },
    writeLastSessionPointer,
    getControlPlaneRecentEvents,
    toolRegistry,
    forensicsRegistry,
    policyRuntimeState,
    uiServices,
    completeModelSelectionSideEffect: () => {
      compositor.resetDiff();
    },
  });
  const systemMessageRouter = shell.systemMessageRouter;
  systemMessageRouterRef = systemMessageRouter;
  const commandRegistry = shell.commandRegistry;
  const commandContext = shell.commandContext;
  const gitStatusProvider = shell.gitStatusProvider;
  const inputHistory = shell.inputHistory;
  const lastGitInfoRef = shell.lastGitInfoRef;

  // ── Phase 7: External services + deferred startup ──────────────────────

  const deferredStartup = createDeferredStartupCoordinator();

  let externalServices: ExternalServicesHandle = {
    daemonServer: null,
    httpListener: null,
    listRecentControlPlaneEvents: () => [],
    async stop(): Promise<void> {},
  };
  let externalServicesPromise: Promise<ExternalServicesHandle> | null = null;
  deferredStartup.schedule({
    label: 'plugins',
    run: async () => {
      await pluginManager.init({
        runtimeBus,
        commandRegistry,
        providerRegistry,
        toolRegistry,
        gatewayMethods: services.gatewayMethods,
        channelRegistry: services.channelPlugins,
        channelDeliveryRouter: services.deliveryManager.getDeliveryRouter(),
        memoryEmbeddingRegistry: services.memoryEmbeddingRegistry,
        voiceProviderRegistry: services.voiceProviders,
        mediaProviderRegistry: services.mediaProviders,
        webSearchProviderRegistry: services.webSearchProviders,
        getPluginConfig: (name) => pluginManager.getPluginConfig(name),
        isEnabled: (name) => pluginManager.isEnabled(name),
      });
      requestRender();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Deferred plugin startup failed', { error: message });
      systemMessageRouter.high(`[Startup] Plugin initialization failed: ${message}`);
      requestRender();
    },
  });
  deferredStartup.schedule({
    label: 'external-services',
    run: async () => {
      externalServicesPromise = startExternalServices(
        configManager,
        runtimeBus,
        hookDispatcher,
        {},
        services,
      );
      externalServices = await externalServicesPromise;
      getControlPlaneRecentEvents = (limit) => externalServices.listRecentControlPlaneEvents(limit);
      requestRender();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Deferred external service startup failed', { error: message });
      systemMessageRouter.high(`[Startup] Background services failed to start: ${message}`);
      requestRender();
    },
  });

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
  };

  // ── Phase 8: Background provider registration (non-blocking) ────────────
  // These run after the initial render so they don't delay startup.

  startBackgroundProviderRegistration({
    configManager,
    providerRegistry,
    runtime,
    requestRender,
    restoreSavedModel,
    systemMessageRouter,
  });
  if (configManager.get('automation.enabled')) {
    deferredStartup.schedule({
      label: 'automation',
      run: async () => {
        await automationManager.start();
        requestRender();
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Deferred automation startup failed', { error: message });
        systemMessageRouter.high(`[Startup] Automation failed to initialize: ${message}`);
        requestRender();
      },
    });
  }

  // ── Phase 12: Session:start lifecycle hook ─────────────────────────────

  fireSessionStart(runtime.sessionId, services.hookDispatcher);
  emitSessionStarted(runtimeBus, {
    sessionId: runtime.sessionId,
    traceId: `${runtime.sessionId}:session-start`,
    source: 'bootstrap',
  }, {
    sessionId: runtime.sessionId,
    profileId: 'default',
    workingDir: getWorkingDirectory(),
  });
  emitSessionReady(runtimeBus, {
    sessionId: runtime.sessionId,
    traceId: `${runtime.sessionId}:session-ready`,
    source: 'bootstrap',
  }, {
    sessionId: runtime.sessionId,
  });

  // ── Compose RuntimeContext ────────────────────────────────────────────────

  const ctx: BootstrapContext = {
    runtimeBus,
    store,
    services,
    featureFlags,
    conversation,
    permissions: permissionManager,
    toolRegistry,
    providerRegistry,
    panelHealthMonitor: services.panelHealthMonitor,
    worktreeRegistry: services.worktreeRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    hookDispatcher,
    fileCache,
    projectIndex,
    sessionId: userSessionId,
    isResumed: false, // Sessions start fresh; use /session resume to load a previous one
    runtime,
    orchestrator,
    compositor,
    selection,
    commandContext,
    inputHistory,
    gitStatusProvider,
    lastGitInfoRef,
    bootstrapUnsubs,
    agentStatusIntervalRef,
    orchestratorRefs,
    setRenderRequest: (fn: () => void) => {
      renderRequestRef.value = fn;
    },
    permissionPromptRef,
    loadLastConversation: loadLastConversation,
    _writeLastSessionPointer: writeLastSessionPointer,
    _saveSession: saveSession,
    _getPinned: () => services.favoritesStore.getPinned(),
    _getConfiguredProviderIds: () => services.providerRegistry.getConfiguredProviderIds(),
    commandRegistry,
    systemMessageRouter,
    shutdown: async (sessionData) => {
      // Clear bootstrap-owned subscriptions
      bootstrapUnsubs.forEach(fn => fn());
      bootstrapUnsubs.length = 0;
      runtimeUnsubs.forEach((fn) => fn());
      runtimeUnsubs.length = 0;
      forensicsCollector.dispose();
      await deferredStartup.drain(100);
      if (externalServicesPromise) {
        try {
          externalServices = await externalServicesPromise;
        } catch {
          // Startup failures are already surfaced through the deferred task handler.
        }
      }
      await externalServices.stop();
      // Clear agent status interval via ref (consistent with agentStatusIntervalRef usage)
      if (agentStatusIntervalRef.value !== null) {
        clearInterval(agentStatusIntervalRef.value);
        agentStatusIntervalRef.value = null;
      }
      await shutdownRuntime(
        runtime.sessionId,
        sessionData,
        runtime.model,
        runtime.provider,
        conversation.title || '',
        services.workflow.scheduleManager,
        services.hookDispatcher,
        services.providerRegistry,
        services.sessionOrchestration,
      );
    },
  };

  // ── Phase 12b: Operator Control Plane wiring (feature-gated) ──────────────
  // Wire the OpsControlPlane into CommandContext when the feature flag is enabled.
  // The store and task manager are created unconditionally so they reflect the
  // real runtime state (tasks registered before the flag check are visible).
  const opsTaskManager = createTaskManager(store, runtimeBus, userSessionId);
  ctx.commandContext.taskManager = opsTaskManager;
  ctx.commandContext.acpManager = acpManager;
  if (featureFlags.isEnabled('operator-control-plane')) {
    const opsControlPlane = new OpsControlPlane(opsTaskManager, runtimeBus, store, userSessionId);
    ctx.commandContext.opsControlPlane = opsControlPlane;
    ctx.commandContext.openOpsPanel = () => {
      if (ctx.commandContext.showPanel) ctx.commandContext.showPanel('ops-control');
      else {
        panelManager.open('ops-control');
        requestRender();
      }
    };
  }

  // Wire exit from options if provided; otherwise main.ts binds the shell bridge.
  if (options?.exit) {
    ctx.commandContext.exit = options.exit;
  }

  return ctx;
}
