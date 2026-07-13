import { ConversationManager } from '../core/conversation';
import { registerSessionConversation } from './conversation-rewind-port.ts';
import { SelectionManager } from '../input/selection.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { ConfigManager, getConfiguredSystemPrompt } from '../config/index.ts';
import { getProviderIdFromModel } from '../config/provider-model.ts';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import { registerAllTools } from '@pellux/goodvibes-sdk/platform/tools';
import { buildLocalhostFetchApproval } from '@pellux/goodvibes-sdk/platform/runtime/permissions/localhost-fetch-approval';
import { PermissionManager, createPermissionConfigReader } from '@pellux/goodvibes-sdk/platform/permissions';
import { Notifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { Compositor } from '../renderer/compositor.ts';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { ConversationFollowUpItem } from '@pellux/goodvibes-sdk/platform/core';
import type { OrchestratorUserInputOptions } from '../core/orchestrator.ts';
import type { ControlPlaneRecentEvent } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { BootstrapOptions } from './context.ts';
import { createRuntimeStore, createDomainDispatch, type RuntimeStore } from './store/index.ts';
import {
  type MutableRuntimeState, type SessionEvent, bindFeatureSettingsBridge, createFeatureFlagManager, deriveFeatureStates, RuntimeEventBus, ForensicsCollector,
  ForensicsRegistry, generateUserSessionId, loadBootstrapSystemPrompt, syncConfiguredServices,
  registerBootstrapHookBridge, registerBootstrapRuntimeEvents,
} from '@/runtime/index.ts';
import { readExecEnvScrubAllowlist } from '../input/exec-env-scrub-config.ts';
import { createSandboxExecAsk, sandboxExecAskDepsFromRuntime } from '../permissions/sandbox-exec-gate.ts';
import { createRuntimeServices, type RuntimeServices } from './services.ts';
import { runBootMemoryFold } from './memory-fold.ts';
import { wireCostPricing } from '../export/cost-utils.ts';
import { createUiRuntimeServices, type UiRuntimeServices } from './ui-services.ts';
import { join } from 'node:path';
import { installWrfcAgentToolGuard } from '../tools/wrfc-agent-guard.ts';
import { createWrfcPersistence, type WrfcPersistence } from './wrfc-persistence.ts';
import type { SystemMessagePriority } from '../core/system-message-router.ts';
import { SessionSpineClient, SessionUnionCache, TUI_SPINE_PARTICIPANT } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import { SessionInboundInputPoller, createBootstrapInboundInputPoller } from './session-inbound-inputs.ts';
import { trustGatedAsk, type WorkspaceTrustLevel } from './trust/workspace-trust.ts';
import { syncNotifierQueueIntegrations } from './bootstrap-notifier-sync.ts';

// ---------------------------------------------------------------------------
// Pre-router buffer
// ---------------------------------------------------------------------------

const PRE_ROUTER_BUFFER_MAX = 100;

type BufferedWrfcMessage = {
  readonly message: string;
  readonly priority: SystemMessagePriority;
};

/**
 * Small bounded queue that accumulates WRFC system messages emitted before
 * the SystemMessageRouter is attached. On attach the queue flushes in order.
 * If the queue overflows (> PRE_ROUTER_BUFFER_MAX), the oldest entries are
 * dropped and a summary message is prepended to the first flushed message.
 */
export class WrfcPreRouterBuffer {
  private readonly queue: BufferedWrfcMessage[] = [];
  private overflowCount = 0;

  push(message: string, priority: SystemMessagePriority): void {
    if (this.queue.length >= PRE_ROUTER_BUFFER_MAX) {
      this.queue.shift();
      this.overflowCount++;
    }
    this.queue.push({ message, priority });
  }

  flush(router: import('../core/system-message-router.ts').SystemMessageRouter): void {
    const dropped = this.overflowCount;
    const pending = this.queue.splice(0);
    this.overflowCount = 0;
    if (dropped > 0) {
      router.wrfc(
        `[WRFC] Pre-router buffer overflowed: ${dropped} earliest message${dropped !== 1 ? 's' : ''} were dropped`,
        'low',
      );
    }
    for (const item of pending) {
      router.wrfc(item.message, item.priority);
    }
  }

  get size(): number {
    return this.queue.length;
  }
}

export interface BootstrapCoreState {
  readonly userSessionId: string;
  readonly runtimeBus: RuntimeEventBus;
  readonly store: RuntimeStore;
  readonly services: RuntimeServices;
  readonly uiServices: UiRuntimeServices;
  readonly conversation: ConversationManager;
  readonly compositor: Compositor;
  readonly selection: SelectionManager;
  readonly toolRegistry: ToolRegistry;
  readonly fileCache: ReturnType<typeof registerAllTools>['fileCache'];
  readonly projectIndex: ReturnType<typeof registerAllTools>['projectIndex'];
  readonly permissionManager: PermissionManager;
  readonly forensicsCollector: ForensicsCollector;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly runtime: MutableRuntimeState;
  readonly bootstrapUnsubs: Array<() => void>;
  readonly runtimeUnsubs: Array<() => void>;
  readonly agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null };
  readonly permissionPromptRef: { requestPermission: PermissionRequestHandler };
  readonly trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel> }; // trust-at-consequence-time bridge, patched with the real modal-driving impl once the UI layer exists
  readonly systemMessageRouterRef: { value: SystemMessageRouter | null };
  readonly conversationFollowUpRef: { value: ((item: ConversationFollowUpItem) => void) | null };
  /**
   * Mutable ref patched by bootstrap.ts after the Orchestrator is constructed.
   * When non-null, COMPANION_MESSAGE_RECEIVED fires a real LLM turn via
   * orchestrator.handleUserInput() instead of only appending the user message.
   */
  readonly orchestratorHandleUserInputRef: { value: ((text: string, options?: OrchestratorUserInputOptions) => void) | null };
  readonly requestRender: () => void;
  readonly setRenderRequest: (fn: () => void) => void;
  readonly runtimeSessionIdRef: { value: string };
  /** Cross-surface identity mirror; permanently dormant for embedded/local-only (docs/decisions/2026-07-06-session-spine-mode-branch-is-permanent.md), activated by bootstrap.ts only for an adopted 'external' daemon. */
  readonly sessionSpine: SessionSpineClient;
  /** Inbound steer/follow-up delivery; dormant until bootstrap.ts activates it. */
  readonly sessionInboundInputs: SessionInboundInputPoller;
  /** Cache-backed read facade; bootstrap.ts drives its mode (embedded/external/local-only) from the same HostServiceMode as the spine above. */
  readonly sessionUnionCache: SessionUnionCache;
  /**
   * WRFC chain persistence — call `rehydrate()` once after the SystemMessageRouter
   * is wired so interrupted chains from a previous process are surfaced to the operator.
   */
  readonly wrfcPersistence: WrfcPersistence;
}

