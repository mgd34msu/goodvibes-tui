import { ConversationManager } from '../core/conversation';
import { SelectionManager } from '../input/selection.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { ConfigManager, getConfiguredSystemPrompt } from '../config/index.ts';
import { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import { registerAllTools } from '@pellux/goodvibes-sdk/platform/tools/index';
import { PermissionManager, createPermissionConfigReader } from '@pellux/goodvibes-sdk/platform/permissions/manager';
import { Notifier } from '@pellux/goodvibes-sdk/platform/integrations/notifier';
import { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations/webhooks';
import { Compositor } from '../renderer/compositor.ts';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions/prompt';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { ConversationFollowUpItem } from '@pellux/goodvibes-sdk/platform/core/conversation-follow-ups';
import type { OrchestratorUserInputOptions } from '../core/orchestrator.ts';
import type { ControlPlaneRecentEvent } from '@pellux/goodvibes-sdk/platform/control-plane/gateway';
import type { MutableRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/mutable-runtime-state';
import type { BootstrapOptions } from './context.ts';
import { createFeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { SessionEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { createRuntimeStore, createDomainDispatch, type RuntimeStore } from './store/index.ts';
import { ForensicsCollector, ForensicsRegistry } from '@pellux/goodvibes-sdk/platform/runtime/forensics/index';
import {
  generateUserSessionId,
} from '@pellux/goodvibes-sdk/platform/runtime/session-persistence';
import { loadBootstrapSystemPrompt, syncConfiguredServices } from '@pellux/goodvibes-sdk/platform/runtime/bootstrap-helpers';
import { registerBootstrapHookBridge } from '@pellux/goodvibes-sdk/platform/runtime/bootstrap-hook-bridge';
import { registerBootstrapRuntimeEvents } from '@pellux/goodvibes-sdk/platform/runtime/bootstrap-runtime-events';
import { createRuntimeServices, type RuntimeServices } from './services.ts';
import { createUiRuntimeServices, type UiRuntimeServices } from './ui-services.ts';

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
}

export type CompanionMessagePayload = Extract<SessionEvent, { type: 'COMPANION_MESSAGE_RECEIVED' }>;

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

  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({
    flags: (configManager.getCategory('featureFlags') as Record<string, import('@pellux/goodvibes-sdk/platform/runtime/feature-flags/types').FlagState>) ?? {},
  });

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
    workingDir,
    homeDirectory,
  });
  const providerRegistry = services.providerRegistry;
  providerRegistry.initModelLimits();
  services.benchmarkStore.initBenchmarks();
  providerRegistry.initCatalog();
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
  const { fileCache, projectIndex } = registerAllTools(toolRegistry, {
    surfaceRoot: 'tui',
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
  });
  services.agentOrchestrator.setDependencies({
    surfaceRoot: 'tui',
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
  });

  const bootstrapUnsubs: Array<() => void> = [];
  await memoryStore.init();
  bootstrapUnsubs.push(() => {
    void memoryStore.save();
    memoryStore.close();
  });

  const renderRequestRef = { value: (): void => {} };
  // R1: Coalescing render scheduler — collapses N same-microtask requestRender() calls into 1.
  // Also enforces a 16ms minimum interval to cap at ~60fps during streaming.
  let renderScheduled = false;
  let lastRenderTime = 0;
  const RENDER_INTERVAL_MS = 16;
  const requestRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    setImmediate(() => {
      // Error Handling: the scheduler flag MUST be cleared even if the render
      // callback throws; otherwise a single render exception would wedge the
      // entire TUI (no future requestRender() call would schedule anything).
      renderScheduled = false;
      const now = Date.now();
      const elapsed = now - lastRenderTime;
      try {
        if (elapsed < RENDER_INTERVAL_MS) {
          // Too soon — debounce to the tail of the current 16ms window
          const delay = RENDER_INTERVAL_MS - elapsed;
          setTimeout(() => {
            try {
              lastRenderTime = Date.now();
              renderRequestRef.value();
            } catch (err) {
              // Throttled-render error: swallow but log at error so the next
              // requestRender() call can still schedule. The renderer itself
              // is expected to surface failures via its own error path.
              logger.error('Throttled render threw; next requestRender will reschedule', { error: String(err) });
            }
          }, delay);
        } else {
          lastRenderTime = now;
          renderRequestRef.value();
        }
      } catch (err) {
        logger.error('Immediate render threw; next requestRender will reschedule', { error: String(err) });
      }
    });
  };
  const permissionPromptRef = {
    requestPermission: (async () => ({ approved: false, remember: false })) as PermissionRequestHandler,
  };
  void approvalBroker.start();
  void sharedSessionBroker.start();
  const runtimeSessionIdRef = { value: userSessionId };
  const systemMessageRouterRef: { value: SystemMessageRouter | null } = { value: null };
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

  // ── TUI-specific WRFC constraint-propagation event subscriptions (SDK 0.23.0) ──
  // These supplement the SDK's registerBootstrapRuntimeEvents which handles the
  // core WORKFLOW_REVIEW_COMPLETED / WORKFLOW_CHAIN_CREATED messages.
  // The SDK does not surface constraint-specific system messages; the TUI layer
  // adds them here so operators can observe constraint enumeration and violations
  // in the SystemMessagesPanel and main conversation.
  runtimeUnsubs.push(
    runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/index').WorkflowEvent, { type: 'WORKFLOW_CONSTRAINTS_ENUMERATED' }>>(
      'WORKFLOW_CONSTRAINTS_ENUMERATED',
      ({ payload }) => {
        const router = systemMessageRouterRef.value;
        if (!router) return;
        const count = payload.constraints.length;
        if (count > 0) {
          router.wrfc(
            `[WRFC] Engineer enumerated ${count} constraint${count !== 1 ? 's' : ''} for chain ${payload.chainId.slice(0, 12)}`,
            'low',
          );
        }
        requestRender();
      },
    ),
  );
  runtimeUnsubs.push(
    runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/index').WorkflowEvent, { type: 'WORKFLOW_FIX_ATTEMPTED' }>>(
      'WORKFLOW_FIX_ATTEMPTED',
      ({ payload }) => {
        const router = systemMessageRouterRef.value;
        if (!router) return;
        const targetIds = payload.targetConstraintIds;
        if (targetIds && targetIds.length > 0) {
          router.wrfc(
            `[WRFC] Fix #${payload.attempt} targeting ${targetIds.length} constraint${targetIds.length !== 1 ? 's' : ''} on chain ${payload.chainId.slice(0, 12)}`,
            'low',
          );
          requestRender();
        }
      },
    ),
  );
  runtimeUnsubs.push(
    runtimeBus.on<Extract<import('@pellux/goodvibes-sdk/platform/runtime/events/index').WorkflowEvent, { type: 'WORKFLOW_REVIEW_COMPLETED' }>>(
      'WORKFLOW_REVIEW_COMPLETED',
      ({ payload }) => {
        const router = systemMessageRouterRef.value;
        if (!router) return;
        const unsatisfied = payload.unsatisfiedConstraintIds;
        if (!payload.passed && unsatisfied && unsatisfied.length > 0) {
          router.wrfc(
            `[WRFC] ✗ Chain ${payload.chainId.slice(0, 12)}: ${unsatisfied.length} constraint violation${unsatisfied.length !== 1 ? 's' : ''} forced failure`,
            'high',
          );
          requestRender();
        }
      },
    ),
  );

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

  const notifier = await Notifier.fromConfig(services.serviceRegistry);
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
      sessionId: runtimeSessionIdRef.value,
      localPrompt: permissionPromptRef.requestPermission,
    }),
    createPermissionConfigReader(configManager),
    policyRuntimeState,
    services.hookDispatcher,
    featureFlags,
  );
  await hookWorkbench.loadAndApplyManagedHooks();

  const runtime: MutableRuntimeState = {
    model: configManager.get('provider.model') as string,
    provider: configManager.get('provider.provider') as string,
    debugMode: false,
    systemPrompt: loadBootstrapSystemPrompt(configManager) || getConfiguredSystemPrompt(configManager) || '',
    reasoningEffort: (configManager.get('provider.reasoningEffort') as string | undefined) ?? '',
    sessionId: userSessionId,
  };
  runtimeSessionIdRef.value = runtime.sessionId;
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
    ...registerBootstrapHookBridge({
      runtimeBus,
      hookDispatcher,
      runtime,
    }),
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
    permissionPromptRef,
    systemMessageRouterRef,
    conversationFollowUpRef,
    orchestratorHandleUserInputRef,
    requestRender,
    setRenderRequest: (fn) => {
      renderRequestRef.value = fn;
    },
    runtimeSessionIdRef,
  };
}
