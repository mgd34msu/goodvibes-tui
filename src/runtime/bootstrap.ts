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
import { configManager, getConfiguredSystemPrompt, getWorkingDirectory } from '../config/index.ts';
import { providerRegistry } from '../providers/registry.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { registerAllTools } from '../tools/index.ts';
import { agentOrchestrator } from '../agents/orchestrator.ts';
import { PermissionManager } from '../permissions/manager.ts';
import { AcpManager } from '../acp/manager.ts';
import { getHookDispatcher } from '../hooks/index.ts';
import { CommandRegistry } from '../input/command-registry.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { WrfcController } from '../agents/wrfc-controller.ts';
import { registerBuiltinCommands } from '../input/commands.ts';
import { WebhookNotifier, setWebhookNotifier } from '../integrations/webhooks.ts';
import { InputHistory } from '../input/input-history.ts';
import { loadSystemPrompt as _loadSystemPrompt } from '../utils/prompt-loader.ts';
import { getTierPromptSupplement, getTierForContextWindow } from '../providers/tier-prompts.ts';
import { GitStatusProvider } from '../renderer/git-status.ts';
import type { GitHeaderInfo } from '../renderer/git-status.ts';
import { getSessionManager } from '../sessions/manager.ts';
import { logger } from '../utils/logger.ts';
import { getPinned } from '../providers/favorites.ts';
import { initModelLimits, getContextWindowForModel } from '../providers/model-limits.ts';
import { initBenchmarks } from '../providers/model-benchmarks.ts';
import { setSyntheticRuntimeBus } from '../providers/synthetic.ts';
import { initCatalog, getConfiguredProviderIds } from '../providers/model-catalog.ts';
import { getPanelManager } from '../panels/panel-manager.ts';
import { registerBuiltinPanels } from '../panels/builtin-panels.ts';
import { mcpRegistry } from '../mcp/registry.ts';
import { getKeybindingsManager } from '../input/keybindings.ts';
import { sessionMemoryStore } from '../core/session-memory.ts';
import { Compositor } from '../renderer/compositor.ts';
import type { PermissionRequestHandler } from '../permissions/prompt.ts';

import type { HookPhase, HookCategory, HookEventPath } from '../hooks/types.ts';
import type { RuntimeContext, BootstrapOptions, MutableRuntimeState } from './context.ts';
import { shutdownRuntime, fireSessionStart, saveSession } from './lifecycle.ts';
import { createFeatureFlagManager, FeatureFlagManager } from './feature-flags/index.ts';
import type { AgentEvent, OpsEvent, ProviderEvent, WorkflowEvent } from './events/index.ts';
import { RuntimeEventBus } from './events/index.ts';
import { createRuntimeStore, createDomainDispatch } from './store/index.ts';
import { createTaskManager } from './tasks/index.ts';
import { OpsControlPlane } from './ops/control-plane.ts';
import { ForensicsCollector, ForensicsRegistry } from './forensics/index.ts';
import { setOpsRuntimeContext } from './ops/runtime-context.ts';
import { getPolicyRuntimeState } from './permissions/policy-runtime.ts';
import { createSystemMessageRouter, SystemMessageRouter } from '../core/system-message-router.ts';
import { emitSessionReady, emitSessionResumed, emitSessionStarted } from './emitters/index.ts';
import { setPlanRuntimeBus } from '../core/plan-command-handler.ts';
import {
  generateUserSessionId,
  getLastSessionPointerPath,
  getRecoveryFilePath,
  loadLastConversation,
  writeLastSessionPointer,
} from './session-persistence.ts';
import { createBootstrapCommandContext } from './bootstrap-command-context.ts';
import { scheduleMcpAutodiscovery, startBackgroundProviderRegistration } from './bootstrap-background.ts';

// ── Internal helpers ──────────────────────────────────────────────────────

/** Load and resolve the current system prompt. */
function loadSystemPrompt(): string {
  return _loadSystemPrompt(
    () => configManager.get('provider.systemPromptFile') as string | undefined,
  );
}

/**
 * Attempt to restore a previously saved model selection after providers are registered.
 * Non-fatal: logs on failure but does not throw.
 */
