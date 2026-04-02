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
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { EventBus } from '../core/event-bus.ts';
import { ConversationManager } from '../core/conversation.ts';
import { Orchestrator } from '../core/orchestrator.ts';
import { SelectionManager } from '../input/selection.ts';
import { config, configManager } from '../config/index.ts';
import { providerRegistry } from '../providers/registry.ts';
import { autoRegisterProviders } from '../providers/auto-register.ts';
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
import { scan, loadPersistedProviders, persistProviders, removePersistedProviders, scanMcpServers } from '../discovery/index.ts';
import { getSessionManager } from '../sessions/manager.ts';
import { logger } from '../utils/logger.ts';
import { getPinned } from '../providers/favorites.ts';
import { initModelLimits, getContextWindowForModel } from '../providers/model-limits.ts';
import { initBenchmarks } from '../providers/model-benchmarks.ts';
import { setSyntheticBus } from '../providers/synthetic.ts';
import { initCatalog, getConfiguredProviderIds } from '../providers/model-catalog.ts';
import { getPanelManager } from '../panels/panel-manager.ts';
import { registerBuiltinPanels } from '../panels/builtin-panels.ts';
import { mcpRegistry } from '../mcp/registry.ts';
import { getKeybindingsManager } from '../input/keybindings.ts';
import { sessionMemoryStore } from '../core/session-memory.ts';
import { FileUndoManager } from '../state/file-undo.ts';
import { Compositor } from '../renderer/compositor.ts';
import type { SessionMeta } from '../sessions/manager.ts';

import type { HookPhase, HookCategory, HookEventPath } from '../hooks/types.ts';
import type { RuntimeContext, BootstrapOptions, MutableRuntimeState } from './context.ts';
import { shutdownRuntime, fireSessionStart, saveSession } from './lifecycle.ts';
import { createFeatureFlagManager } from './feature-flags/index.ts';

// ── Session file paths ─────────────────────────────────────────────────────

const USER_SESSIONS_DIR = join(process.cwd(), '.goodvibes', 'tui', 'sessions');
const LAST_SESSION_POINTER = join(USER_SESSIONS_DIR, 'last-session.json');

// ── Internal helpers ──────────────────────────────────────────────────────

/** Generate an 8-character lowercase hex session ID. */
function generateUserSessionId(): string {
  return randomBytes(4).toString('hex');
}

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

/** Write the last-session pointer (imported in main.ts for use after session resume). */
export function writeLastSessionPointer(sessionId: string): void {
  try {
    mkdirSync(USER_SESSIONS_DIR, { recursive: true });
    writeFileSync(
      LAST_SESSION_POINTER,
      JSON.stringify({ sessionId, timestamp: new Date().toISOString() }) + '\n',
      'utf-8',
    );
  } catch (e) { logger.debug('writeLastSessionPointer failed', { error: String(e) }); }
}

/** Read the last-session pointer. Returns null if none exists or on error. */
function readLastSessionPointer(): string | null {
  try {
    if (existsSync(LAST_SESSION_POINTER)) {
      const data = JSON.parse(readFileSync(LAST_SESSION_POINTER, 'utf-8')) as { sessionId?: unknown };
      if (typeof data.sessionId === 'string' && data.sessionId.trim()) return data.sessionId;
    }
  } catch (e) { logger.debug('readLastSessionPointer failed', { error: String(e) }); }
  return null;
}

/**
 * Load the last user session from the pointer file.
 * Returns the messages array or null if no session exists.
 */