export type CompanionMessagePayload = Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>;

// ---------------------------------------------------------------------------
// Operator narration of inbound channel events
// ---------------------------------------------------------------------------

/** Narrate an inbound channel event (GitHub, Slack, ntfy, etc.) that triggered an
 * agent turn, via the SystemMessageRouter — null for internal/companion sources. */
export function narrateInboundEvent(event: {
  source: string;
  metadata: Readonly<Record<string, unknown>> | undefined;
}): string | null {
  const { source, metadata } = event;
  if (!source) return null;

  // Derive the effective surface — prefer metadata.surface, fall back to source.
  const surface = typeof metadata?.surface === 'string' ? metadata.surface : source;

  // Internal / companion sources do not need operator narration.
  if (surface === 'companion' || source === 'companion') return null;
  if (surface === 'internal' || source === 'internal') return null;

  // Build a surface label for the log prefix.
  const label = ((): string => {
    switch (surface) {
      case 'github':        return '[GitHub]';
      case 'slack':         return '[Slack]';
      case 'discord':       return '[Discord]';
      case 'ntfy':          return '[ntfy]';
      case 'homeassistant': return '[HomeAssistant]';
      case 'telegram':      return '[Telegram]';
      case 'google-chat':   return '[Google Chat]';
      case 'signal':        return '[Signal]';
      case 'whatsapp':      return '[WhatsApp]';
      case 'msteams':       return '[Teams]';
      case 'imessage':      return '[iMessage]';
      case 'bluebubbles':   return '[BlueBubbles]';
      case 'mattermost':    return '[Mattermost]';
      case 'matrix':        return '[Matrix]';
      case 'webhook':       return '[Webhook]';
      default:              return `[${surface[0]!.toUpperCase()}${surface.slice(1)}]`;
    }
  })();

  const eventType   = typeof metadata?.eventType   === 'string' ? metadata.eventType   : null;
  const eventAction = typeof metadata?.eventAction  === 'string' ? metadata.eventAction : null;
  const topic       = typeof metadata?.topic        === 'string' ? metadata.topic       : null;
  const prNumber    = typeof metadata?.prNumber     === 'number' ? metadata.prNumber    : null;
  const issueNumber = typeof metadata?.issueNumber  === 'number' ? metadata.issueNumber : null;
  const repo        = typeof metadata?.repo         === 'string' ? metadata.repo        : null;

  // Build event-specific detail for GitHub events.
  if (surface === 'github' && eventType) {
    const actionPart = eventAction ? ` ${eventAction}` : '';
    let detail = `${eventType}${actionPart} → agent triggered`;
    if (prNumber !== null) {
      detail = `PR #${prNumber}${repo ? ` (${repo})` : ''} ${eventAction ?? eventType} → agent triggered`;
    } else if (issueNumber !== null) {
      detail = `Issue #${issueNumber}${repo ? ` (${repo})` : ''} ${eventAction ?? eventType} → agent triggered`;
    } else if (repo) {
      detail = `${eventType}${actionPart} in ${repo} → agent triggered`;
    }
    return `${label} ${detail}`;
  }

  // ntfy: include topic when available.
  if (surface === 'ntfy' && topic) {
    return `${label} inbound message on topic '${topic}' → agent triggered`;
  }

  // Generic narration for all other surfaces.
  const eventDetail = eventType ? ` ${eventType}${eventAction ? ` ${eventAction}` : ''}` : '';
  return `${label}${eventDetail} inbound event → agent triggered`;
}

