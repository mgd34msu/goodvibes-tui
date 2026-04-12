import { getConfigSnapshot } from '../config/index.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { MutableRuntimeState } from './context.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '../permissions/prompt.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ForensicsRegistry } from './forensics/index.ts';
import type { PolicyRuntimeState } from './permissions/policy-runtime.ts';
import type { FileUndoManager } from '../state/file-undo.ts';
import { logger } from '../utils/logger.ts';
import type { McpRegistry } from '../mcp/registry.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import type { MemoryRegistry } from '../state/memory-store.ts';
import type { IntegrationHelperService } from './integration/helpers.ts';
import type { AutomationManager } from '../automation/index.ts';
import type { KnowledgeService } from '../knowledge/index.ts';
import type { AgentManager } from '../tools/agent/index.ts';
import type { ModeManager } from '../state/mode-manager.ts';
import type { RemoteRunnerRegistry, RemoteSupervisor } from './remote/index.ts';
import type { PluginManager } from '../plugins/manager.ts';
import type { HookWorkbench } from '../hooks/workbench.ts';
import type { PanelHealthMonitor } from './perf/panel-health-monitor.ts';
import type { WorktreeRegistry } from './worktree/registry.ts';
import type { SandboxSessionRegistry } from './sandbox/session-registry.ts';
import type { RuntimeEventBus } from './events/index.ts';

export type CreateBootstrapCommandContextOptions = {
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  conversation: ConversationManager;
  runtime: MutableRuntimeState;
  requestRender: () => void;
  keybindingsManager?: KeybindingsManager;
  requestPermission: PermissionRequestHandler;
  toolRegistry: ToolRegistry;
  mcpRegistry: McpRegistry;
  forensicsRegistry: ForensicsRegistry;
  policyRuntimeState: PolicyRuntimeState;
  runtimeStore: RuntimeStore;
  runtimeBus?: RuntimeEventBus;
  fileUndoManager: FileUndoManager;
  memoryRegistry?: MemoryRegistry;
  integrationHelpers?: IntegrationHelperService;
  automationManager?: AutomationManager;
  knowledgeService?: KnowledgeService;
  providerOptimizer?: import('../providers/optimizer.ts').ProviderOptimizer;
  pluginManager?: PluginManager;
  hookWorkbench?: HookWorkbench;
  agentManager?: AgentManager;
  modeManager?: ModeManager;
  remoteRunnerRegistry?: RemoteRunnerRegistry;
  remoteSupervisor?: RemoteSupervisor;
  sessionManager?: import('../sessions/manager.ts').SessionManager;
  profileManager?: import('../profiles/manager.ts').ProfileManager;
  bookmarkManager?: import('../bookmarks/manager.ts').BookmarkManager;
  favoritesStore?: import('../providers/favorites.ts').FavoritesStore;
  benchmarkStore?: import('../providers/model-benchmarks.ts').BenchmarkStore;
  subscriptionManager?: import('../config/subscriptions.ts').SubscriptionManager;
  secretsManager?: import('../config/secrets.ts').SecretsManager;
  serviceRegistry?: import('../config/service-registry.ts').ServiceRegistry;
  localUserAuthManager?: import('../security/user-auth.ts').UserAuthManager;
  tokenAuditor?: import('../security/token-audit.ts').ApiTokenAuditor;
  replayEngine?: import('../core/deterministic-replay.ts').DeterministicReplayEngine;
  webhookNotifier?: import('../integrations/webhooks.ts').WebhookNotifier;
  sessionMemoryStore?: import('../core/session-memory.ts').SessionMemoryStore;
  changeTracker?: import('../sessions/change-tracker.ts').SessionChangeTracker;
  planManager?: import('../core/execution-plan.ts').ExecutionPlanManager;
  adaptivePlanner?: import('../core/adaptive-planner.ts').AdaptivePlanner;
  sessionOrchestration?: import('../sessions/orchestration/index.ts').CrossSessionTaskRegistry;
  panelManager: PanelManager;
  panelHealthMonitor: PanelHealthMonitor;
  worktreeRegistry: WorktreeRegistry;
  sandboxSessionRegistry: SandboxSessionRegistry;
  loadSystemPrompt: () => string;
  activatePlan: (planId: string, task: string) => void;
  completeModelSelectionSideEffect?: () => void;
  sessionLineageTracker?: import('../core/session-lineage.ts').SessionLineageTracker;
};

function unwiredShellAction(name: string): never {
  const message = `commandContext.${name} was called before the shell bridge was attached in main.ts`;
  logger.error(message);
  throw new Error(message);
}