function loadLastConversation(): { messages: Array<Record<string, unknown>> } | null {
  try {
    const lastId = readLastSessionPointer();
    if (!lastId) {
      // Migration: check old format
      const oldPath = join(homedir(), '.goodvibes', 'conversations', 'last.json');
      if (existsSync(oldPath)) {
        try {
          const raw = readFileSync(oldPath, 'utf-8');
          const data = JSON.parse(raw) as { messages?: unknown };
          if (data.messages && Array.isArray(data.messages)) {
            const migrationId = `user-${generateUserSessionId()}`;
            const sm = getSessionManager();
            const meta: SessionMeta = {
              title: '',
              model: '',
              provider: '',
              timestamp: Date.now(),
            };
            sm.save(migrationId, data.messages as Array<Record<string, unknown>>, meta);
            writeLastSessionPointer(migrationId);
            logger.debug('Migrated old conversation from conversations/last.json', { newSessionId: migrationId });
            return { messages: data.messages as Array<Record<string, unknown>> };
          }
        } catch (e) { logger.debug('Old session migration failed', { error: String(e) }); }
      }
      return null;
    }
    const sm = getSessionManager();
    const { messages } = sm.load(lastId);
    return { messages: messages as Array<Record<string, unknown>> };
  } catch (e) { logger.debug('loadLastConversation failed', { error: String(e) }); }
  return null;
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
  /** Mutable refs for viewport/scroll functions; main.ts patches these after constructing UI state. */
  orchestratorRefs: { getViewportHeight: () => number; scrollToEnd: (vHeight: number) => void };
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
 *   2. EventBus, ConversationManager, Compositor, SelectionManager
 *   3. Tool registry + agent wiring
 *   4. Event bus subscriptions (WRFC, subagent, hook bridge)
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

  // ── Phase 1: Config, caches, keybindings ────────────────────────────────

  const userSessionId = `user-${generateUserSessionId()}`;

  // Sync load + background refresh if stale
  initModelLimits();
  initCatalog();
  initBenchmarks();

  // Load keybindings from disk (merges user overrides with defaults)
  getKeybindingsManager().loadFromDisk();

  // ── Phase 2: Core subsystems ─────────────────────────────────────────

  const bus = new EventBus();

  // Inject bus into the synthetic provider for cross-model failover notifications
  setSyntheticBus(bus);

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
  agentOrchestrator.setEventBus(bus);
  WrfcController.getInstance(bus);

  // ── Phase 4: Event bus subscriptions ──────────────────────────────────

  // These unsubs are owned by bootstrap; cleared via shutdown()
  const bootstrapUnsubs: Array<() => void> = [];

  bootstrapUnsubs.push(bus.on('wrfc:cascade-abort', ({ chainId, reason }: { chainId: string; reason: string }) => {
    conversation.addSystemMessage(`[WRFC] Cascade abort: ${reason} (chain ${chainId})`);
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('model:fallback', ({ from, to, provider: fallbackProvider }: { from: string; to: string; provider: string }) => {
    conversation.addSystemMessage(
      `[Model] ${from} exhausted across all providers. Automatically falling back to ${to} via ${fallbackProvider}.`
    );
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('wrfc:chain-created', ({ chainId, task }: { chainId: string; task: string }) => {
    conversation.addSystemMessage(`[WRFC] Chain ${chainId} started: ${task}`);
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('wrfc:review-complete', ({ chainId, score, passed }: { chainId: string; score: number; passed: boolean }) => {
    const icon = passed ? '\u2713' : '\u2717';
    const threshold = configManager.get('wrfc.scoreThreshold') as number;
    const suffix = passed ? '' : ` - Minimum score is ${threshold}/10, spawning a fix agent ...`;
    conversation.addSystemMessage(`[WRFC] ${icon} Review ${chainId.slice(0, 12)}: ${score}/10${suffix}`);
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('wrfc:chain-passed', ({ chainId }: { chainId: string }) => {
    conversation.addSystemMessage(`[WRFC] \u2713 Chain ${chainId.slice(0, 12)} PASSED \u2014 all gates clear`);
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('wrfc:chain-failed', ({ chainId, reason }: { chainId: string; reason: string }) => {
    conversation.addSystemMessage(`[WRFC] \u2717 Chain ${chainId.slice(0, 12)} FAILED: ${reason.slice(0, 80)}`);
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('wrfc:auto-commit', ({ chainId, commitHash }: { chainId: string; commitHash?: string }) => {
    const suffix = commitHash ? ` (${commitHash.slice(0, 7)})` : '';
    conversation.addSystemMessage(`[WRFC] Auto-committed chain ${chainId.slice(0, 12)}${suffix}`);
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('wrfc:gate-result', ({ chainId, gate, passed }: { chainId: string; gate: string; passed: boolean }) => {
    const icon = passed ? '\u2713' : '\u2717';
    conversation.addSystemMessage(`[WRFC]   ${icon} Gate: ${gate} ${passed ? 'passed' : 'FAILED'}`);
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('subagent:stream-delta', () => {
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('subagent:progress', () => {
    bus.emit('render:request');
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
    const allDone = cohortAgents.every(a => a.status !== 'running' && a.status !== 'pending');
    if (allDone) {
      conversation.addSystemMessage(buildCohortReport(record.cohort));
    }
  };

  bootstrapUnsubs.push(bus.on('subagent:complete', ({ id }: { id: string }) => {
    const record = AgentManager.getInstance().getStatus(id);
    if (record) {
      const dur = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? record.task.slice(0, 50) + '\u2026' : record.task;
      conversation.addSystemMessage(
        `[Agents] \u2713 ${record.template} ${id.slice(-8)}: "${taskSnippet}" \u2014 completed in ${dur}s (${record.toolCallCount} tool calls)`
      );
    }
    checkCohortCompletion(record ?? null);
    bus.emit('render:request');
  }));

  bootstrapUnsubs.push(bus.on('subagent:error', ({ id, error }: { id: string; error: Error }) => {
    const record = AgentManager.getInstance().getStatus(id);
    if (record && record.status !== 'cancelled') {
      const dur = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? record.task.slice(0, 50) + '\u2026' : record.task;
      conversation.addSystemMessage(
        `[Agents] \u2717 ${record.template} ${id.slice(-8)}: "${taskSnippet}" \u2014 failed in ${dur}s: ${error.message.slice(0, 80)}`
      );
    }
    checkCohortCompletion(record ?? null);
    bus.emit('render:request');
  }));

  // Periodic agent status summary — stored only in the ref so shutdown() always sees the current value.
  const AGENT_STATUS_INTERVAL_MS = 30_000;
  const agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null } = { value: null };
  agentStatusIntervalRef.value = setInterval(() => {
    const running = AgentManager.getInstance().list().filter(a => a.status === 'running');
    if (running.length === 0) return;
    const lines = running.map(a => `  ${a.id.slice(-8)}: ${a.progress ?? a.status}`);
    conversation.addSystemMessage(`[Agents] ${running.length} running:\n${lines.join('\n')}`);
    bus.emit('render:request');
  }, AGENT_STATUS_INTERVAL_MS);

  // ── Phase 5: Providers, webhooks, PermissionManager, HookDispatcher ─────────

  // Start watching for custom provider file changes (hot-reload)
  providerRegistry.startWatching(bus);

  const webhookUrls = (configManager.getCategory('notifications') as { webhookUrls?: string[] }).webhookUrls ?? [];
  if (webhookUrls.length > 0) {
    const webhookNotifier = WebhookNotifier.fromConfig(webhookUrls);
    webhookNotifier.attachToEventBus(bus);
    setWebhookNotifier(webhookNotifier);
  }

  const permissionManager = new PermissionManager(bus);
  const hookDispatcher = getHookDispatcher();

  // ── Phase 5b: Runtime state object ───────────────────────────────────────

  const runtime: MutableRuntimeState = {
    model: configManager.get('provider.model') as string,
    provider: configManager.get('provider.provider') as string,
    debugMode: false,
    systemPrompt: loadSystemPrompt() || config.systemPrompt || '',
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

  bootstrapUnsubs.push(bus.on('subagent:spawned', ({ id, task }: { id: string; task: string }) => {
    fireHook('Lifecycle:agent:spawned', 'Lifecycle', 'agent', 'spawned', { agentId: id, task });
  }));
  bootstrapUnsubs.push(bus.on('subagent:complete', ({ id, result }: { id: string; result: unknown }) => {
    fireHook('Lifecycle:agent:completed', 'Lifecycle', 'agent', 'completed', { agentId: id, result: result as Record<string, unknown> });
  }));
  bootstrapUnsubs.push(bus.on('subagent:error', ({ id, error }: { id: string; error: Error }) => {
    const isCancelled = error.message === 'Agent cancelled' || error.message.includes('cancelled');
    const specific = isCancelled ? 'cancelled' : 'failed';
    fireHook(`Lifecycle:agent:${specific}` as HookEventPath, 'Lifecycle', 'agent', specific, { agentId: id, error: error.message });
  }));

  bootstrapUnsubs.push(bus.on('wrfc:chain-created', ({ chainId, task }: { chainId: string; task: string }) => {
    fireHook('Lifecycle:workflow:started', 'Lifecycle', 'workflow', 'started', { chainId, task });
  }));
  bootstrapUnsubs.push(bus.on('wrfc:chain-passed', ({ chainId }: { chainId: string }) => {
    fireHook('Lifecycle:workflow:completed', 'Lifecycle', 'workflow', 'completed', { chainId });
  }));
  bootstrapUnsubs.push(bus.on('wrfc:chain-failed', ({ chainId, reason }: { chainId: string; reason: string }) => {
    fireHook('Lifecycle:workflow:failed', 'Lifecycle', 'workflow', 'failed', { chainId, reason });
  }));

  bootstrapUnsubs.push(bus.on('context:warning', ({ usage, threshold }: { usage: number; threshold: number }) => {
    const specific = usage >= threshold ? 'exceeded' : 'warning';
    fireHook(`Change:budget:${specific}` as HookEventPath, 'Change', 'budget', specific, { usage, threshold });
  }));

  // ── Phase 6: Orchestrator + AcpManager ───────────────────────────────────

  // Mutable function refs so main.ts can patch these after constructing the scroll/viewport state.
  // The orchestrator closes over these refs, so patching them in main.ts takes immediate effect.
  const orchestratorRefs = {
    getViewportHeight: (): number => 20,
    scrollToEnd: (_vHeight: number): void => { /* patched by main.ts */ },
  };

  const orchestrator = new Orchestrator(
    bus,
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
  );

  const acpManager = new AcpManager(bus);
  orchestrator.registerDelegateTool(acpManager);

  // ── Phase 7: MCP auto-connect + panel manager ─────────────────────────

  mcpRegistry.connectAll(config.workingDir ?? process.cwd()).catch((err) => {
    logger.debug('MCP auto-connect failed (non-fatal)', { error: String(err) });
  });

  setTimeout(() => {
    const workDir = config.workingDir ?? process.cwd();
    const registeredNames = new Set(mcpRegistry.serverNames);
    scanMcpServers(workDir, registeredNames).then((result) => {
      if (result.suggestions.length === 0) return;
      for (const suggestion of result.suggestions) {
        conversation.addSystemMessage(
          `[MCP] Discovered server '${suggestion.name}' (${suggestion.command} ${(suggestion.args ?? []).join(' ')}).` +
          ` Add it to .goodvibes/mcp.json or ~/.config/mcp/mcp.json to enable it.`
        );
      }
      bus.emit('render:request');
    }).catch((err) => {
      logger.debug('MCP auto-discovery scan failed (non-fatal)', { error: String(err) });
    });
  }, 2000);

  const panelManager = getPanelManager();
  registerBuiltinPanels(panelManager, {
    bus,
    getOrchestratorUsage: () => orchestrator.usage as { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string },
    toolRegistry,
    providerRegistry,
    contextWindow: providerRegistry.getCurrentModel().contextWindow,
    orchestrator,
    getCtxWindow: () => providerRegistry.getCurrentModel().contextWindow,
  });

  bootstrapUnsubs.push(bus.on('plan:activate', ({ task }: { task: string }) => {
    setTimeout(() => {
      orchestrator.handleUserInput(task).catch((err) => {
        logger.debug('plan:activate handler failed', { error: String(err) });
      });
    }, 50);
  }));

  bootstrapUnsubs.push(bus.on('session:resume', ({ sessionId }: { sessionId: string }) => {
    try {
      const sm = getSessionManager();
      const { messages, meta } = sm.load(sessionId);
      conversation.fromJSON({ messages: messages as Parameters<typeof conversation.fromJSON>[0]['messages'] });
      runtime.sessionId = sessionId;
      if (meta?.model) runtime.model = meta.model;
      if (meta?.provider) runtime.provider = meta.provider;
      writeLastSessionPointer(sessionId);
      conversation.log(`Resumed session: ${sessionId}`, { fg: '135' });
      fireHook('Lifecycle:session:load', 'Lifecycle', 'session', 'load', { sessionId });
    } catch (e) {
      logger.debug('session:resume handler failed', { error: String(e) });
      conversation.log('Failed to resume session.', { fg: '#ef4444' });
    }
    bus.emit('render:request');
  }));

  // ── Phase 8: Command registry + plugin init + CommandContext ───────────────

  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry);

  // Plugin system (singleton, lazy import)
  { const { pluginManager } = await import('../plugins/manager.ts');
    await pluginManager.init({
      eventBus: bus,
      commandRegistry,
      providerRegistry,
      toolRegistry,
      getPluginConfig: (name) => pluginManager.getPluginConfig(name),
      isEnabled: (name) => pluginManager.isEnabled(name),
    });
  }

  const commandContext: CommandContext = {
    eventBus: bus,
    providerRegistry,
    conversationManager: conversation,
    config,
    configManager,
    runtime,
    renderRequest: () => bus.emit('render:request'),
    print: (text: string) => {
      conversation.log(text, { fg: '252' });
      bus.emit('render:request');
    },
    exit: () => {
      // Placeholder: main.ts overwrites this with exitApp after constructing it
      // This should never be called before main.ts has wired exitApp
      logger.debug('commandContext.exit called before exitApp was wired — no-op placeholder');
    },
    reloadSystemPrompt: loadSystemPrompt,
    toolRegistry,
    mcpRegistry,
    fileUndoManager: FileUndoManager.getInstance(),
  };

  // ── Phase 9: Input handler ──────────────────────────────────────────────
  // Note: getViewportHeight and scroll are UI concerns; main.ts constructs these
  // after receiving the context, then calls input.setContentWidth etc.
  // We use placeholder closures here and main.ts patches commandContext.exit and
  // any other deferred wiring.

  // Git status provider (initialized in bootstrap, used in main.ts render)
  const gitStatusProvider = new GitStatusProvider();
  let lastGitInfo: GitHeaderInfo | undefined = undefined;
  gitStatusProvider.getStatus().then((info) => {
    lastGitInfo = info;
    bus.emit('render:request');
  }).catch(() => { /* non-fatal */ });

  // model-picker:complete wiring (needs compositor)
  bootstrapUnsubs.push(bus.on('model-picker:complete', (data) => {
    if (!data?.model) return;
    const def = data.model;
    const effort = data.effort;
    const key = def.registryKey ?? `${def.provider}:${def.id}`;
    try {
      providerRegistry.setCurrentModel(key);
      runtime.model = key;
      runtime.provider = def.provider;
      runtime.reasoningEffort = effort as 'instant' | 'low' | 'medium' | 'high';
      configManager.set('provider.model', key);
      configManager.set('provider.provider', def.provider);
      configManager.set('provider.reasoningEffort', effort as 'instant' | 'low' | 'medium' | 'high');
      conversation.log(`Switched to model: ${def.displayName} (${def.provider}), effort: ${effort}`, { fg: '135' });
      bus.emit('command:model-changed', { provider: def.provider, model: def.id });
    } catch (e) {
      conversation.log(`Error switching model: ${(e as Error).message}`, { fg: '#ef4444' });
    }
    compositor.resetDiff();
    bus.emit('render:request');
  }));

  // ── Phase 10: Input history + splash options ───────────────────────────

  const saveHistory = configManager.get('behavior.saveHistory') as boolean;
  const inputHistory = new InputHistory(undefined, saveHistory);

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir: config.workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
  };

  // ── Phase 11: Background provider registration (non-blocking) ────────────
  // These run after the initial render so they don't delay startup.

  autoRegisterProviders();

  const persisted = loadPersistedProviders();
  if (persisted.length > 0) {
    try {
      providerRegistry.registerDiscoveredProviders(persisted);
      restoreSavedModel(
        configManager.get('provider.model') as string,
        configManager.get('provider.provider') as string,
        runtime,
      );
      for (const server of persisted) {
        conversation.addSystemMessage(
          `[Local] ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''}) \u2014 from last session`
        );
      }
      bus.emit('render:request');
    } catch (err) {
      logger.debug('[bootstrap] Non-fatal error during persisted provider registration', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Background scan to verify persisted + discover new local LLMs
  scan().then((result) => {
    const currentModel = configManager.get('provider.model') as string;
    const foundKeys = new Set(result.servers.map(s => `${s.host}:${s.port}`));
    const persistedKeys = new Set(persisted.map(s => `${s.host}:${s.port}`));
    const newServers = result.servers.filter(s => !persistedKeys.has(`${s.host}:${s.port}`));
    const removedServers = persisted.filter(s => !foundKeys.has(`${s.host}:${s.port}`));

    if (result.servers.length > 0) {
      try {
        providerRegistry.registerDiscoveredProviders(result.servers);
        restoreSavedModel(
          configManager.get('provider.model') as string,
          configManager.get('provider.provider') as string,
          runtime,
        );
      } catch (err) {
        logger.debug('[bootstrap] Non-fatal error during scan provider registration', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const server of newServers) {
      conversation.addSystemMessage(
        `[Scan] Found ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''})`
      );
    }

    if (result.servers.length > 0 && removedServers.length > 0) {
      removePersistedProviders(removedServers);
      for (const server of removedServers) {
        conversation.addSystemMessage(
          `[Scan] ${server.name} at ${server.host}:${server.port} is no longer reachable \u2014 removed`
        );
        const wasActive = server.models.includes(currentModel);
        if (wasActive) {
          configManager.set('provider.model', 'openrouter/free');
          configManager.set('provider.provider', 'openrouter');
          try {
            providerRegistry.setCurrentModel('openrouter/free');
            runtime.model = 'openrouter/free';
            runtime.provider = 'openrouter';
          } catch (err) {
            logger.debug('[bootstrap] Non-fatal error switching model after server removal', { error: err instanceof Error ? err.message : String(err) });
          }
          conversation.addSystemMessage(
            `[Scan] Active model was on ${server.name} \u2014 switched to openrouter/free`
          );
        }
      }
    }

    if (result.servers.length > 0) {
      persistProviders(result.servers);
    }

    if (newServers.length > 0 || removedServers.length > 0) {
      bus.emit('render:request');
    }
  }).catch(() => {
    // Non-fatal: scan failure expected when no local LLMs are running
  });

  // ── Phase 12: Session:start lifecycle hook ─────────────────────────────

  fireSessionStart(runtime.sessionId);

  // ── Compose RuntimeContext ────────────────────────────────────────────────

  const ctx: BootstrapContext = {
    bus,
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
    loadLastConversation: loadLastConversation,
    _writeLastSessionPointer: writeLastSessionPointer,
    _saveSession: saveSession,
    _getPinned: getPinned,
    _getConfiguredProviderIds: getConfiguredProviderIds,
    commandRegistry,
    shutdown: async (sessionData) => {
      // Clear bootstrap-owned subscriptions
      bootstrapUnsubs.forEach(fn => fn());
      bootstrapUnsubs.length = 0;
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

  // Wire exit from options if provided, otherwise leave placeholder for main.ts to patch
  if (options?.exit) {
    ctx.commandContext.exit = options.exit;
  }

  return ctx;
}
