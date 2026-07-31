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
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions';
import type { WorkspaceTrustLevel } from './trust/workspace-trust.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHistory } from '../input/input-history.ts';
import type { GitStatusProvider, GitHeaderInfo } from '../renderer/git-status.ts';
import type { SelectionManager } from '../input/selection.ts';
import type { Compositor } from '../renderer/compositor.ts';

import type { RuntimeContext, BootstrapOptions } from './context.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import {
  shutdownRuntime, fireSessionStart, createTaskManager, OpsControlPlane, AcpTaskAdapter,
  emitSessionReady, emitSessionStarted, loadLastConversation, leaveHostedSessionOnExit,
  scheduleBackgroundMcpDiscovery, startBackgroundProviderRegistration, restoreSavedModel, startExternalServices,
  type ExternalServicesHandle, type HostServiceStatus, createHttpTransport, createDeferredStartupCoordinator,
} from '@/runtime/index.ts';
import { bindWriteLastSessionPointerToSurface } from './session-pointer-surface.ts';
import { foldLegacySpineStore, deriveSpineFooterStatus } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import { createSpineAdoptionSync } from './client/spine-adoption.ts';
import { pruneStaleOperatorTokens } from '@pellux/goodvibes-sdk/platform/pairing';
import { resolveDaemonCompanionToken, workspaceOperatorTokenCandidates } from './operator-token-cleanup.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { initializeBootstrapCore } from './bootstrap-core.ts';
import { ensureBootModelResolvable } from './provider-fallback.ts';
import { createBootstrapShell } from './bootstrap-shell.ts';
import { announceResumeState } from './resume-notice.ts';
import { announceInstallHealth } from './install-self-check-startup.ts';
import { buildSharedOrchestratorCoreServices, refreshMemoryRecallSnapshot } from './orchestrator-core-services.ts';
import { consumeDaemonAttachNotices, readExternalDaemonAttach } from './daemon-attach-notices.ts';
import { wireContextAccountingSource } from './context-accounting-source.ts';
import { autostartInstalledDaemon, createDaemonServiceControl, describeDaemonAutostart } from '@pellux/goodvibes-sdk/platform/runtime/client';
import { DaemonBuildFloor } from './client/build-floors.ts';
import { relayReadAccessors } from './relay-reachability-bridge.ts';
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
  /** Shell-owned trust-decision bridge that main.ts patches after UI setup (trust asks at consequence time). */
  trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel> };
  /** Load the most recently saved conversation from disk. */
  loadLastConversation: () => { messages: Array<Record<string, unknown>> } | null;
  /** Write the last-session pointer file (used after session resume). */
  _writeLastSessionPointer: (sessionId: string) => void;
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
    permissionPromptRef, trustPromptRef,
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
  // A saved custom-provider model must never crash boot — see provider-fallback.ts.
  await ensureBootModelResolvable(providerRegistry, configManager);

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
  // Wire orchestratorHandleUserInputRef so COMPANION_MESSAGE_RECEIVED fires a real LLM turn (after a pre-turn recall-snapshot refresh; see main.ts's submitInput).
  orchestratorHandleUserInputRef.value = (text: string, options?: OrchestratorUserInputOptions) => {
    void refreshMemoryRecallSnapshot(services).then(() => orchestrator.handleUserInput(text, undefined, options)).catch((err: unknown) => {
      logger.debug('companion handleUserInput safety catch', { error: String(err) });
    });
  };
  // Shared payload (single source of truth, includes the memoryRegistry —
  // see orchestrator-core-services.ts) plus this site's cacheHitTracker.
  orchestrator.setCoreServices({
    ...buildSharedOrchestratorCoreServices({ services, configManager, providerRegistry }),
    cacheHitTracker: services.cacheHitTracker,
  });
  conversation.setSessionLineageTracker(services.sessionLineageTracker);

  // Bind context_accounting's session source to the live Orchestrator (see context-accounting-source.ts).
  wireContextAccountingSource({
    orchestrator, providerRegistry, sessionLineageTracker: services.sessionLineageTracker, runtimeBus, sessionId: runtime.sessionId,
  }, services.contextAccountingHolder, bootstrapUnsubs);

  const acpManager = new AcpManager({
    requestPermission: (request) => permissionPromptRef.requestPermission(request),
    runtimeBus, hookDispatcher: services.hookDispatcher,
  });
  const acpTaskAdapter = new AcpTaskAdapter(store);
  const ACP_TASK_SYNC_INTERVAL_MS = 1_000;
  const acpTaskSyncInterval = setInterval(() => {
    acpTaskAdapter.sync(acpManager);
  }, ACP_TASK_SYNC_INTERVAL_MS);
  bootstrapUnsubs.push(() => clearInterval(acpTaskSyncInterval));
  orchestrator.registerDelegateTool(acpManager);
  const opsTaskManager = createTaskManager(store, runtimeBus, userSessionId, services.featureFlags); // featureFlags required: without it runtime.unifiedTasks configured nothing (permissive fallback); SDK default matches shipped behaviour, so this is a no-op for existing installs.
  // Operator interventions ride the control-plane gateway capability
  // (controlPlane.gateway, on by default; the old never-registered gate id shipped this dead).
  const opsControlPlane = services.featureFlags.isEnabled('control-plane-gateway')
    ? new OpsControlPlane(opsTaskManager, runtimeBus, store, userSessionId)
    : undefined;

  // One surface-bound pointer writer, shared by the resume seam below and the
  // context's `_writeLastSessionPointer`. Both slots want a one-argument
  // function; handing them the SDK's two-argument export directly is what
  // silently stopped the pointer from ever being written (see
  // session-pointer-surface.ts).
  const writeSessionPointer = bindWriteLastSessionPointerToSurface(services.surface);
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
    writeLastSessionPointer: writeSessionPointer,
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
  // Boot resume notice (item 1): after rehydrate() so chain history is ready, before
  // the operator can type anything. Fire-and-forget, same as main.ts's non-blocking
  // `void workspaceCheckpointManager.init().catch(() => {})` — local file I/O only,
  // resolves well before a human can react to the first rendered frame.
  void announceResumeState({
    surface: services.surface,
    sessionManager: services.sessionManager,
    checkpointManager: services.workspaceCheckpointManager,
    chainHistory: wrfcPersistence.knownChains,
    memoryAvailable: Boolean(commandContext.clients?.knowledgeApi?.memory),
    router: systemMessageRouter,
  }).catch(() => {
    // Best-effort — never let the resume notice block or crash boot.
  });
  announceInstallHealth(systemMessageRouter);
  const { gitStatusProvider, inputHistory, lastGitInfoRef } = shell;
  // FIX 2: dispose the header's live-repo-state poll (git-status.ts
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

  // This terminal's floor on the daemon, and the bearer the last attach used —
  // both read by attachAdoptedDaemon below, which is the one place either one
  // is applied.
  const daemonBuildFloor = new DaemonBuildFloor();
  let lastDaemonToken: string | null = null;
  // The daemon's floor on this terminal latches in services.ts, where the
  // continuation runner reads it. This is the surface that tells the owner, and
  // a verdict reached before this line is delivered the moment it attaches.
  services.clientBuildGuard.onRestartRequired((verdict) => {
    systemMessageRouter.high(`[Daemon] ${verdict.message}`);
    requestRender();
  });

  // Adopting a daemon: session identity, the inbound steer path, the
  // cross-surface union read, and the memory spine — see client/spine-adoption.ts.
  const syncSessionSpineToHostStatus = createSpineAdoptionSync({
    sessionSpine,
    memorySpine: services.memorySpine,
    sessionInboundInputs: sessionInboundInputs as unknown as Parameters<typeof createSpineAdoptionSync>[0]['sessionInboundInputs'],
    sessionUnionCache: sessionUnionCache as unknown as Parameters<typeof createSpineAdoptionSync>[0]['sessionUnionCache'],
    legacyStorePath: services.shellPaths.resolveProjectPath('tui', 'control-plane', 'sessions.json'),
    workingDirectory: services.workingDirectory,
    // Both ride adoption. A message submitted into a session this surface hosts
    // must reach the loop here, because the loop is here; and a rewind driven
    // from the web app or another terminal is answerable only by the process
    // holding the messages, which is also here.
    onAdopted: (client) => {
      services.wireSessionDispatch.activate(client as never);
      if (runtime.sessionId) services.conversationRewindHost.start(runtime.sessionId);
    },
    onDetached: (reason) => {
      services.wireSessionDispatch.deactivate(reason);
      void services.conversationRewindHost.stop();
    },
  });

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
      // Honest session-spine posture, independent of daemonRunning — degrades to 'offline'
      // when adopted-but-unreachable even though daemonRunning might still read a stale
      // handle as true; sessionSpine.status() alone is activity-gated, so it's derived
      // together with the union cache's 5s liveness probe (one signal, no new timer).
      sessionSpineActive: sessionSpine.active,
      sessionSpineStatus: deriveSpineFooterStatus(sessionSpine.status(), sessionUnionCache.crossSurfaceView),
    };
  };

  // ADOPT ONLY. This app never constructs a DaemonServer or an HttpListener: the
  // daemon is a separate product with its own binary and its own service unit,
  // and a second copy embedded here is exactly the drift the split removed. The
  // factories carry the shared bearer and the daemon's state directory so an
  // adopted daemon is authenticated the same way it always was — no factory that
  // BUILDS anything is passed, and `adoptOnly` makes the SDK refuse to start one
  // even if a future caller did.
  //
  // `daemonRuntimeDir` names the daemon's own STATE directory
  // (`<home>/.goodvibes/daemon`), which is where operator-tokens.json,
  // auth-users.json and daemon-settings.json live — not the home above it. Every
  // reader in this repository resolves it that way.
  const createExternalServiceFactories = (token: string): ExternalServiceFactories => ({
    sharedDaemonToken: token,
    daemonRuntimeDir: join(services.homeDirectory, '.goodvibes', 'daemon'),
    adoptOnly: true,
  });

  // The one bounded recovery step: a daemon that is INSTALLED on this machine
  // and simply stopped gets started once and waited for, rather than becoming
  // the user's homework. Every boundary is in the SDK's client/daemon-autostart.ts.
  const maybeStartInstalledDaemon = async (): Promise<void> => {
    try {
      const outcome = await autostartInstalledDaemon({
        daemonMode: externalServices.daemonStatus.mode,
        control: createDaemonServiceControl({
          configManager,
          workingDirectory: services.workingDirectory,
          homeDirectory: services.homeDirectory,
        }),
        isReachable: async () => await sessionSpine.probeReachability() === 'online',
      });
      if (outcome.action === 'started' || outcome.action === 'came-online') {
        const companionTokenRecord = resolveDaemonCompanionToken(join(services.homeDirectory, '.goodvibes', 'daemon'));
        externalServicesPromise = startExternalServices(
          configManager, runtimeBus, hookDispatcher, services,
          createExternalServiceFactories(companionTokenRecord.token),
        );
        externalServices = await externalServicesPromise;
        await attachAdoptedDaemon(companionTokenRecord.token);
      }
      const notice = describeDaemonAutostart(
        outcome,
        externalServices.daemonStatus.mode === 'external',
        externalServices.daemonStatus.reason ?? externalServices.daemonStatus.mode,
      );
      if (notice) systemMessageRouter[notice.level](notice.text);
    } catch (error) {
      logger.debug('Boot-time daemon start check failed', { error: summarizeError(error) });
    }
  };

  let externalServices: ExternalServicesHandle = {
    daemonServer: null, httpListener: null,
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
    // The relay is a DAEMON feature and reading an adopted daemon's relay state
    // is a verb this contract does not carry, so these two report 'unavailable'
    // rather than a state this process is in no position to know — see
    // relay-reachability-bridge.ts.
    ...relayReadAccessors,
    inspect: inspectExternalServices,
    restart: async () => {
      if (externalServicesPromise) {
        try {
          externalServices = await externalServicesPromise;
        } catch {
          // A failed previous startup should not prevent a restart attempt.
        }
      }
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
      await attachAdoptedDaemon(companionTokenRecord.token);
      requestRender();
      return inspectExternalServices();
    },
  };
  // Attaching to a daemon is a handshake, not a pointer swap. ONE /status read
  // carries the three things this terminal has to settle before it mirrors
  // anything, and there is no in-process daemon handle to fold any of them from:
  //
  //  - The DAEMON's own build. Every capability here is something the daemon
  //    performs on this terminal's behalf, so a daemon below this build's floor
  //    is refused rather than adopted — otherwise a verb it does not serve
  //    surfaces as one broken feature instead of as an old daemon, and the
  //    terminal keeps running half-working against a peer it has no reason to
  //    suspect. Refused means local-only, which is a state this app already
  //    renders honestly.
  //  - The minimum CLIENT build the daemon accepts. Below it the guard latches
  //    and the continuation runner stops taking shared-session work.
  //  - Its undelivered receipts (update applied, restarted after a crash,
  //    settings migrated), read from /status?receipts=consume where delivery is
  //    destructive — so the read that consumed them is the read that renders
  //    them.
  const attachAdoptedDaemon = async (daemonToken: string): Promise<void> => {
    lastDaemonToken = daemonToken;
    const daemonStatus = externalServices.daemonStatus;
    if (daemonStatus.mode !== 'external' || !daemonStatus.baseUrl) {
      syncSessionSpineToHostStatus(daemonStatus, daemonToken);
      return;
    }
    const read = await readExternalDaemonAttach({
      baseUrl: daemonStatus.baseUrl,
      authToken: daemonToken,
      consumeReceipts: true,
    });
    // Nothing was read, so nothing is known — adopt as before and leave a daemon
    // that is not answering to the spine's own reachability handling. Refusing
    // on a failed read would turn one dropped request into a lost mirror.
    if (!read.answered) {
      syncSessionSpineToHostStatus(daemonStatus, daemonToken);
      return;
    }
    const daemonVerdict = daemonBuildFloor.evaluate(read.statusPayload, daemonStatus.baseUrl);
    const daemonNotice = daemonBuildFloor.noticeFor(daemonVerdict);
    if (daemonNotice) systemMessageRouter.high(`[Daemon] ${daemonNotice}`);
    if (daemonVerdict.status === 'daemon-update-required') {
      // The refusal is recorded on the status every reader already consults, so
      // the footer and /status report "a daemon is there and this build will not
      // adopt it" rather than claiming a working mirror.
      const refused: HostServiceStatus = { ...daemonStatus, mode: 'incompatible', reason: daemonVerdict.message };
      externalServices = { ...externalServices, daemonStatus: refused };
      syncSessionSpineToHostStatus(refused, daemonToken);
      return;
    }
    services.clientBuildGuard.observeFloor(read.clientFloor);
    syncSessionSpineToHostStatus(daemonStatus, daemonToken);
    for (const notice of read.notices) systemMessageRouter.high(`[Daemon] ${notice}`);
  };

  // A liveness flip is only PAINTED once something calls requestRender(); without
  // this, the footer's spine segment sat correct-but-undrawn until incidental activity redrew it (minutes, during an idle stretch).
  // A flip TO online also means the daemon came up, which for an already-adopted
  // one is what its hourly self-update looks like from here — so the handshake
  // runs again on that edge, off a signal that already fires rather than on a
  // second timer. Both floors are re-read against whatever build came back, and
  // any receipt the restart left behind is rendered. The flip an adoption's own
  // first refresh causes runs the handshake once more too; that costs one
  // /status GET and is the price of never having to decide which online flip is
  // "really" a reconnect.
  sessionUnionCache.setOnTransition((online) => {
    requestRender();
    if (online && lastDaemonToken !== null) void attachAdoptedDaemon(lastDaemonToken);
  });
  deferredStartup.schedule({
    label: 'plugins',
    run: async () => {
      // Plugin loading stays here: a plugin's commands, tools, providers, voice
      // and media providers and embedding providers all reach things a turn
      // needs in THIS process. Three of the eleven registries a plugin can
      // reach are the daemon's now — gateway methods, channel plugins and
      // delivery strategies — and a registration into those reaches nothing
      // from here. No plugin is affected today (none is installed, and this
      // package bundles none); the classification and the open question about
      // where a daemon-side plugin is loaded are recorded in
      // docs/decisions/2026-07-30-plugin-registrations-split-verb-side-and-surface-side.md.
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
      // Fix (TUI 0.19.20): remove stale pre-0.21.28 workspace-scoped operator
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
      // Installed-but-stopped recovery, before anything reads the status.
      await maybeStartInstalledDaemon();
      controlPlaneRecentEventsRef.value = (limit) => externalServices.listRecentControlPlaneEvents(limit);
      await attachAdoptedDaemon(companionTokenRecord.token);
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
    permissionPromptRef, trustPromptRef,
    loadLastConversation: () => loadLastConversation({ surface: services.surface }),
    _writeLastSessionPointer: writeSessionPointer,
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
      // Honest close on exit — fire-and-forget (never blocks shutdown);
      // a no-op when the spine was never activated (embedded/local-only topology).
      sessionSpine.close(runtime.sessionId);
      sessionSpine.dispose();
      sessionInboundInputs.dispose(); sessionUnionCache.dispose(); // stop the inbound-steer poll and the wire-refresh interval on exit
      // Quitting has to SAY it is leaving: a hosted session's detach policy applies when the LAST client detaches, so an exit that never detaches leaves a kill-policy session (the shipped default) alive, attached to a process that is gone. Bounded and non-throwing — see client/hosted-exit.ts.
      await Promise.all([leaveHostedSessionOnExit({ configManager, homeDirectory: services.homeDirectory }), deferredStartup.drain(100)]);
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

  // ── Phase 12b: Operator Control Plane wiring (capability-gated); store and
  // task manager exist unconditionally so pre-gate tasks stay visible. ───────
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