export function createBootstrapCommandContext(
  options: CreateBootstrapCommandContextOptions,
): CommandContext {
  const {
    providerRegistry,
    configManager,
    conversation,
    runtime,
    requestRender,
    keybindingsManager,
    requestPermission,
    toolRegistry,
    mcpRegistry,
    forensicsRegistry,
    policyRuntimeState,
    runtimeStore,
    runtimeBus,
    fileUndoManager,
    memoryRegistry,
    integrationHelpers,
    automationManager,
    knowledgeService,
    providerOptimizer,
    pluginManager,
    hookWorkbench,
    agentManager,
    modeManager,
    remoteRunnerRegistry,
    remoteSupervisor,
    sessionManager,
    profileManager,
    bookmarkManager,
    favoritesStore,
    benchmarkStore,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
    sessionMemoryStore,
    sessionLineageTracker,
    changeTracker,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    panelManager,
    panelHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
    loadSystemPrompt,
    activatePlan,
    completeModelSelectionSideEffect,
  } = options;

  const showPanel = (panelId: string, pane?: 'top' | 'bottom') => {
    panelManager.open(panelId, pane);
    panelManager.show();
    requestRender();
  };

  const context: CommandContext = {
    providerRegistry,
    conversationManager: conversation,
    config: getConfigSnapshot(configManager),
    configManager,
    keybindingsManager,
    runtime,
    renderRequest: requestRender,
    submitInput: () => {
      unwiredShellAction('submitInput');
    },
    executeCommand: async () => {
      return unwiredShellAction('executeCommand');
    },
    cancelGeneration: () => {
      unwiredShellAction('cancelGeneration');
    },
    clearScreen: () => {
      unwiredShellAction('clearScreen');
    },
    activatePlan,
    requestPermission: (request) => requestPermission(request),
    completeModelSelection: ({ model, effort, contextCap }) => {
      if (!model) return;
      const def = model;
      const key = def.registryKey ?? `${def.provider}:${def.id}`;
      try {
        if (contextCap != null && contextCap > 0) {
          providerRegistry.setModelContextCap(key, contextCap);
        }
        providerRegistry.setCurrentModel(key);
        runtime.model = key;
        runtime.provider = def.provider;
        runtime.reasoningEffort = effort as 'instant' | 'low' | 'medium' | 'high';
        configManager.set('provider.model', key);
        configManager.set('provider.provider', def.provider);
        configManager.set('provider.reasoningEffort', effort as 'instant' | 'low' | 'medium' | 'high');
        const ctxNote = contextCap != null && contextCap > 0
          ? `, context cap: ${contextCap.toLocaleString()}`
          : '';
        conversation.log(`Switched to model: ${def.displayName} (${def.provider}), effort: ${effort}${ctxNote}`, { fg: '135' });
      } catch (e) {
        conversation.log(`Error switching model: ${(e as Error).message}`, { fg: '#ef4444' });
      }
      completeModelSelectionSideEffect?.();
      requestRender();
    },
    jumpToBookmark: () => {
      unwiredShellAction('jumpToBookmark');
    },
    scrollToLine: () => {
      unwiredShellAction('scrollToLine');
    },
    print: (text: string) => {
      conversation.log(text, { fg: '252' });
      requestRender();
    },
    exit: () => {
      unwiredShellAction('exit');
    },
    reloadSystemPrompt: loadSystemPrompt,
    showPanel,
    panelManager,
    toolRegistry,
    mcpRegistry,
    fileUndoManager,
    forensicsRegistry,
    policyRegistry: policyRuntimeState.getRegistry(),
    policyRuntimeState,
    openForensicsPanel: () => {
      (context.showPanel ?? showPanel)('forensics');
    },
    openIncidentPanel: () => {
      (context.showPanel ?? showPanel)('incident');
    },
    openPolicyPanel: () => {
      (context.showPanel ?? showPanel)('policy');
    },
    openHooksPanel: () => {
      (context.showPanel ?? showPanel)('hooks');
    },
    openCommunicationPanel: () => {
      (context.showPanel ?? showPanel)('communication');
    },
    openOrchestrationPanel: () => {
      (context.showPanel ?? showPanel)('orchestration');
    },
    openCockpitPanel: () => {
      (context.showPanel ?? showPanel)('cockpit');
    },
    openMcpPanel: () => {
      (context.showPanel ?? showPanel)('mcp');
    },
    openSecurityPanel: () => {
      (context.showPanel ?? showPanel)('security');
    },
    openKnowledgePanel: () => {
      (context.showPanel ?? showPanel)('knowledge');
    },
    openRemotePanel: () => {
      (context.showPanel ?? showPanel)('remote');
    },
    openSubscriptionPanel: () => {
      (context.showPanel ?? showPanel)('subscription');
    },
    runtimeStore,
    runtimeBus,
    memoryRegistry,
    integrationHelpers,
    automationManager,
    knowledgeService,
    providerOptimizer,
    pluginManager,
    hookWorkbench,
    agentManager,
    modeManager,
    remoteRunnerRegistry,
    remoteSupervisor,
    sessionManager,
    profileManager,
    bookmarkManager,
    favoritesStore,
    benchmarkStore,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
    sessionMemoryStore,
    sessionLineageTracker,
    changeTracker,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    panelHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
  };

  return context;
}