export function companionMessageToOrchestratorInputOptions(
  payload: CompanionMessagePayload,
): OrchestratorUserInputOptions {
  const metadata = payload.metadata;
  const surface = typeof metadata?.surface === 'string' ? metadata.surface : undefined;
  const topic = typeof metadata?.topic === 'string' ? metadata.topic : undefined;

  return {
    origin: {
      source: payload.source,
      messageId: payload.messageId,
      ...(surface ? { surface } : {}),
      ...(topic ? { topic } : {}),
      ...(metadata ? { metadata } : {}),
    },
  };
}

export async function initializeBootstrapCore(
  stdout: NodeJS.WriteStream,
  options: BootstrapOptions,
  getControlPlaneRecentEvents: (limit: number) => readonly ControlPlaneRecentEvent[],
): Promise<BootstrapCoreState> {
  const workingDir = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const configManager = options.configManager;

  // Gate states derive from the domain settings keys; the bridge keeps live
  // config writes flowing (honest pending-restart markers for startup-gated
  // features). Mirrors the SDK composition root's owned-manager wiring.
  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
  bindFeatureSettingsBridge(configManager, featureFlags);

  const userSessionId = `user-${generateUserSessionId()}`;
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
    workingDir, homeDirectory,
  });
  await services.workspaceTrustManager.load(); // settle any already-persisted trust decision before any tool runs
  const providerRegistry = services.providerRegistry;
  providerRegistry.initModelLimits();
  services.benchmarkStore.initBenchmarks();
  providerRegistry.initCatalog();
  // Wire cost-utils to the live catalog AND the ONE pricing resolver so every
  // cost surface distinguishes real pricing from unpriced and names its
  // source ("your price" vs "catalog price, as of <date>") — see cost-utils.
  wireCostPricing(providerRegistry);
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
    memoryStore,
    panelManager,
    routeBindings,
    sessionBroker: sharedSessionBroker,
    surfaceRegistry,
    watcherRegistry,
  } = services;
  // Permanently dormant for embedded/local-only (nothing to mirror to); bootstrap.ts activates it only for an adopted 'external' daemon.
  const sessionSpine = new SessionSpineClient({ participant: TUI_SPINE_PARTICIPANT, recordKind: 'tui' });
  // Cache-backed read facade over the local broker (passthrough until bootstrap.ts marks it
  // embedded, or activates the adopted-daemon wire union for 'external').
  // selfSessionIds keeps local authoritative for our own wire-mirrored session even when local/wire ids diverge (D-TUI-1).
  const sessionUnionCache = new SessionUnionCache({ local: sharedSessionBroker, selfSessionIds: () => sessionSpine.mirroredSessionIds });

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
  const uiServices = createUiRuntimeServices(services, {
    forensicsRegistry,
    getControlPlaneRecentEvents,
    sessionUnionCache,
  });

  const conversation = new ConversationManager(() => {
    const width = stdout.columns || 80;
    if (panelManager.isVisible() && panelManager.getAllOpen().length > 0) {
      return Math.max(1, panelManager.getLeftWidth(width) - 1);
    }
    return width;
  });
  conversation.setConfigManager(configManager);
  getConversationTitle = () => conversation.title;

  const compositor = new Compositor(stdout);
  const selection = new SelectionManager();

  const toolRegistry = new ToolRegistry();
  // A loopback fetch that isn't already allow-listed asks once through the
  // approval card; "allow for this project" persists via configManager and the
  // fetch proceeds without another prompt. Shared by the interactive tool
  // registry and the subagent orchestrator below so both ask the same way.
  const localhostFetchApproval = buildLocalhostFetchApproval({
    requestApproval: (input) => approvalBroker.requestApproval(input),
    configManager,
  });
  const { fileCache, projectIndex } = registerAllTools(toolRegistry, {
    surfaceRoot: 'tui',
    localhostFetchApproval,
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus,
    archetypeLoader: services.archetypeLoader,
    wrfcController: services.wrfcController,
    webSearchService: services.webSearchService,
    channelRegistry: services.channelPlugins,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    workflowServices: services.workflow,
    mcpRegistry: services.mcpRegistry,
    sessionOrchestration: services.sessionOrchestration,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    workingDirectory: services.workingDirectory,
    configManager,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry,
    overflowHandler: services.overflowHandler,
    changeTracker: services.sessionChangeTracker,
    // Master switch stays on (SDK default); this only widens the allowlist of
    // variable NAMES kept even though they look credential-bearing. See
    // exec-env-scrub-config.ts (permissions.execEnvScrubAllowlist).
    credentialEnvScrub: { allowlist: readExecEnvScrubAllowlist(configManager) },
    // Registers the context_accounting tool on this (the real, interactive)
    // registry against OUR holder rather than a fresh internal one, so the
    // Orchestrator-backed source bound at bootstrap.ts is what the tool
    // actually reads from. See runtime/context-accounting-source.ts.
    contextAccountingHolder: services.contextAccountingHolder,
  });
  // Note: installWrfcAgentToolGuard is called after routeOrBuffer is defined
  // (further below) so the onTrace callback can route guard decisions through
  // the pre-router buffer.
  services.agentOrchestrator.setDependencies({
    surfaceRoot: 'tui',
    localhostFetchApproval,
    fileCache,
    projectIndex,
    workingDirectory: services.workingDirectory,
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    agentMessageBus: services.agentMessageBus,
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
    sessionOrchestration: services.sessionOrchestration,
    featureFlags: services.featureFlags,
    overflowHandler: services.overflowHandler,
    memoryRegistry: services.memoryRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    workflowServices: services.workflow,
    contextAccountingHolder: services.contextAccountingHolder,
  });

  const bootstrapUnsubs: Array<() => void> = [];
  await memoryStore.init();
  bootstrapUnsubs.push(() => {
    void memoryStore.save();
    memoryStore.close();
  });
  // Fold this project's legacy per-project TUI memory into the home-scoped canonical store, ONCE, AFTER init(). Idempotent and non-fatal.
  await runBootMemoryFold(memoryStore, services.memoryEmbeddingRegistry, workingDir, logger);

  const renderRequestRef = { value: (): void => {} };
  // Coalescing render scheduler — collapses N requestRender() calls into 1 and
  // enforces a 16ms minimum interval to cap repaints at ~60fps. renderScheduled stays
  // set for the ENTIRE window (until run() executes), so requestRender() calls arriving
  // on later event-loop ticks within the same 16ms window coalesce into the one
  // already-pending tail render instead of each queuing their own setTimeout. (The
  // streaming hot path drives its own direct repaints and skips this scheduler.)
  let renderScheduled = false;
  let lastRenderTime = 0;
  const RENDER_INTERVAL_MS = 16;
  // run() performs the actual render. It clears renderScheduled FIRST — even if the
  // render callback throws — otherwise a single render exception would wedge the entire
  // TUI (no future requestRender() would schedule anything); we log at error so the
  // next requestRender() can still reschedule.
  const run = (): void => {
    renderScheduled = false;
    lastRenderTime = Date.now();
    try {
      renderRequestRef.value();
    } catch (err) {
      logger.error('Render threw; next requestRender will reschedule', { error: String(err) });
    }
    // Debounced spine heartbeat on turn/render activity (no-op while dormant, i.e.
    // embedded/local-only): a cheap synchronous no-op unless its own internal window has
    // elapsed (at most one wire call per heartbeatMinIntervalMs) — safe on the hot path.
    sessionSpine.heartbeat(runtimeSessionIdRef.value);
  };
  const requestRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    setImmediate(() => {
      const elapsed = Date.now() - lastRenderTime;
      if (elapsed < RENDER_INTERVAL_MS) {
        // Too soon — debounce to the tail of the current 16ms window. The flag
        // stays set until run() fires, so window-local requests coalesce here.
        setTimeout(run, RENDER_INTERVAL_MS - elapsed);
      } else {
        run();
      }
    });
  };
  const permissionPromptRef = {
    requestPermission: (async () => ({ approved: false, remember: false })) as PermissionRequestHandler,
  };
  // Trust-at-consequence-time: raised by trustGatedAsk on the first non-read
  // request in an undecided workspace; overridden once the UI layer exists — same ref-patching pattern as permissionPromptRef above.
  const trustPromptRef = { requestTrustDecision: (async () => 'restricted') as () => Promise<WorkspaceTrustLevel> };
  approvalBroker.start().catch((err) => logger.warn('approval broker start failed at bootstrap', { err }));
  sharedSessionBroker.start().catch((err) => logger.warn('shared session broker start failed at bootstrap', { err }));
  const runtimeSessionIdRef = { value: userSessionId };
  const wrfcBuffer = new WrfcPreRouterBuffer();
  // Smart ref: setting .value auto-flushes the pre-router buffer so events
  // buffered before the SystemMessageRouter attaches are not permanently lost.
  const systemMessageRouterRef = ((): { value: SystemMessageRouter | null } => {
    let _value: SystemMessageRouter | null = null;
    const ref = {} as { value: SystemMessageRouter | null };
    Object.defineProperty(ref, 'value', {
      get(): SystemMessageRouter | null { return _value; },
      set(router: SystemMessageRouter | null): void {
        _value = router;
        if (router && wrfcBuffer.size > 0) {
          wrfcBuffer.flush(router);
          requestRender();
        }
      },
      enumerable: true,
      configurable: true,
    });
    return ref;
  })();
  const conversationFollowUpRef: { value: ((item: ConversationFollowUpItem) => void) | null } = { value: null };
  const { unsubs: runtimeUnsubs, agentStatusIntervalRef } = registerBootstrapRuntimeEvents({
    runtimeBus,
    domainDispatch,
    getSystemMessageRouter: () => systemMessageRouterRef.value,
    queueConversationFollowUp: (item) => conversationFollowUpRef.value?.(item),
    requestRender,
    configManager,
    agentManager: services.agentManager,
    wrfcController: services.wrfcController,
  });

  // ── WRFC chain persistence ──────────────────────────────────────────────────────────
  const wrfcPersistence = createWrfcPersistence({
    snapshotPath: join(workingDir, '.goodvibes', 'tui', 'wrfc-chains.json'),
    getSystemMessageRouter: () => systemMessageRouterRef.value,
    controller: services.wrfcController,
  });
  runtimeUnsubs.push(...wrfcPersistence.attach(runtimeBus));
  // Flush any debounced snapshot on clean shutdown so final chain state is
  // never silently dropped during a SIGINT/teardown (250ms debounce window).
  bootstrapUnsubs.push(() => wrfcPersistence.flush());

  // ── TUI-specific WRFC constraint-propagation event subscriptions (SDK 0.23.0) ──
  // These supplement the SDK's registerBootstrapRuntimeEvents which handles the
  // core WORKFLOW_REVIEW_COMPLETED / WORKFLOW_CHAIN_CREATED messages.
  // The SDK does not surface constraint-specific system messages; the TUI layer
  // adds them here so operators can observe constraint enumeration and violations
  // in the SystemMessagesPanel and main conversation.
  //
  // Pre-router buffering: events that arrive before the SystemMessageRouter is
  // attached are held in wrfcBuffer (bounded, 100 entries). When the router is
  // set on systemMessageRouterRef, the smart setter flushes the buffer in order.
  // If the buffer overflows, the oldest entries are dropped and a summary message
  // is prepended to the first flushed batch.
  const routeOrBuffer = (message: string, priority: SystemMessagePriority): void => {
    const router = systemMessageRouterRef.value;
    if (router) {
      router.wrfc(message, priority);
    } else {
      wrfcBuffer.push(message, priority);
    }
  };

  // Startup TLS banner — emitted via wrfcBuffer.push() because the
  // SystemMessageRouter is not attached yet at this point in bootstrap. The
  // smart-ref setter on systemMessageRouterRef auto-flushes the buffer when
  // the router attaches, so the message will appear in the WRFC panel on startup.
  {
    const cpEnabled = Boolean(configManager.get('controlPlane.enabled'));
    const cpHostMode = String(configManager.get('controlPlane.hostMode') ?? 'local');
    const cpTlsMode = String(configManager.get('controlPlane.tls.mode') ?? 'off');
    const hlEnabled = Boolean(configManager.get('danger.httpListener'));
    const hlHostMode = String(configManager.get('httpListener.hostMode') ?? 'local');
    const hlTlsMode = String(configManager.get('httpListener.tls.mode') ?? 'off');
    const cpNetworkPlaintext = cpEnabled && cpHostMode !== 'local' && cpTlsMode === 'off';
    const hlNetworkPlaintext = hlEnabled && hlHostMode !== 'local' && hlTlsMode === 'off';
    if (cpNetworkPlaintext || hlNetworkPlaintext) {
      const affected: string[] = [];
      if (cpNetworkPlaintext) affected.push('control plane');
      if (hlNetworkPlaintext) affected.push('HTTP listener');
      wrfcBuffer.push(
        `[SECURITY] TLS is off for the ${affected.join(' and ')} but it is network-reachable. All traffic (credentials, tokens, conversation content) travels in plaintext. Enable TLS (controlPlane.tls.mode / httpListener.tls.mode) or restrict to loopback before exposing to untrusted networks.`,
        'high',
      );
    }
  }

  runtimeUnsubs.push(
    runtimeBus.on<Extract<import('@/runtime/index.ts').WorkflowEvent, { type: 'WORKFLOW_CONSTRAINTS_ENUMERATED' }>>(
      'WORKFLOW_CONSTRAINTS_ENUMERATED',
      ({ payload }) => {
        const count = payload.constraints.length;
        if (count > 0) {
          routeOrBuffer(
            `[WRFC] Engineer enumerated ${count} constraint${count !== 1 ? 's' : ''} for chain ${payload.chainId.slice(0, 12)}`,
            'low',
          );
        }
        requestRender();
      },
    ),
  );
  runtimeUnsubs.push(
    runtimeBus.on<Extract<import('@/runtime/index.ts').WorkflowEvent, { type: 'WORKFLOW_FIX_ATTEMPTED' }>>(
      'WORKFLOW_FIX_ATTEMPTED',
      ({ payload }) => {
        const targetIds = payload.targetConstraintIds;
        if (targetIds && targetIds.length > 0) {
          routeOrBuffer(
            `[WRFC] Fix #${payload.attempt} targeting ${targetIds.length} constraint${targetIds.length !== 1 ? 's' : ''} on chain ${payload.chainId.slice(0, 12)}`,
            'low',
          );
          requestRender();
        }
      },
    ),
  );
  runtimeUnsubs.push(
    runtimeBus.on<Extract<import('@/runtime/index.ts').WorkflowEvent, { type: 'WORKFLOW_REVIEW_COMPLETED' }>>(
      'WORKFLOW_REVIEW_COMPLETED',
      ({ payload }) => {
        const unsatisfied = payload.unsatisfiedConstraintIds;
        if (!payload.passed && unsatisfied && unsatisfied.length > 0) {
          routeOrBuffer(
            `[WRFC] ✗ Chain ${payload.chainId.slice(0, 12)}: ${unsatisfied.length} constraint violation${unsatisfied.length !== 1 ? 's' : ''} forced failure`,
            'high',
          );
          requestRender();
        }
      },
    ),
  );

  // Wire the WRFC agent-guard with the onTrace callback so routing decisions are
  // observable via the same routeOrBuffer path as WORKFLOW_* events.
  // Placed here (after routeOrBuffer is defined) so the closure is fully wired.
  installWrfcAgentToolGuard(toolRegistry, {
    getLastUserMessage: () => conversation.getLastUserMessage(),
    onTrace: ({ kind, reason, task }) => {
      const shortTask = task.length > 80 ? `${task.slice(0, 77)}...` : task;
      routeOrBuffer(`[WRFC] Guard: ${reason} — task: "${shortTask}" (${kind})`, 'low');
    },
  });

  // Subscribe to companion main-chat messages received from the daemon's HTTP layer.
  // The daemon emits COMPANION_MESSAGE_RECEIVED on the runtime bus when a companion
  // POST /api/sessions/:id/messages with kind='message' arrives.
  //
  // bootstrap.ts patches orchestratorHandleUserInputRef.value after the Orchestrator
  // is constructed. When that ref is set, we delegate to orchestrator.handleUserInput()
  // which (a) adds the user message to the conversation view and (b) fires a real LLM
  // turn whose STREAM_DELTA / TURN_COMPLETED events flow to both TUI and companion SSE.
  //
  // The fallback (ref not yet set) adds the message to the conversation view only —
  // this path is unreachable in practice because the event bus is not connected to
  // any live HTTP traffic until after the orchestrator is wired in bootstrap.ts.
  const orchestratorHandleUserInputRef: {
    value: ((text: string, options?: OrchestratorUserInputOptions) => void) | null;
  } = { value: null };
  runtimeUnsubs.push(runtimeBus.on<Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>>(
    'COMPANION_MESSAGE_RECEIVED',
    ({ payload }) => {
      // Narrate inbound external events to the operator so they can observe
      // which channel event triggered the agent turn.
      const narration = narrateInboundEvent({
        source: payload.source,
        metadata: payload.metadata,
      });
      if (narration) {
        routeOrBuffer(narration, 'low');
      }

      if (orchestratorHandleUserInputRef.value) {
        // Delegate to the orchestrator: adds user message + fires a real LLM turn.
        // Preserve surface origin metadata so the SDK can correlate replies back
        // to the originating external channel, including ntfy chat topics.
        orchestratorHandleUserInputRef.value(payload.body, companionMessageToOrchestratorInputOptions(payload));
      } else {
        // Fallback: render the user message immediately (orchestrator not yet ready).
        conversation.addUserMessage(payload.body);
        requestRender();
      }
    },
  ));

  // Inbound steer delivery — see createBootstrapInboundInputPoller's doc comment.
  const sessionInboundInputs = createBootstrapInboundInputPoller({
    runtimeSessionIdRef, routeOrBuffer, orchestratorHandleUserInputRef, conversation, requestRender,
  });

  providerRegistry.startWatching(runtimeBus);

  // attach the SAME WebhookNotifier instance that `/notify add|remove|clear`
  // (notify-runtime.ts) keeps live via ctx.services.webhookNotifier, rather than
  // constructing a second, boot-time-only instance here. Before this fix, a
  // webhook URL added mid-session reached long-task notifications (which read
  // ctx.services.webhookNotifier directly) but never reached this instance's
  // AGENT_FAILED/WORKFLOW_CHAIN_FAILED/WORKFLOW_CHAIN_PASSED runtime-bus
  // listeners until restart — and if the session started with zero URLs
  // configured, attachToRuntimeBus was never even called, so those listeners
  // never existed at all for the rest of the session. Always attaching
  // (regardless of initial URL count) and seeding the shared instance fixes
  // both: `send()` is already a safe no-op with zero URLs configured.
  const webhookUrls = (configManager.getCategory('notifications') as { webhookUrls?: string[] }).webhookUrls ?? [];
  if (webhookUrls.length > 0) {
    services.webhookNotifier.setUrls(webhookUrls);
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
  services.webhookNotifier.attachToRuntimeBus(runtimeBus);

  const notifier = await Notifier.fromConfig(services.serviceRegistry);
  syncNotifierQueueIntegrations(notifier, runtimeBus, domainDispatch);

  await syncConfiguredServices(domainDispatch.syncIntegration, services.serviceRegistry);

  const permissionManager = new PermissionManager(
    // Composed ask layer: the workspace trust gate (outer) wraps the sandbox-aware exec gate (inner); see sandbox-exec-gate.ts. The catastrophic block is untouched.
    trustGatedAsk(
      services.workspaceTrustManager,
      createSandboxExecAsk(
        sandboxExecAskDepsFromRuntime(configManager, featureFlags),
        (request) => approvalBroker.requestApproval({
          request,
          sessionId: runtimeSessionIdRef.value,
          localPrompt: permissionPromptRef.requestPermission,
        }),
      ),
      () => trustPromptRef.requestTrustDecision(), // indirection through the ref, not bound early — main.ts patches the real impl in later
    ),
    createPermissionConfigReader(configManager),
    policyRuntimeState,
    services.hookDispatcher,
    featureFlags,
    services.userPermissionRuleStore, // durable remembered approvals (mirrors the SDK composition); permissions.rules.* lists/deletes them
  );
  await hookWorkbench.loadAndApplyManagedHooks();

  const runtime: MutableRuntimeState = {
    model: configManager.get('provider.model') as string,
    provider: getProviderIdFromModel(configManager.get('provider.model')),
    debugMode: false,
    systemPrompt: loadBootstrapSystemPrompt(configManager) || getConfiguredSystemPrompt(configManager) || '',
    reasoningEffort: (configManager.get('provider.reasoningEffort') as string | undefined) ?? '',
    sessionId: userSessionId,
  };
  runtimeSessionIdRef.value = runtime.sessionId;
  // Register the live conversation so the composed daemon's rewind.plan/apply verbs
  // can serve conversation scope for this session (see conversation-rewind-port.ts).
  registerSessionConversation(runtime.sessionId, conversation);
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
  }).catch((err) => { logger.debug('session broker create session failed at bootstrap', { err }); });
  // Fire-and-forget spine mirror — a permanent parallel-write posture alongside (never
  // instead of) the still-authoritative local SharedSessionBroker above. Dormant/queued
  // until bootstrap.ts's deferred task activates it for an adopted 'external' daemon.
  sessionSpine.register({ sessionId: runtime.sessionId, project: services.workingDirectory, title: 'Terminal UI session' });

  domainDispatch.syncSessionState({
    id: userSessionId,
    projectRoot: workingDir,
    status: 'active',
    startedAt: Date.now(),
    recoveryState: 'ready',
    isResumed: false,
    wasRepaired: false,
    lineageId: userSessionId,
    lineage: [{ sessionId: userSessionId, createdAt: Date.now() }],
  }, 'bootstrap.session');

  runtimeUnsubs.push(
    ...registerBootstrapHookBridge({ runtimeBus, hookDispatcher, runtime }),
  );

  return {
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
    setRenderRequest: (fn) => {
      renderRequestRef.value = fn;
    },
    runtimeSessionIdRef,
    wrfcPersistence,
    sessionSpine,
    sessionInboundInputs,
    sessionUnionCache,
  };
}
