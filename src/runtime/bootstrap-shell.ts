import { join } from 'node:path';
import { readBudgetAlertUsd, BUDGET_ALERT_USD_DEFAULT } from '../export/cost-utils.ts';
import { refreshMemoryRecallSnapshot } from './orchestrator-core-services.ts';
import { sumConversationUsage, type ConversationManager } from '../core/conversation';
import type { Orchestrator } from '../core/orchestrator';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { RuntimeStore } from './store/index.ts';
import type { RuntimeServices } from './services.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { OpsControlPlane } from '@/runtime/index.ts';
import { CommandRegistry } from '../input/command-registry.ts';
import { registerBuiltinCommands } from '../input/commands.ts';
import { InputHistory } from '../input/input-history.ts';
import { GitStatusProvider } from '../renderer/git-status.ts';
import type { GitHeaderInfo } from '../renderer/git-status.ts';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions';
import { registerBuiltinPanels } from '../panels/builtin-panels.ts';
import { WorkspaceRegistrationManager } from './trust/workspace-registration.ts';
import { createSystemMessageRouter, type SystemMessageRouter } from '../core/system-message-router.ts';
import { getConfigSnapshot } from '../config/index.ts';
import { createBootstrapCommandContext } from './bootstrap-command-context.ts';
import { createResumeSessionHandler } from './bootstrap-hook-bridge.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { loadBootstrapSystemPrompt } from '@/runtime/index.ts';
import { createShellPlanRuntime, createShellRemoteCommandService } from '@/runtime/index.ts';
import { createRuntimeFoundationClients } from '@/runtime/index.ts';
import type { ControlPlaneRecentEvent } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { BuiltinPanelDeps } from '../panels/builtin/shared.ts';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { TaskManager } from '@/runtime/index.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { SessionSpineClient } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';

export interface BootstrapShellState {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly gitStatusProvider: GitStatusProvider;
  readonly lastGitInfoRef: { value: GitHeaderInfo | undefined };
  readonly inputHistory: InputHistory;
  readonly systemMessageRouter: SystemMessageRouter;
}

export interface BootstrapShellOptions {
  readonly configManager: ConfigManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly services: RuntimeServices;
  /** Dormant until bootstrap.ts activates it for an adopted 'external' daemon. */
  readonly sessionSpine: SessionSpineClient;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly orchestrator: Orchestrator;
  readonly requestRender: () => void;
  readonly permissionPromptRef: { requestPermission: PermissionRequestHandler };
  readonly onSessionIdChanged: (sessionId: string) => void;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly getControlPlaneRecentEvents: (limit: number) => readonly ControlPlaneRecentEvent[];
  readonly toolRegistry: ToolRegistry;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly uiServices: UiRuntimeServices;
  readonly taskManager: TaskManager;
  readonly opsControlPlane?: OpsControlPlane;
  readonly completeModelSelectionSideEffect?: () => void;
}

