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
import { Orchestrator } from '../core/orchestrator.ts';
import { AcpManager } from '@pellux/goodvibes-sdk/platform/acp/manager';
import { getTierPromptSupplement, getTierForContextWindow } from '@pellux/goodvibes-sdk/platform/providers/tier-prompts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions/prompt';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHistory } from '../input/input-history.ts';
import type { GitStatusProvider } from '../renderer/git-status.ts';
import type { GitHeaderInfo } from '../renderer/git-status.ts';
import type { SelectionManager } from '../input/selection.ts';
import type { Compositor } from '../renderer/compositor.ts';

import type { RuntimeContext, BootstrapOptions } from './context.ts';
import { shutdownRuntime, fireSessionStart, saveSession } from '@pellux/goodvibes-sdk/platform/runtime/lifecycle';
import { createTaskManager } from '@pellux/goodvibes-sdk/platform/runtime/tasks/index';
import { OpsControlPlane } from '@pellux/goodvibes-sdk/platform/runtime/ops/control-plane';
import { AcpTaskAdapter } from '@pellux/goodvibes-sdk/platform/runtime/tasks/adapters/acp-adapter';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import { emitSessionReady, emitSessionStarted } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';
import {
  loadLastConversation,
  writeLastSessionPointer,
} from '@pellux/goodvibes-sdk/platform/runtime/session-persistence';
import { startBackgroundProviderRegistration } from '@pellux/goodvibes-sdk/platform/runtime/bootstrap-background';
import { restoreSavedModel } from '@pellux/goodvibes-sdk/platform/runtime/bootstrap-helpers';
import { startExternalServices, type ExternalServicesHandle } from '@pellux/goodvibes-sdk/platform/runtime/bootstrap-services';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing/companion-token';
import type { UiRuntimeServices } from './ui-services.ts';
import { createDeferredStartupCoordinator } from '@pellux/goodvibes-sdk/platform/runtime/deferred-startup';
import { initializeBootstrapCore } from './bootstrap-core.ts';
import { createBootstrapShell } from './bootstrap-shell.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

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
  /** Shell-facing read models, events, and narrow runtime services. */
  uiServices: UiRuntimeServices;
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
  options: BootstrapOptions,
): Promise<BootstrapContext> {
  const workingDir = options.workingDir;
  const configManager = options.configManager;
  const controlPlaneRecentEventsRef: {
    value: (limit: number) => readonly import('@pellux/goodvibes-sdk/platform/control-plane/gateway').ControlPlaneRecentEvent[];
  } = {
    value: (_limit) => [],
  };
  const {
    userSessionId,
    runtimeBus,
    store,
    services,
    uiServices,
    conversation,
    compositor,
    selection,
    toolRegistry,
    fileCache,
    projectIndex,
    permissionManager,
    forensicsCollector,
    forensicsRegistry,
    runtime,
    bootstrapUnsubs,
    runtimeUnsubs,
    agentStatusIntervalRef,
    permissionPromptRef,
    systemMessageRouterRef,
    conversationFollowUpRef,
    requestRender,
    setRenderRequest,
    runtimeSessionIdRef,
  } = await initializeBootstrapCore(stdout, options, (limit) => controlPlaneRecentEventsRef.value(limit));
  const providerRegistry = services.providerRegistry;
  const {
    automationManager,
    hookDispatcher,
    panelManager,
    pluginManager,
  } = services;

  // ── Phase 6: Orchestrator + AcpManager ───────────────────────────────────

  // Mutable function refs so main.ts can patch these after constructing the scroll/viewport state.
  // The orchestrator closes over these refs, so patching them in main.ts takes immediate effect.
  const orchestratorRefs = {
    getViewportHeight: (): number => 20,
    scrollToEnd: (_vHeight: number): void => { /* patched by main.ts */ },
    requestRender: (): void => { requestRender(); },
  };

  const orchestrator = new Orchestrator({
    conversation,
    getViewportHeight: () => orchestratorRefs.getViewportHeight(),
    scrollToEnd: (vHeight: number) => orchestratorRefs.scrollToEnd(vHeight),
    toolRegistry,
    permissionManager,
    getSystemPrompt: () => {
      const currentModel = providerRegistry.getCurrentModel();
      const contextWindow = providerRegistry.getContextWindowForModel(currentModel);
      const tier = getTierForContextWindow(contextWindow);
      const supplement = getTierPromptSupplement(tier);
      return supplement ? runtime.systemPrompt + '\n\n' + supplement : runtime.systemPrompt;
    },
    hookDispatcher,
    requestRender: () => orchestratorRefs.requestRender(),
    runtimeBus,
    services: {
      agentManager: services.agentManager,
      wrfcController: services.wrfcController,
    },
  });
  conversationFollowUpRef.value = (item) => orchestrator.enqueueConversationFollowUp(item);
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
  const opsTaskManager = createTaskManager(store, runtimeBus, userSessionId);
  const opsControlPlane = services.featureFlags.isEnabled('operator-control-plane')
    ? new OpsControlPlane(opsTaskManager, runtimeBus, store, userSessionId)
    : undefined;

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
      runtimeSessionIdRef.value = sessionId;
    },
    writeLastSessionPointer,
    getControlPlaneRecentEvents: (limit) => controlPlaneRecentEventsRef.value(limit),
    toolRegistry,
    forensicsRegistry,
    policyRuntimeState: services.policyRuntimeState,
    uiServices,
    taskManager: opsTaskManager,
    opsControlPlane,
    completeModelSelectionSideEffect: () => {
      compositor.resetDiff();
    },
  });
  const systemMessageRouter = shell.systemMessageRouter;
  systemMessageRouterRef.value = systemMessageRouter;
  const commandRegistry = shell.commandRegistry;
  const commandContext = shell.commandContext;
  const gitStatusProvider = shell.gitStatusProvider;
  const inputHistory = shell.inputHistory;
  const lastGitInfoRef = shell.lastGitInfoRef;
  const pluginCommandRegistry = {
    register(command: {
      readonly name: string;
      readonly aliases?: readonly string[];
      readonly description: string;
      readonly usage?: string;
      readonly argsHint?: string;
      readonly handler: (args: string[]) => void | Promise<void>;
    }): void {
      commandRegistry.register({
        ...command,
        aliases: command.aliases ? [...command.aliases] : undefined,
      });
    },
    unregister(name: string): void {
      commandRegistry.unregister(name);
    },
  };

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
        commandRegistry: pluginCommandRegistry,
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
      const message = summarizeError(error);
      logger.error('Deferred plugin startup failed', { error: message });
      systemMessageRouter.high(`[Startup] Plugin initialization failed: ${message}`);
      requestRender();
    },
  });
  deferredStartup.schedule({
    label: 'external-services',
    run: async () => {
      // Register the persistent companion-pairing token as the daemon's shared
      // bearer, so tokens scanned from the /qrcode panel's QR actually
      // authenticate against the embedded daemon this surface starts.
      const companionTokenRecord = getOrCreateCompanionToken('tui');
      externalServicesPromise = startExternalServices(
        configManager,
        runtimeBus,
        hookDispatcher,
        { sharedDaemonToken: companionTokenRecord.token },
        services,
      );
      externalServices = await externalServicesPromise;
      controlPlaneRecentEventsRef.value = (limit) => externalServices.listRecentControlPlaneEvents(limit);
      requestRender();
    },
    onError: (error) => {
      const message = summarizeError(error);
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
    shellPaths: services.shellPaths,
    surfaceRoot: 'tui',
  });
  if (configManager.get('automation.enabled')) {
    deferredStartup.schedule({
      label: 'automation',
      run: async () => {
        await automationManager.start();
        requestRender();
      },
      onError: (error) => {
        const message = summarizeError(error);
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
    workingDir,
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
    featureFlags: services.featureFlags,
    conversation,
    permissions: permissionManager,
    toolRegistry,
    providerRegistry,
    componentHealthMonitor: services.componentHealthMonitor,
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
    uiServices,
    inputHistory,
    gitStatusProvider,
    lastGitInfoRef,
    bootstrapUnsubs,
    agentStatusIntervalRef,
    orchestratorRefs,
    setRenderRequest,
    permissionPromptRef,
    loadLastConversation: () => loadLastConversation({
      workingDirectory: services.workingDirectory,
      homeDirectory: services.homeDirectory,
      sessionManager: services.sessionManager,
    }),
    _writeLastSessionPointer: (sessionId) => writeLastSessionPointer(sessionId, {
      workingDirectory: services.workingDirectory,
      homeDirectory: services.homeDirectory,
    }),
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
        {
          workingDirectory: services.workingDirectory,
          homeDirectory: services.homeDirectory,
          sessionManager: services.sessionManager,
        },
      );
    },
  };

  // ── Phase 12b: Operator Control Plane wiring (feature-gated) ──────────────
  // Wire the OpsControlPlane into CommandContext when the feature flag is enabled.
  // The store and task manager are created unconditionally so they reflect the
  // real runtime state (tasks registered before the flag check are visible).
  ctx.commandContext.ops.acpManager = acpManager;
  if (opsControlPlane) {
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
