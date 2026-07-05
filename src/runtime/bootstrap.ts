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
import { join } from 'node:path';
import { Orchestrator, type OrchestratorUserInputOptions } from '../core/orchestrator.ts';
import { AcpManager } from '@pellux/goodvibes-sdk/platform/acp';
import { getTierPromptSupplement, getTierForContextWindow } from '@pellux/goodvibes-sdk/platform/providers';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHistory } from '../input/input-history.ts';
import type { GitStatusProvider } from '../renderer/git-status.ts';
import type { GitHeaderInfo } from '../renderer/git-status.ts';
import type { SelectionManager } from '../input/selection.ts';
import type { Compositor } from '../renderer/compositor.ts';

import type { RuntimeContext, BootstrapOptions } from './context.ts';
import { shutdownRuntime, fireSessionStart, saveSession } from '@/runtime/index.ts';
import { createTaskManager } from '@/runtime/index.ts';
import { OpsControlPlane } from '@/runtime/index.ts';
import { AcpTaskAdapter } from '@/runtime/index.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import { emitSessionReady, emitSessionStarted } from '@/runtime/index.ts';
import {
  loadLastConversation,
  writeLastSessionPointer,
} from '@/runtime/index.ts';
import { scheduleBackgroundMcpDiscovery, startBackgroundProviderRegistration } from '@/runtime/index.ts';
import { restoreSavedModel } from '@/runtime/index.ts';
import { startExternalServices, type ExternalServicesHandle, type HostServiceStatus } from '@/runtime/index.ts';
import { createHttpTransport } from '@/runtime/index.ts';
import { foldLegacySpineStore, type SpineSessionsClient } from './session-spine-client.ts';
import { pruneStaleOperatorTokens } from '@pellux/goodvibes-sdk/platform/pairing';
import { resolveDaemonCompanionToken, workspaceOperatorTokenCandidates } from './operator-token-cleanup.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { createDeferredStartupCoordinator } from '@/runtime/index.ts';
import { initializeBootstrapCore } from './bootstrap-core.ts';
import { createBootstrapShell } from './bootstrap-shell.ts';
import { announceResumeState } from './resume-notice.ts';
import { buildSharedOrchestratorCoreServices } from './orchestrator-core-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { DaemonServer } from '@pellux/goodvibes-sdk/platform/daemon';
import { HttpListener } from '@pellux/goodvibes-sdk/platform/daemon';
import { createSafeHostServeFactory } from '../daemon/safe-serve.ts';
import { startMcpConfigAutoReload } from '../mcp/runtime-reload.ts';

type ExternalServiceFactories = NonNullable<Parameters<typeof startExternalServices>[4]>;

const TUI_ORCHESTRATION_GUARDRAILS = [
  '## GoodVibes TUI Orchestration Guardrails',
  '- If the user asks to make, build, implement, create, add, fix, update, or patch something, preserve that implementation request. Do not restate it as design-only, planning-only, read-only, or no-write work unless the user explicitly requested that.',
  '- Do not add "Do not write files", restrict tools to read/find/inspect, or remove write/exec capability for implementation work unless the user explicitly asked for read-only analysis.',
  '- For one deliverable that needs WRFC, reviewed implementation, testing, verification, or review/fix cycles, use one `agent` spawn with `template: "engineer"` and `reviewMode: "wrfc"` whose `task` is the full user request. Do not batch-spawn sibling Engineer/Reviewer/Tester/Verifier roots for the same deliverable.',
  '- Use `batch-spawn` only for genuinely independent sidecar tasks. Review, test, verify, and fix phases for one deliverable belong inside the WRFC owner chain.',
  '- If an `agent` tool result reports `authoritativeWrfcChain: true`, `continueRootSpawning: false`, or `orchestrationStopSignal: "wrfc_owner_chain_started"`, stop spawning root agents for that deliverable and wait/report status instead.',
].join('\n');