export function createBootstrapShell(options: BootstrapShellOptions): BootstrapShellState {
  const {
    configManager,
    runtimeBus,
    runtimeStore,
    services,
    sessionSpine,
    conversation,
    runtime,
    orchestrator,
    requestRender,
    permissionPromptRef,
    onSessionIdChanged,
    writeLastSessionPointer,
    getControlPlaneRecentEvents,
    toolRegistry,
    forensicsRegistry,
    policyRuntimeState,
    uiServices,
    taskManager,
    opsControlPlane,
    completeModelSelectionSideEffect,
  } = options;

  // after any resume seam replays historical messages into `conversation`,
  // the freshly-constructed `orchestrator` still has its zeroed default usage
  // (SDK gap — Orchestrator.usage is never persisted/reseeded). Recompute it
  // from the replayed history so the footer doesn't show Input: 0 post-resume.
  const hydrateSessionUsage = (): void => {
    const { usage, lastInputTokens } = sumConversationUsage(conversation.getMessageSnapshot());
    orchestrator.usage = usage;
    orchestrator.lastInputTokens = lastInputTokens;
  };
  const resumeSession = createResumeSessionHandler({
    runtimeBus,
    runtime,
    conversation,
    requestRender,
    onSessionIdChanged,
    sharedSessionBroker: services.sessionBroker,
    sessionSpine,
    project: services.workingDirectory,
    writeLastSessionPointer,
    hookDispatcher: services.hookDispatcher,
    sessionManager: services.sessionManager,
    panelManager: services.panelManager,
    configManager,
    providerRegistry: services.providerRegistry,
    homeDirectory: services.homeDirectory,
    hydrateSessionUsage,
  });

  const foundationClients = createRuntimeFoundationClients({
    runtimeServices: services,
    tasksReadModel: uiServices.readModels.tasks,
    taskManager,
    opsControlPlane,
  });
  const {
    directTransport,
    hookApi,
    knowledgeApi,
    mcpApi,
    opsApi,
    providerApi,
  } = foundationClients;
  const planRuntime = createShellPlanRuntime({
    adaptivePlanner: services.adaptivePlanner,
    runtimeBus,
  });

  // initial cost-budget alert threshold (USD; 0/unset = disabled).
  // Once the session starts, the real control surface is the CostTrackerPanel
  // itself — the in-panel 'b' key and /cost budget <usd> both call
  // CostTrackerPanel.setBudgetThreshold() directly on the live panel instance,
  // which now writes through to the behavior.budgetAlertUsd config key
  // so the background budget-breach notifier reads the same value. The env
  // var remains a first-run convenience only: it seeds the config key when
  // that key has never been set, so it doesn't silently override a value the
  // user has already configured in a prior session.
  const parsedBudgetThreshold = Number(process.env.GOODVIBES_COST_BUDGET_USD);
  const initialCostBudgetThreshold = Number.isFinite(parsedBudgetThreshold) && parsedBudgetThreshold > 0
    ? parsedBudgetThreshold
    : 0;
  if (initialCostBudgetThreshold > 0 && readBudgetAlertUsd((k) => configManager.get(k as Parameters<typeof configManager.get>[0])) === BUDGET_ALERT_USD_DEFAULT) {
    configManager.set('behavior.budgetAlertUsd' as Parameters<typeof configManager.set>[0], initialCostBudgetThreshold as never);
  }

  let commandContextRef: CommandContext | null = null;
  registerBuiltinPanels(services.panelManager, {
    configManager,
    getOrchestratorUsage: () => orchestrator.usage as { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string },
    budgetThreshold: initialCostBudgetThreshold,
    toolRegistry,
    providerRegistry: services.providerRegistry,
    contextWindow: services.providerRegistry.getContextWindowForModel(services.providerRegistry.getCurrentModel()),
    orchestrator,
    getCtxWindow: () => services.providerRegistry.getContextWindowForModel(services.providerRegistry.getCurrentModel()),
    resumeSession,
    requestRender,
    submitPlanningAnswer: (answer) => {
      if (!commandContextRef?.submitInput) {
        throw new Error('Planning answer submission is not wired yet.');
      }
      commandContextRef.submitInput(answer);
    },
    dismissPlanning: () => {
      services.panelManager.close('project-planning');
      commandContextRef?.focusPrompt?.();
      requestRender();
    },
    forensicsRegistry,
    policyRuntimeState,
    approvalBroker: services.approvalBroker,
    // Panels read the cross-surface union facade, not the raw local broker.
    sessionBroker: uiServices.sessions.sessionBroker,
    automationManager: services.automationManager,
    getControlPlaneRecentEvents,
    tokenAuditor: services.tokenAuditor,
    componentHealthMonitor: services.componentHealthMonitor,
    worktreeRegistry: services.worktreeRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    // Memory modal reads via the spine client, not the raw registry (see builtin/shared.ts).
    memoryRegistry: services.memorySpine,
    uiServices,
    pluginManager: services.pluginManager,
    hookDispatcher: services.hookDispatcher,
    hookActivityTracker: services.hookActivityTracker,
    hookWorkbench: services.hookWorkbench,
    mcpRegistry: services.mcpRegistry,
    daemonHomeDir: join(services.homeDirectory, '.goodvibes', 'daemon'),
    opsApi,
    planRuntime,
    watcherRegistry: services.watcherRegistry,
    runtimeStore,
    openPanel: (panelId: string) => { services.panelManager.open(panelId); },
    knowledgeApi,
  });
  services.panelManager.prewarmRegistered();

  const systemMessageRouter = createSystemMessageRouter(
    conversation,
    (kind) => {
      const ui = getConfigSnapshot(configManager).ui;
      if (kind === 'wrfc') return ui.wrfcMessages;
      if (kind === 'operational') return ui.operationalMessages;
      return ui.systemMessages;
    },
    {
      // Suppress stale WRFC replay re-notifications for chains that can no
      // longer act — gone (killed/removed → getChain null) or terminal
      // (passed/failed). (item 1c.)
      isChainTerminal: (chainId) => {
        const chain = services.wrfcController.getChain(chainId);
        return chain === null || chain.state === 'passed' || chain.state === 'failed';
      },
    },
  );
  orchestrator.setSystemMessageRouter(systemMessageRouter);

  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry);
  const remoteRuntime = createShellRemoteCommandService({
    readModels: uiServices.readModels,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    runtimeStore,
  });

  const commandContext: CommandContext = createBootstrapCommandContext({
    configManager,
    providerRegistry: services.providerRegistry,
    conversation,
    runtime,
    requestRender,
    keybindingsManager: services.keybindingsManager,
    requestPermission: (request) => permissionPromptRef.requestPermission(request),
    toolRegistry,
    mcpRegistry: services.mcpRegistry,
    voiceProviderRegistry: services.voiceProviders,
    voiceService: services.voiceService,
    webSearchService: services.webSearchService,
    mediaProviders: services.mediaProviders,
    artifactStore: services.artifactStore,
    forensicsRegistry,
    policyRuntimeState,
    readModels: uiServices.readModels,
    shellPaths: services.shellPaths,
    remoteRuntime,
    planRuntime,
    fileUndoManager: services.fileUndoManager,
    workspaceCheckpointManager: services.workspaceCheckpointManager,
    gatewayMethods: services.gatewayMethods,
    workspaceTrustManager: services.workspaceTrustManager,
    // Registration half is stateless (reads the shared registry on demand), so
    // it is constructed here for the command context rather than threaded through
    // RuntimeServices — no early-load requirement like the trust gate has.
    workspaceRegistrationManager: new WorkspaceRegistrationManager({ shellPaths: services.shellPaths }),
    memoryRegistry: services.memoryRegistry,
    integrationHelpers: services.integrationHelpers,
    automationManager: services.automationManager,
    knowledgeService: services.knowledgeService,
    projectPlanningService: services.projectPlanningService,
    projectPlanningProjectId: services.projectPlanningProjectId,
    workPlanStore: services.workPlanStore,
    providerOptimizer: services.providerOptimizer,
    pluginManager: services.pluginManager,
    hookWorkbench: services.hookWorkbench,
    agentManager: services.agentManager,
    modeManager: services.modeManager,
    sessionManager: services.sessionManager,
    profileManager: services.profileManager,
    bookmarkManager: services.bookmarkManager,
    favoritesStore: services.favoritesStore,
    benchmarkStore: services.benchmarkStore,
    providerApi,
    subscriptionManager: services.subscriptionManager,
    secretsManager: services.secretsManager,
    serviceRegistry: services.serviceRegistry,
    localUserAuthManager: services.localUserAuthManager,
    tokenAuditor: services.tokenAuditor,
    replayEngine: services.replayEngine,
    webhookNotifier: services.webhookNotifier,
    sessionMemoryStore: services.sessionMemoryStore,
    sessionLineageTracker: services.sessionLineageTracker,
    wrfcController: services.wrfcController,
    workstreamEngine: services.workstreamCommands,
    codeIndexStore: services.codeIndexStore,
    codeIndexReindexScheduler: services.codeIndexReindexScheduler,
    isPassiveCodeInjectionFlagEnabled: () => services.featureFlags.isEnabled('agent-passive-code-injection'),
    featureFlagManager: services.featureFlags,
    // Expose the MAIN session's per-turn passive-injection ring
    // so `/recall injections` (no agent id) renders it — see recall-review.ts.
    getMainSessionTurnInjections: () => orchestrator.getTurnInjections(),
    changeTracker: services.sessionChangeTracker,
    planManager: services.planManager,
    adaptivePlanner: services.adaptivePlanner,
    sessionOrchestration: services.sessionOrchestration,
    operatorClient: directTransport.operator,
    peerClient: directTransport.peer,
    knowledgeApi,
    // /recall's browse/link/queue/export/import subcommands and the per-turn
    // knowledge-injection read route through the spine client, not the raw
    // local registry, so they fully detach when a daemon is adopted.
    memorySpine: services.memorySpine,
    hookApi,
    mcpApi,
    opsApi,
    directTransport,
    panelManager: services.panelManager,
    worktreeRegistry: services.worktreeRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    loadSystemPrompt: () => loadBootstrapSystemPrompt(configManager),
    activatePlan: (_planId, task) => {
      setTimeout(() => {
        void (async () => {
          // Refresh the recall snapshot before this plan-driven turn — see
          // the matching comment in main.ts's submitInput.
          await refreshMemoryRecallSnapshot(services);
          orchestrator.handleUserInput(task).catch((err) => {
            logger.debug('activatePlan handler failed', { error: summarizeError(err) });
          });
        })();
      }, 50);
    },
    completeModelSelectionSideEffect,
    componentHealthMonitor: services.componentHealthMonitor,
    hydrateSessionUsage,
  });
  commandContextRef = commandContext;

  const gitStatusProvider = new GitStatusProvider(services.workingDirectory);
  const lastGitInfoRef = { value: undefined as GitHeaderInfo | undefined };
  gitStatusProvider.getStatus().then((info) => {
    lastGitInfoRef.value = info;
    requestRender();
  }).catch(() => { /* non-fatal */ });
  // FIX 2: the header's git segment otherwise only refreshes on
  // TURN_COMPLETED/TOOL_SUCCEEDED/TOOL_FAILED (see turn-event-wiring.ts's
  // refreshGit()) — if the user runs `git init` externally and never submits
  // another turn, the header stays stuck on the startup-time fallback
  // indefinitely. Poll at the same 5s cadence GitPanel already uses for its
  // own self-poll (git-panel.ts) so the two mechanisms are cadence-consistent.
  gitStatusProvider.startPolling(5_000, (info) => {
    lastGitInfoRef.value = info;
    requestRender();
  });

  const saveHistory = configManager.get('behavior.saveHistory') as boolean;
  const inputHistory = new InputHistory({
    historyPath: services.shellPaths.resolveUserPath('tui', 'input-history.json'),
    persist: saveHistory,
  });

  return {
    commandRegistry,
    commandContext,
    gitStatusProvider,
    lastGitInfoRef,
    inputHistory,
    systemMessageRouter,
  };
}