function restoreSavedModel(
  savedModel: string,
  savedProvider: string,
  runtime: MutableRuntimeState,
): void {
  const registry = providerRegistry.listModels();
  const modelDef = savedModel.includes(':')
    ? (registry.find((m) => m.registryKey === savedModel) ?? registry.find((m) => m.id === savedModel))
    : registry.find((m) => m.id === savedModel && (!savedProvider || m.provider === savedProvider))
      ?? registry.find((m) => m.id === savedModel);
  if (modelDef) {
    try {
      const key = modelDef.registryKey ?? `${modelDef.provider}:${modelDef.id}`;
      providerRegistry.setCurrentModel(key);
      runtime.model = key;
      runtime.provider = modelDef.provider;
    } catch (err) {
      logger.debug('Model restore failed (non-fatal)', { error: String(err) });
    }
  }
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
  /** Shell-owned permission prompt bridge that main.ts patches after UI setup. */
  permissionPromptRef: { requestPermission: PermissionRequestHandler };
  /** Load the most recently saved conversation from disk. */
  loadLastConversation: () => { messages: Array<Record<string, unknown>> } | null;
  /** Write the last-session pointer file (used after session resume). */
  _writeLastSessionPointer: (sessionId: string) => void;
  /** Save a conversation snapshot to disk. */
  _saveSession: typeof saveSession;
  /** Retrieve pinned model IDs for the model picker. */
  _getPinned: typeof getPinned;
  /** Retrieve configured provider IDs for the model picker. */
  _getConfiguredProviderIds: typeof getConfiguredProviderIds;
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

  // ── Phase 0: Feature flags ──────────────────────────────────────────────

  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({ flags: (configManager.getCategory('featureFlags') as Record<string, import('./feature-flags/types.ts').FlagState>) ?? {} });
  FeatureFlagManager.setInstance(featureFlags);

  // ── Phase 1: Config, caches, keybindings ────────────────────────────────

  const userSessionId = `user-${generateUserSessionId()}`;

  // Sync load + background refresh if stale
  initModelLimits();
  initCatalog();
  initBenchmarks();

  // Load keybindings from disk (merges user overrides with defaults)
  getKeybindingsManager().loadFromDisk();

  // ── Phase 2: Core subsystems ─────────────────────────────────────────

  const runtimeBus = new RuntimeEventBus();
  const store = createRuntimeStore();
  const domainDispatch = createDomainDispatch(store);
  const forensicsRegistry = new ForensicsRegistry();
  const forensicsCollector = new ForensicsCollector(runtimeBus, forensicsRegistry);
  const policyRuntimeState = getPolicyRuntimeState();
  setOpsRuntimeContext({
    runtimeBus,
    store,
    recoveryFilePath: getRecoveryFilePath(),
    lastSessionPointerPath: getLastSessionPointerPath(options?.workingDir),
  });

  setSyntheticRuntimeBus(runtimeBus);
  setPlanRuntimeBus(runtimeBus);

  const conversation = new ConversationManager(() => {
    const w = stdout.columns || 80;
    const pm = getPanelManager();
    if (pm.isVisible() && pm.getAllOpen().length > 0) {
      return Math.max(1, pm.getLeftWidth(w) - 1);
    }
    return w;
  });
  conversation.setConfigManager(configManager);

  const compositor = new Compositor(stdout);
  const selection = new SelectionManager();

  // ── Phase 3: Tool registry + agent wiring ───────────────────────────

  const toolRegistry = new ToolRegistry();
  const { fileCache, projectIndex } = registerAllTools(toolRegistry);
  agentOrchestrator.setDependencies(fileCache, projectIndex);
  agentOrchestrator.setRuntimeBus(runtimeBus);
  AgentManager.getInstance().setRuntimeBus(runtimeBus);
  WrfcController.initialize(runtimeBus);

  // ── Phase 4: Event bus subscriptions ──────────────────────────────────

  // These unsubs are owned by bootstrap; cleared via shutdown()
  const bootstrapUnsubs: Array<() => void> = [];
  const renderRequestRef = {
    value: (): void => {},
  };
  const requestRender = (): void => {
    renderRequestRef.value();
  };
  const permissionPromptRef = {
    requestPermission: (async () => ({ approved: false, remember: false })) as PermissionRequestHandler,
  };
  const runtimeUnsubs: Array<() => void> = [];
  runtimeUnsubs.push(runtimeBus.onDomain('turn', (env) => {
    domainDispatch.dispatchTurnEvent(env.payload);
  }));
  runtimeUnsubs.push(runtimeBus.onDomain('agents', (env) => {
    domainDispatch.dispatchAgentEvent(env.payload);
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CASCADE_ABORTED' }>>('WORKFLOW_CASCADE_ABORTED', ({ payload }) => {
    const { chainId, reason } = payload;
    systemMessageRouter.high(`[WRFC] Cascade abort: ${reason} (chain ${chainId})`);
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<ProviderEvent, { type: 'MODEL_FALLBACK' }>>('MODEL_FALLBACK', ({ payload }) => {
    const { from, to, provider: fallbackProvider } = payload;
    systemMessageRouter.high(
      `[Model] ${from} exhausted across all providers. Automatically falling back to ${to} via ${fallbackProvider}.`
    );
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_CREATED' }>>('WORKFLOW_CHAIN_CREATED', ({ payload }) => {
    const { chainId, task } = payload;
    systemMessageRouter.high(`[WRFC] Chain ${chainId} started: ${task}`);
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_REVIEW_COMPLETED' }>>('WORKFLOW_REVIEW_COMPLETED', ({ payload }) => {
    const { chainId, score, passed } = payload;
    const icon = passed ? '\u2713' : '\u2717';
    const threshold = configManager.get('wrfc.scoreThreshold') as number;
    const suffix = passed ? '' : ` - Minimum score is ${threshold}/10, spawning a fix agent ...`;
    systemMessageRouter.high(`[WRFC] ${icon} Review ${chainId.slice(0, 12)}: ${score}/10${suffix}`);
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', ({ payload }) => {
    const { chainId } = payload;
    systemMessageRouter.high(`[WRFC] \u2713 Chain ${chainId.slice(0, 12)} PASSED \u2014 all gates clear`);
    // Re-check cohort completion now that a WRFC chain finished
    const chain = WrfcController.getInstance().getChain(chainId);
    if (chain?.engineerAgentId) {
      const record = AgentManager.getInstance().getStatus(chain.engineerAgentId);
      checkCohortCompletion(record ?? null);
    }
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', ({ payload }) => {
    const { chainId, reason } = payload;
    systemMessageRouter.high(`[WRFC] \u2717 Chain ${chainId.slice(0, 12)} FAILED: ${reason.slice(0, 80)}`);
    // Re-check cohort completion now that a WRFC chain finished
    const chain = WrfcController.getInstance().getChain(chainId);
    if (chain?.engineerAgentId) {
      const record = AgentManager.getInstance().getStatus(chain.engineerAgentId);
      checkCohortCompletion(record ?? null);
    }
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_AUTO_COMMITTED' }>>('WORKFLOW_AUTO_COMMITTED', ({ payload }) => {
    const { chainId, commitHash } = payload;
    const suffix = commitHash ? ` (${commitHash.slice(0, 7)})` : '';
    systemMessageRouter.high(`[WRFC] Auto-committed chain ${chainId.slice(0, 12)}${suffix}`);
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_GATE_RESULT' }>>('WORKFLOW_GATE_RESULT', ({ payload }) => {
    const { gate, passed } = payload;
    const icon = passed ? '\u2713' : '\u2717';
    systemMessageRouter.high(`[WRFC]   ${icon} Gate: ${gate} ${passed ? 'passed' : 'FAILED'}`);
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_STREAM_DELTA' }>>('AGENT_STREAM_DELTA', () => {
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_PROGRESS' }>>('AGENT_PROGRESS', () => {
    requestRender();
  }));

  // ── Agent cohort helpers ──────────────────────────────────────────────────

  const buildCohortReport = (cohort: string): string => {
    const mgr = AgentManager.getInstance();
    const agents = mgr.listByCohort(cohort);
    if (agents.length === 0) return `[Agents] Cohort '${cohort}' complete (no agents found).`;
    const completed = agents.filter(a => a.status === 'completed').length;
    const failed = agents.filter(a => a.status === 'failed').length;
    const cancelled = agents.filter(a => a.status === 'cancelled').length;
    const lines: string[] = [
      `[Agents] Cohort '${cohort}' complete: ${completed} completed, ${failed} failed, ${cancelled} cancelled (${agents.length} total)`,
    ];
    for (const a of agents) {
      const dur = a.completedAt !== undefined ? Math.round((a.completedAt - a.startedAt) / 1000) : 0;
      const icon = a.status === 'completed' ? '\u2713' : a.status === 'failed' ? '\u2717' : '~';
      const errSuffix = a.error ? ` \u2014 ${a.error.slice(0, 60)}` : '';
      lines.push(`  ${icon} ${a.id.slice(-8)}: ${a.status} in ${dur}s (${a.toolCallCount} tool calls)${errSuffix}`);
    }
    return lines.join('\n');
  };

  const checkCohortCompletion = (record: { cohort?: string } | null): void => {
    if (!record?.cohort) return;
    const cohortAgents = AgentManager.getInstance().listByCohort(record.cohort);
    const allAgentsDone = cohortAgents.every(a => a.status !== 'running' && a.status !== 'pending');
    if (!allAgentsDone) return;

    // Also check that all WRFC chains for this cohort's agents are in terminal states
    const wrfc = WrfcController.getInstance();
    const allChains = wrfc.listChains();
    const cohortAgentIds = new Set(cohortAgents.map(a => a.id));
    const cohortChains = allChains.filter(c =>
      (c.engineerAgentId && cohortAgentIds.has(c.engineerAgentId)) ||
      (c.reviewerAgentId && cohortAgentIds.has(c.reviewerAgentId)) ||
      (c.fixerAgentId && cohortAgentIds.has(c.fixerAgentId))
    );
    const terminalStates = new Set(['passed', 'failed']);
    const allChainsDone = cohortChains.every(c => terminalStates.has(c.state));
    if (!allChainsDone) return;

    systemMessageRouter.low(buildCohortReport(record.cohort));
  };

  runtimeUnsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
    const record = AgentManager.getInstance().getStatus(payload.agentId);
    if (record) {
      const dur = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? record.task.slice(0, 50) + '\u2026' : record.task;
      systemMessageRouter.low(
        `[Agents] \u2713 ${record.template} ${payload.agentId.slice(-8)}: "${taskSnippet}" \u2014 completed in ${dur}s (${record.toolCallCount} tool calls)`
      );
    }
    checkCohortCompletion(record ?? null);
    requestRender();
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
    const record = AgentManager.getInstance().getStatus(payload.agentId);
    if (record && record.status !== 'cancelled') {
      const dur = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? record.task.slice(0, 50) + '\u2026' : record.task;
      systemMessageRouter.low(
        `[Agents] \u2717 ${record.template} ${payload.agentId.slice(-8)}: "${taskSnippet}" \u2014 failed in ${dur}s: ${payload.error.slice(0, 80)}`
      );
    }
    checkCohortCompletion(record ?? null);
    requestRender();
  }));

  // Periodic agent status summary — stored only in the ref so shutdown() always sees the current value.
  const AGENT_STATUS_INTERVAL_MS = 30_000;
  const agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null } = { value: null };
  agentStatusIntervalRef.value = setInterval(() => {
    const running = AgentManager.getInstance().list().filter(a => a.status === 'running');
    if (running.length === 0) return;
    const lines = running.map(a => `  ${a.id.slice(-8)}: ${a.progress ?? a.status}`);
    systemMessageRouter.low(`[Agents] ${running.length} running:\n${lines.join('\n')}`);
    requestRender();
  }, AGENT_STATUS_INTERVAL_MS);

  // ── Phase 5: Providers, webhooks, PermissionManager, HookDispatcher ─────────

  // Start watching for custom provider file changes (hot-reload)
  providerRegistry.startWatching(runtimeBus);

  const webhookUrls = (configManager.getCategory('notifications') as { webhookUrls?: string[] }).webhookUrls ?? [];
  if (webhookUrls.length > 0) {
    const webhookNotifier = WebhookNotifier.fromConfig(webhookUrls);
    webhookNotifier.attachToRuntimeBus(runtimeBus);
    setWebhookNotifier(webhookNotifier);
  }

  const permissionManager = new PermissionManager((request) => permissionPromptRef.requestPermission(request));
  const hookDispatcher = getHookDispatcher();

  // ── Phase 5b: Runtime state object ───────────────────────────────────────

  const runtime: MutableRuntimeState = {
    model: configManager.get('provider.model') as string,
    provider: configManager.get('provider.provider') as string,
    debugMode: false,
    systemPrompt: loadSystemPrompt() || getConfiguredSystemPrompt() || '',
    reasoningEffort: (configManager.get('provider.reasoningEffort') as string | undefined) ?? '',
    sessionId: userSessionId,
  };

  // ── Phase 5c: Hook bridge subscriptions ────────────────────────────────

  const fireHook = (path: HookEventPath, phase: HookPhase, category: HookCategory, specific: string, payload: Record<string, unknown>): void => {
    hookDispatcher.fire({
      path,
      phase,
      category,
      specific,
      sessionId: runtime.sessionId,
      timestamp: Date.now(),
      payload,
    }).catch((err: unknown) => logger.debug('Hook bridge fire error', { path, error: String(err) }));
  };

  const resumeSession = (sessionId: string): void => {
    try {
      const sm = getSessionManager();
      const { messages, meta } = sm.load(sessionId);
      emitSessionResumed(runtimeBus, {
        sessionId: runtime.sessionId,
        traceId: `${runtime.sessionId}:session-resume:${sessionId}`,
        source: 'bootstrap',
      }, {
        sessionId,
        turnCount: messages.length,
      });
      conversation.fromJSON({ messages: messages as Parameters<typeof conversation.fromJSON>[0]['messages'] });
      runtime.sessionId = sessionId;
      if (meta?.model) runtime.model = meta.model;
      if (meta?.provider) runtime.provider = meta.provider;
      writeLastSessionPointer(sessionId);
      conversation.log(`Resumed session: ${sessionId}`, { fg: '135' });
      fireHook('Lifecycle:session:load', 'Lifecycle', 'session', 'load', { sessionId });
    } catch (e) {
      logger.debug('resumeSession failed', { error: String(e) });
      conversation.log('Failed to resume session.', { fg: '#ef4444' });
    }
    requestRender();
  };

  runtimeUnsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>>('AGENT_SPAWNING', ({ payload }) => {
    fireHook('Lifecycle:agent:spawned', 'Lifecycle', 'agent', 'spawned', { agentId: payload.agentId, task: payload.task });
  }));
  runtimeUnsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
    fireHook('Lifecycle:agent:completed', 'Lifecycle', 'agent', 'completed', {
      agentId: payload.agentId,
      result: {
        durationMs: payload.durationMs,
        ...(payload.output !== undefined ? { output: payload.output } : {}),
        ...(payload.toolCallsMade !== undefined ? { toolCallsMade: payload.toolCallsMade } : {}),
      },
    });
  }));
  runtimeUnsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
    const isCancelled = payload.error === 'Agent cancelled' || payload.error.includes('cancelled');
    const specific = isCancelled ? 'cancelled' : 'failed';
    fireHook(`Lifecycle:agent:${specific}` as HookEventPath, 'Lifecycle', 'agent', specific, { agentId: payload.agentId, error: payload.error });
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_CREATED' }>>('WORKFLOW_CHAIN_CREATED', ({ payload }) => {
    fireHook('Lifecycle:workflow:started', 'Lifecycle', 'workflow', 'started', { chainId: payload.chainId, task: payload.task });
  }));
  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', ({ payload }) => {
    fireHook('Lifecycle:workflow:completed', 'Lifecycle', 'workflow', 'completed', { chainId: payload.chainId });
  }));
  runtimeUnsubs.push(runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', ({ payload }) => {
    fireHook('Lifecycle:workflow:failed', 'Lifecycle', 'workflow', 'failed', { chainId: payload.chainId, reason: payload.reason });
  }));

  runtimeUnsubs.push(runtimeBus.on<Extract<OpsEvent, { type: 'OPS_CONTEXT_WARNING' }>>('OPS_CONTEXT_WARNING', ({ payload: { usage, threshold } }) => {
    const specific = usage >= threshold ? 'exceeded' : 'warning';
    fireHook(`Change:budget:${specific}` as HookEventPath, 'Change', 'budget', specific, { usage, threshold });
  }));

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
      const contextWindow = getContextWindowForModel(currentModel);
      const tier = getTierForContextWindow(contextWindow);
      const supplement = getTierPromptSupplement(tier);
      return supplement ? runtime.systemPrompt + '\n\n' + supplement : runtime.systemPrompt;
    },
    hookDispatcher,
    null,
    () => orchestratorRefs.requestRender(),
    runtimeBus,
  );

  const acpManager = new AcpManager((request) => permissionPromptRef.requestPermission(request), runtimeBus);
  orchestrator.registerDelegateTool(acpManager);

  // ── Phase 7: MCP auto-connect + panel manager ─────────────────────────

  const panelManager = getPanelManager();
  registerBuiltinPanels(panelManager, {
    getOrchestratorUsage: () => orchestrator.usage as { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string },
    toolRegistry,
    providerRegistry,
    contextWindow: providerRegistry.getCurrentModel().contextWindow,
    orchestrator,
    getCtxWindow: () => providerRegistry.getCurrentModel().contextWindow,
    resumeSession,
    requestRender,
    runtimeBus,
    forensicsRegistry,
    policyRuntimeState,
  });

  // ── System message router ────────────────────────────────────────────────
  // Instantiated here so bootstrap event handlers can route through it.
  // The panel reference is null at startup (SystemMessagesPanel is created lazily
  // when the user opens it). Messages to the panel are silently dropped until
  // a panel instance is available.
  const systemMessageRouter = createSystemMessageRouter(conversation, null);
  scheduleMcpAutodiscovery({
    mcpRegistry,
    systemMessageRouter,
    requestRender,
  });

  // ── Phase 8: Command registry + plugin init + CommandContext ───────────────

  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry);

  // Plugin system (singleton, lazy import)
  { const { pluginManager } = await import('../plugins/manager.ts');
    await pluginManager.init({
      runtimeBus,
      commandRegistry,
      providerRegistry,
      toolRegistry,
      getPluginConfig: (name) => pluginManager.getPluginConfig(name),
      isEnabled: (name) => pluginManager.isEnabled(name),
    });
  }

  const commandContext: CommandContext = createBootstrapCommandContext({
    providerRegistry,
    conversation,
    runtime,
    requestRender,
    requestPermission: (request) => permissionPromptRef.requestPermission(request),
    toolRegistry,
    mcpRegistry,
    forensicsRegistry,
    policyRuntimeState,
    loadSystemPrompt,
    activatePlan: (_planId, task) => {
      setTimeout(() => {
        orchestrator.handleUserInput(task).catch((err) => {
          logger.debug('activatePlan handler failed', { error: String(err) });
        });
      }, 50);
    },
    completeModelSelectionSideEffect: () => {
      compositor.resetDiff();
    },
  });

  // ── Phase 9: Input handler ──────────────────────────────────────────────
  // Note: getViewportHeight and scroll are UI concerns; main.ts constructs these
  // after receiving the context, then calls input.setContentWidth etc.
  // Shell-owned actions are bound in main.ts after terminal ownership is established.

  // Git status provider (initialized in bootstrap, used in main.ts render)
  const gitStatusProvider = new GitStatusProvider();
  let lastGitInfo: GitHeaderInfo | undefined = undefined;
  gitStatusProvider.getStatus().then((info) => {
    lastGitInfo = info;
    requestRender();
  }).catch(() => { /* non-fatal */ });
  // ── Phase 10: Input history + splash options ───────────────────────────

  const saveHistory = configManager.get('behavior.saveHistory') as boolean;
  const inputHistory = new InputHistory(undefined, saveHistory);

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir: getWorkingDirectory(),
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
  };

  // ── Phase 11: Background provider registration (non-blocking) ────────────
  // These run after the initial render so they don't delay startup.

  startBackgroundProviderRegistration({
    runtime,
    requestRender,
    restoreSavedModel,
    systemMessageRouter,
  });

  // ── Phase 12: Session:start lifecycle hook ─────────────────────────────

  fireSessionStart(runtime.sessionId);
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
    featureFlags,
    conversation,
    permissions: permissionManager,
    toolRegistry,
    providerRegistry,
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
    lastGitInfoRef: { value: lastGitInfo },
    bootstrapUnsubs,
    agentStatusIntervalRef,
    orchestratorRefs,
    permissionPromptRef,
    loadLastConversation: loadLastConversation,
    _writeLastSessionPointer: writeLastSessionPointer,
    _saveSession: saveSession,
    _getPinned: getPinned,
    _getConfiguredProviderIds: getConfiguredProviderIds,
    commandRegistry,
    systemMessageRouter,
    shutdown: async (sessionData) => {
      // Clear bootstrap-owned subscriptions
      bootstrapUnsubs.forEach(fn => fn());
      bootstrapUnsubs.length = 0;
      runtimeUnsubs.forEach((fn) => fn());
      runtimeUnsubs.length = 0;
      forensicsCollector.dispose();
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
      );
    },
  };

  // ── Phase 12b: Operator Control Plane wiring (feature-gated) ──────────────
  // Wire the OpsControlPlane into CommandContext when the feature flag is enabled.
  // The store and task manager are created unconditionally so they reflect the
  // real runtime state (tasks registered before the flag check are visible).
  const opsTaskManager = createTaskManager(store, runtimeBus, userSessionId);
  if (featureFlags.isEnabled('operator-control-plane')) {
    const opsControlPlane = new OpsControlPlane(opsTaskManager, runtimeBus, store, userSessionId);
    ctx.commandContext.opsControlPlane = opsControlPlane;
    ctx.commandContext.openOpsPanel = () => {
      const pm = getPanelManager();
      pm.open('ops-control');
      requestRender();
    };
  }

  // Wire exit from options if provided; otherwise main.ts binds the shell bridge.
  if (options?.exit) {
    ctx.commandContext.exit = options.exit;
  }

  return ctx;
}
