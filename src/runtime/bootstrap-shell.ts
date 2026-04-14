import type { ConversationManager } from '../core/conversation.ts';
import type { Orchestrator } from '../core/orchestrator.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { RuntimeEventBus } from './events/index.ts';
import type { RuntimeStore } from './store/index.ts';
import type { RuntimeServices } from './services.ts';
import type { MutableRuntimeState } from './context.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { OpsControlPlane } from './ops/control-plane.ts';
import { CommandRegistry } from '../input/command-registry.ts';
import { registerBuiltinCommands } from '../input/commands.ts';
import { InputHistory } from '../input/input-history.ts';
import { GitStatusProvider } from '../renderer/git-status.ts';
import type { GitHeaderInfo } from '../renderer/git-status.ts';
import type { PermissionRequestHandler } from '../permissions/prompt.ts';
import { registerBuiltinPanels } from '../panels/builtin-panels.ts';
import { SystemMessagesPanel } from '../panels/system-messages-panel.ts';
import { createSystemMessageRouter, type SystemMessageRouter } from '../core/system-message-router.ts';
import { getConfigSnapshot } from '../config/index.ts';
import { createBootstrapCommandContext } from './bootstrap-command-context.ts';
import { createResumeSessionHandler } from './bootstrap-hook-bridge.ts';
import { logger } from '../utils/logger.ts';
import { loadBootstrapSystemPrompt } from './bootstrap-helpers.ts';
import { createShellPlanRuntime, createShellRemoteCommandService } from './shell-command-services.ts';
import { createRuntimeFoundationClients } from './foundation-clients.ts';
import type { ControlPlaneRecentEvent } from '../control-plane/gateway.ts';
import type { BuiltinPanelDeps } from '../panels/builtin/shared.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ForensicsRegistry } from './forensics/index.ts';
import type { PolicyRuntimeState } from './permissions/policy-runtime.ts';
import type { TaskManager } from './tasks/types.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { summarizeError } from '../utils/error-display.ts';

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

  const systemMessagesPanel = new SystemMessagesPanel(configManager, services.panelHealthMonitor);
  const resumeSession = createResumeSessionHandler({
    runtimeBus,
    runtime,
    conversation,
    requestRender,
    onSessionIdChanged,
    sharedSessionBroker: services.sessionBroker,
    writeLastSessionPointer,
    hookDispatcher: services.hookDispatcher,
    sessionManager: services.sessionManager,
    panelManager: services.panelManager,
    configManager,
    providerRegistry: services.providerRegistry,
  });

  registerBuiltinPanels(services.panelManager, {
    configManager,
    getOrchestratorUsage: () => orchestrator.usage as { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string },
    toolRegistry,
    providerRegistry: services.providerRegistry,
    contextWindow: services.providerRegistry.getContextWindowForModel(services.providerRegistry.getCurrentModel()),
    orchestrator,
    getCtxWindow: () => services.providerRegistry.getContextWindowForModel(services.providerRegistry.getCurrentModel()),
    resumeSession,
    requestRender,
    forensicsRegistry,
    policyRuntimeState,
    approvalBroker: services.approvalBroker,
    sessionBroker: services.sessionBroker,
    automationManager: services.automationManager,
    getControlPlaneRecentEvents,
    tokenAuditor: services.tokenAuditor,
    panelHealthMonitor: services.panelHealthMonitor,
    worktreeRegistry: services.worktreeRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    systemMessagesPanel,
    memoryRegistry: services.memoryRegistry,
    uiServices,
    pluginManager: services.pluginManager,
    hookDispatcher: services.hookDispatcher,
    hookActivityTracker: services.hookActivityTracker,
    hookWorkbench: services.hookWorkbench,
    mcpRegistry: services.mcpRegistry,
  });
  services.panelManager.prewarmRegistered();

  const systemMessageRouter = createSystemMessageRouter(
    conversation,
    systemMessagesPanel,
    (kind) => {
      const ui = getConfigSnapshot(configManager).ui;
      if (kind === 'wrfc') return ui.wrfcMessages;
      if (kind === 'operational') return ui.operationalMessages;
      return ui.systemMessages;
    },
  );
  orchestrator.setSystemMessageRouter(systemMessageRouter);

  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry);
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
  const remoteRuntime = createShellRemoteCommandService({
    readModels: uiServices.readModels,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    runtimeStore,
  });
  const planRuntime = createShellPlanRuntime({
    adaptivePlanner: services.adaptivePlanner,
    runtimeBus,
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
    forensicsRegistry,
    policyRuntimeState,
    readModels: uiServices.readModels,
    shellPaths: services.shellPaths,
    remoteRuntime,
    planRuntime,
    fileUndoManager: services.fileUndoManager,
    memoryRegistry: services.memoryRegistry,
    integrationHelpers: services.integrationHelpers,
    automationManager: services.automationManager,
    knowledgeService: services.knowledgeService,
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
    changeTracker: services.sessionChangeTracker,
    planManager: services.planManager,
    adaptivePlanner: services.adaptivePlanner,
    sessionOrchestration: services.sessionOrchestration,
    operatorClient: directTransport.operator,
    peerClient: directTransport.peer,
    knowledgeApi,
    hookApi,
    mcpApi,
    opsApi,
    directTransport,
    panelManager: services.panelManager,
    panelHealthMonitor: services.panelHealthMonitor,
    worktreeRegistry: services.worktreeRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    loadSystemPrompt: () => loadBootstrapSystemPrompt(configManager),
    activatePlan: (_planId, task) => {
      setTimeout(() => {
        orchestrator.handleUserInput(task).catch((err) => {
          logger.debug('activatePlan handler failed', { error: summarizeError(err) });
        });
      }, 50);
    },
    completeModelSelectionSideEffect,
  });

  const gitStatusProvider = new GitStatusProvider(services.workingDirectory);
  const lastGitInfoRef = { value: undefined as GitHeaderInfo | undefined };
  gitStatusProvider.getStatus().then((info) => {
    lastGitInfoRef.value = info;
    requestRender();
  }).catch(() => { /* non-fatal */ });

  const saveHistory = configManager.get('behavior.saveHistory') as boolean;
  const inputHistory = new InputHistory({
    historyPath: services.shellPaths.resolveUserTuiPath('input-history.json'),
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