function joinPromptParts(...parts: Array<string | null | undefined>): string {
  return parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)).join('\n\n');
}

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
   * System message router instantiated at startup, wired to conversation.
   *
   * @remarks
   * Route operational messages through this rather than calling
   * conversation.addSystemMessage() directly so routing-target config
   * (panel/conversation/both) and the forced-inline critical prefixes stay
   * centralized in one place.
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
 *   7. MCP auto-connect + workspace/panel manager
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
    value: (limit: number) => readonly import('@pellux/goodvibes-sdk/platform/control-plane').ControlPlaneRecentEvent[];
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
    orchestratorHandleUserInputRef,
    requestRender,
    setRenderRequest,
    runtimeSessionIdRef,
    wrfcPersistence,
    sessionSpine,
    sessionInboundInputs,
    sessionUnionCache,
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
      return joinPromptParts(runtime.systemPrompt, TUI_ORCHESTRATION_GUARDRAILS, supplement);
    },
    hookDispatcher,
    flagManager: services.featureFlags,
    requestRender: () => orchestratorRefs.requestRender(),
    runtimeBus,
    sessionId: runtime.sessionId,
    services: {
      agentManager: services.agentManager,
      wrfcController: services.wrfcController,
    },
  });
  conversationFollowUpRef.value = (item) => orchestrator.enqueueConversationFollowUp(item);
  // Wire orchestratorHandleUserInputRef so COMPANION_MESSAGE_RECEIVED fires a real LLM turn.
  orchestratorHandleUserInputRef.value = (text: string, options?: OrchestratorUserInputOptions) => {
    orchestrator.handleUserInput(text, undefined, options).catch((err: unknown) => {
      logger.debug('companion handleUserInput safety catch', { error: String(err) });
    });
  };
  // Shared payload (single source of truth, includes wo805's memoryRegistry —
  // see orchestrator-core-services.ts) plus this site's cacheHitTracker.
  orchestrator.setCoreServices({
    ...buildSharedOrchestratorCoreServices({ services, configManager, providerRegistry }),
    cacheHitTracker: services.cacheHitTracker,
  });
  conversation.setSessionLineageTracker(services.sessionLineageTracker);

  const acpManager = new AcpManager({
    requestPermission: (request) => permissionPromptRef.requestPermission(request),
    runtimeBus,
    hookDispatcher: services.hookDispatcher,
  });
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
    sessionSpine,
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
  wrfcPersistence.rehydrate();
  const commandRegistry = shell.commandRegistry;
  const commandContext = shell.commandContext;
  // Boot resume notice (UX-D item 1): after rehydrate() so chain history is
  // ready, before the operator can type anything. Fire-and-forget — the
  // checkpoint-count lookup is async (WorkspaceCheckpointManager.list() awaits
  // its own init()), and this must not block the rest of bootstrap the way
  // main.ts's `void workspaceCheckpointManager.init().catch(() => {})`
  // deliberately doesn't either. Local file I/O only; resolves well before a
  // human can react to the first rendered frame.
  void announceResumeState({
    workingDirectory: services.workingDirectory,
    homeDirectory: services.homeDirectory,
    surfaceRoot: 'tui',
    sessionManager: services.sessionManager,
    checkpointManager: services.workspaceCheckpointManager,
    chainHistory: wrfcPersistence.knownChains,
    memoryAvailable: Boolean(commandContext.clients?.knowledgeApi?.memory),
    router: systemMessageRouter,
  }).catch(() => {
    // Best-effort — never let the resume notice block or crash boot.
  });
  const gitStatusProvider = shell.gitStatusProvider;
  const inputHistory = shell.inputHistory;
  const lastGitInfoRef = shell.lastGitInfoRef;
  // W1.6 FIX 2: dispose the header's live-repo-state poll (git-status.ts
  // startPolling) on shutdown, same pattern as acpTaskSyncInterval above.
  bootstrapUnsubs.push(() => gitStatusProvider.stopPolling());
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

  const formatHostServiceBaseUrl = (host: string, port: number): string => {
    const normalized = host.trim().toLowerCase();
    const probeHost = normalized === '0.0.0.0'
      ? '127.0.0.1'
      : normalized === '::' || normalized === '[::]'
        ? '::1'
        : host;
    const urlHost = probeHost.includes(':') && !probeHost.startsWith('[') ? `[${probeHost}]` : probeHost;
    return `http://${urlHost}:${port}`;
  };

  const createPendingServiceStatus = (
    service: 'daemon' | 'httpListener',
  ): HostServiceStatus => {
    const host = String(configManager.get(service === 'daemon' ? 'controlPlane.host' : 'httpListener.host') ?? '127.0.0.1');
    const port = Number(configManager.get(service === 'daemon' ? 'controlPlane.port' : 'httpListener.port') ?? (service === 'daemon' ? 3421 : 3422));
    return {
      mode: 'unavailable',
      host,
      port,
      baseUrl: formatHostServiceBaseUrl(host, port),
      reason: 'Background service startup has not completed yet',
    };
  };

  const hostServiceIsActive = (status: HostServiceStatus): boolean => status.mode === 'embedded' || status.mode === 'external';

  // 'blocked' (occupied by an unverified process) and 'incompatible' (occupied
  // by a GoodVibes daemon we refused to adopt on a wire-version mismatch) both
  // mean the configured port is held and unusable by this TUI instance.
  const hostServiceIsBlocked = (status: HostServiceStatus): boolean => status.mode === 'blocked' || status.mode === 'incompatible';

  // S3c (One-Platform Wave 2): ONE client-selection point for the session
  // spine, driven by the SAME authoritative HostServiceMode adopt-or-start
  // already computed above (no separate probe). 'embedded' means THIS
  // process's own SharedSessionBroker already IS the daemon's broker (they
  // share runtimeServices) — nothing to mirror, so the spine stays dormant,
  // which is today's exact behavior. Every other mode ('disabled', 'blocked',
  // 'incompatible', 'unavailable') also stays local-only and honest — no
  // daemon this TUI trusts is reachable. Only 'external' (a compatible daemon
  // this TUI adopted rather than started) activates the wire mirror.
  let spineActiveForBaseUrl: string | null = null;
  const syncSessionSpineToHostStatus = (daemonStatus: HostServiceStatus, sharedDaemonToken: string): void => {
    if (daemonStatus.mode !== 'external') {
      if (spineActiveForBaseUrl !== null) {
        sessionSpine.deactivate(`daemon mode changed to '${daemonStatus.mode}'`);
        sessionInboundInputs.deactivate(`daemon mode changed to '${daemonStatus.mode}'`);
        spineActiveForBaseUrl = null;
      }
      // S3d: keep the read facade honest per mode. 'embedded' means this
      // process's broker IS the daemon's broker (local reads are the whole
      // truth); every other non-external mode is local-only/dormant.
      if (daemonStatus.mode === 'embedded') sessionUnionCache.markEmbedded();
      else sessionUnionCache.deactivate(`daemon mode '${daemonStatus.mode}'`);
      logger.info(`[bootstrap] session spine: daemon mode '${daemonStatus.mode}' — local-only (no spine mirror)`);
      return;
    }
    const baseUrl = daemonStatus.baseUrl;
    if (spineActiveForBaseUrl === baseUrl) return; // already wired to this exact adopted daemon
    const httpTransport = createHttpTransport({ baseUrl, authToken: sharedDaemonToken });
    const sessionsClient: SpineSessionsClient = {
      register: (input) => httpTransport.operator.sessions.register(input),
      close: (sessionId) => httpTransport.operator.sessions.close(sessionId),
    };
    sessionSpine.activate(sessionsClient);
    // D3: adopt the same daemon's wire for the INBOUND steer path — collect
    // steer/follow-up inputs another live surface queued for this session and
    // inject them into the turn machinery (acking delivery on the wire).
    sessionInboundInputs.activate({
      listInputs: (sessionId, opts) => httpTransport.operator.sessions.inputs.list(sessionId, opts),
      deliverInput: (sessionId, inputId, opts) => httpTransport.operator.sessions.inputs.deliver(sessionId, inputId, opts),
    });
    // S3d: adopt the same daemon's wire as the read facade's cross-surface union
    // source (interval-refreshed; served synchronously to panels).
    sessionUnionCache.activate({ list: (limit) => httpTransport.operator.sessions.list(limit) });
    spineActiveForBaseUrl = baseUrl;
    logger.info(`[bootstrap] session spine: adopted external daemon at ${baseUrl} — mirroring session identity`);
    // Legacy fold: one-time (marker-guarded) import of this project's own
    // pre-spine control-plane sessions.json into the now-adopted daemon.
    const legacyStorePath = services.shellPaths.resolveProjectPath('tui', 'control-plane', 'sessions.json');
    const fold = foldLegacySpineStore(sessionSpine, {
      storePath: legacyStorePath,
      markerPath: `${legacyStorePath}.spine-migrated`,
      project: services.workingDirectory,
    });
    if (fold.folded > 0) {
      logger.info(`[bootstrap] session spine: folded ${fold.folded} legacy local session(s) into the adopted daemon`);
    }
  };

  const inspectExternalServices = () => {
    const daemonStatus = externalServices.daemonStatus;
    const httpListenerStatus = externalServices.httpListenerStatus;
    return {
      daemonRunning: hostServiceIsActive(daemonStatus),
      daemonPortInUse: hostServiceIsBlocked(daemonStatus),
      httpListenerRunning: hostServiceIsActive(httpListenerStatus),
      httpListenerPortInUse: hostServiceIsBlocked(httpListenerStatus),
      daemonStatus,
      httpListenerStatus,
      // S3c: honest session-spine posture, independent of daemonRunning —
      // 'external'-adopted-but-currently-unreachable degrades to 'offline'
      // here even though daemonRunning might still read true from a stale
      // handle, because sessionSpine.status() is driven by this client's OWN
      // live wire attempts, not the one-shot adopt probe.
      sessionSpineActive: sessionSpine.active,
      sessionSpineStatus: sessionSpine.status(),
    };
  };

  const waitForConfigDrivenRestarts = async (handle: ExternalServicesHandle): Promise<void> => {
    const waitForRestart = async (service: unknown): Promise<void> => {
      const maybeRestarting = service as { waitForRestart?: unknown } | null;
      if (typeof maybeRestarting?.waitForRestart === 'function') {
        await maybeRestarting.waitForRestart();
      }
    };

    await Promise.all([
      waitForRestart(handle.daemonServer),
      waitForRestart(handle.httpListener),
    ]);
  };

  const createExternalServiceFactories = (sharedDaemonToken: string): ExternalServiceFactories => ({
    sharedDaemonToken,
    createDaemonServer: (bus, userAuth, runtimeServices) => new DaemonServer({
      runtimeBus: bus,
      userAuth,
      runtimeServices,
      serveFactory: createSafeHostServeFactory('Embedded daemon'),
    }),
    createHttpListener: (dispatcher, userAuth, configManager) => new HttpListener({
      hookDispatcher: dispatcher,
      userAuth,
      configManager,
      serveFactory: createSafeHostServeFactory('Embedded HTTP listener'),
    }),
  });

  let externalServices: ExternalServicesHandle = {
    daemonServer: null,
    httpListener: null,
    daemonStatus: createPendingServiceStatus('daemon'),
    httpListenerStatus: createPendingServiceStatus('httpListener'),
    listRecentControlPlaneEvents: () => [],
    async stop(): Promise<void> {},
  };
  let externalServicesPromise: Promise<ExternalServicesHandle> | null = null;
  const platformExternalServices = uiServices.platform as typeof uiServices.platform & {
    externalServices: NonNullable<typeof uiServices.platform.externalServices>;
  };
  platformExternalServices.externalServices = {
    inspect: inspectExternalServices,
    restart: async () => {
      if (externalServicesPromise) {
        try {
          externalServices = await externalServicesPromise;
        } catch {
          // A failed previous startup should not prevent a restart attempt.
        }
      }
      await waitForConfigDrivenRestarts(externalServices);
      await externalServices.stop();
      const daemonHomeDir = join(services.homeDirectory, '.goodvibes', 'daemon');
      const companionTokenRecord = resolveDaemonCompanionToken(daemonHomeDir);
      externalServicesPromise = startExternalServices(
        configManager,
        runtimeBus,
        hookDispatcher,
        services,
        createExternalServiceFactories(companionTokenRecord.token),
      );
      externalServices = await externalServicesPromise;
      controlPlaneRecentEventsRef.value = (limit) => externalServices.listRecentControlPlaneEvents(limit);
      syncSessionSpineToHostStatus(externalServices.daemonStatus, companionTokenRecord.token);
      requestRender();
      return inspectExternalServices();
    },
  };
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
      const daemonHomeDir = join(services.homeDirectory, '.goodvibes', 'daemon');
      const companionTokenRecord = resolveDaemonCompanionToken(daemonHomeDir);
      // F3 resolution (TUI 0.19.20): remove stale pre-0.21.28 workspace-scoped operator
      // token files so only the canonical <daemonHomeDir>/operator-tokens.json survives.
      // The prune is best-effort — it silently skips missing files, no-ops when tokens
      // already match, and records un-deletable candidates in `failedPaths` for logging.
      // See `pruneStaleOperatorTokens` in the SDK for semantics.
      const prune = pruneStaleOperatorTokens({
        daemonHomeDir,
        candidatePaths: workspaceOperatorTokenCandidates(services.workingDirectory),
      });
      if (prune.prunedPaths.length > 0) {
        logger.info(`[bootstrap] Pruned ${prune.prunedPaths.length} stale operator-token file(s): ${prune.prunedPaths.join(', ')}`);
      }
      if (prune.failedPaths.length > 0) {
        logger.warn(`[bootstrap] Failed to prune ${prune.failedPaths.length} stale operator-token file(s) (permission/race): ${prune.failedPaths.join(', ')}`);
      }
      externalServicesPromise = startExternalServices(
        configManager,
        runtimeBus,
        hookDispatcher,
        services,
        createExternalServiceFactories(companionTokenRecord.token),
      );
      externalServices = await externalServicesPromise;
      controlPlaneRecentEventsRef.value = (limit) => externalServices.listRecentControlPlaneEvents(limit);
      syncSessionSpineToHostStatus(externalServices.daemonStatus, companionTokenRecord.token);
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
    restoreRuntimeModel: restoreSavedModel,
    systemMessageRouter,
    shellPaths: services.shellPaths,
    surfaceRoot: 'tui',
  });
  const mcpDiscovery = scheduleBackgroundMcpDiscovery({
    mcpRegistry: services.mcpRegistry,
    systemMessageRouter,
    requestRender,
    shellPaths: services.shellPaths,
    surfaceRoot: 'tui',
  });
  bootstrapUnsubs.push(() => mcpDiscovery.stop());
  const mcpAutoReload = startMcpConfigAutoReload({
    roots: services.shellPaths,
    registry: services.mcpRegistry,
    onReload: ({ connected, total }) => {
      systemMessageRouter.low(`[MCP] Reloaded config: ${connected}/${total} server(s) connected.`);
      requestRender();
    },
    onError: (error) => {
      const message = summarizeError(error);
      logger.warn('MCP config auto-reload failed', { error: message });
      systemMessageRouter.high(`[MCP] Config reload failed: ${message}`);
      requestRender();
    },
  });
  bootstrapUnsubs.push(() => mcpAutoReload.stop());
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
      // S3c: honest close on exit — fire-and-forget (never blocks shutdown);
      // a no-op when the spine was never activated (embedded/local-only).
      sessionSpine.close(runtime.sessionId);
      sessionSpine.dispose();
      sessionInboundInputs.dispose(); // D3: stop the inbound steer poll interval on exit
      sessionUnionCache.dispose(); // S3d: stop the wire-refresh interval on exit
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
