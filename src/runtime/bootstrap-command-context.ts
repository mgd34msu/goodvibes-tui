import { getConfigSnapshot } from '../config/index.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { KnowledgeApi } from '../knowledge/knowledge-api.ts';
import type { HookApi } from '../hooks/hook-api.ts';
import type { McpApi } from '../mcp/mcp-api.ts';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderApi } from '../providers/provider-api.ts';
import type { OpsApi } from './ops-api.ts';
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
import type { MemoryRegistry } from '../state/memory-store.ts';
import type { IntegrationHelperService } from './integration/helpers.ts';
import type { KnowledgeService } from '../knowledge/index.ts';
import type { PluginManager } from '../plugins/manager.ts';
import type { HookWorkbench } from '../hooks/workbench.ts';
import type { PanelHealthMonitor } from './perf/panel-health-monitor.ts';
import type { WorktreeRegistry } from './worktree/registry.ts';
import type { SandboxSessionRegistry } from './sandbox/session-registry.ts';
import type { UiReadModels } from './ui-read-models.ts';
import type { ShellPathService } from './shell-paths.ts';
import type {
  ShellAgentManagerService,
  ShellAutomationManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
} from './shell-command-services.ts';
import {
  createBootstrapCommandShellServices,
  type PlanRuntimeService,
  type RemoteCommandService,
} from './shell-command-services.ts';
import type { OperatorClient } from './operator-client.ts';
import type { PeerClient } from './peer-client.ts';
import type { DirectTransport } from './transports/direct.ts';

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
  readModels: UiReadModels;
  shellPaths: ShellPathService;
  remoteRuntime?: RemoteCommandService;
  planRuntime?: PlanRuntimeService;
  fileUndoManager: FileUndoManager;
  memoryRegistry?: MemoryRegistry;
  integrationHelpers?: IntegrationHelperService;
  automationManager?: ShellAutomationManagerRuntimeService;
  knowledgeService?: KnowledgeService;
  providerOptimizer?: import('../providers/optimizer.ts').ProviderOptimizer;
  pluginManager?: PluginManager;
  hookWorkbench?: HookWorkbench;
  agentManager?: ShellAgentManagerService;
  modeManager?: ShellModeManagerService;
  sessionManager?: import('../sessions/manager.ts').SessionManager;
  profileManager?: import('../profiles/manager.ts').ProfileManager;
  bookmarkManager?: import('../bookmarks/manager.ts').BookmarkManager;
  favoritesStore?: import('../providers/favorites.ts').FavoritesStore;
  benchmarkStore?: import('../providers/model-benchmarks.ts').BenchmarkStore;
  providerApi?: ProviderApi;
  subscriptionManager?: import('../config/subscriptions.ts').SubscriptionManager;
  secretsManager?: import('../config/secrets.ts').SecretsManager;
  serviceRegistry?: import('../config/service-registry.ts').ServiceRegistry;
  localUserAuthManager?: import('../security/user-auth.ts').UserAuthManager;
  tokenAuditor?: import('../security/token-audit.ts').ApiTokenAuditor;
  replayEngine?: import('../core/deterministic-replay.ts').DeterministicReplayEngine;
  webhookNotifier?: import('../integrations/webhooks.ts').WebhookNotifier;
  sessionMemoryStore?: import('../core/session-memory.ts').SessionMemoryStore;
  changeTracker?: import('../sessions/change-tracker.ts').SessionChangeTracker;
  planManager?: ShellPlanManagerService;
  adaptivePlanner?: unknown;
  sessionOrchestration?: ShellSessionOrchestrationService;
  operatorClient?: OperatorClient;
  peerClient?: PeerClient;
  knowledgeApi?: KnowledgeApi;
  hookApi?: HookApi;
  mcpApi?: McpApi;
  opsApi?: OpsApi;
  directTransport?: DirectTransport;
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
    readModels,
    shellPaths,
    remoteRuntime,
    planRuntime,
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
    sessionManager,
    profileManager,
    bookmarkManager,
    favoritesStore,
    benchmarkStore,
    providerApi,
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
    operatorClient,
    peerClient,
    knowledgeApi,
    hookApi,
    mcpApi,
    opsApi,
    directTransport,
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

  let context: CommandContext;
  const shellServices = createBootstrapCommandShellServices({
    agentManager,
    automationManager,
    modeManager,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    shellPaths,
    panelHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
    readModels,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
    remoteRuntime,
    planRuntime,
    forensicsRegistry,
    policyRuntimeState,
    memoryRegistry,
    integrationHelpers,
    knowledgeService,
    pluginManager,
    hookWorkbench,
  });
  const workspace = {
    keybindingsManager,
    fileUndoManager,
    panelManager,
    profileManager,
    bookmarkManager,
    ...shellServices.workspace,
  };
  const session = {
    conversationManager: conversation,
    runtime,
    sessionManager,
    sessionMemoryStore,
    sessionLineageTracker,
    changeTracker,
  };
  const provider = {
    providerRegistry,
    providerOptimizer,
    favoritesStore,
    benchmarkStore,
  };
  const platform = {
    config: getConfigSnapshot(configManager),
    configManager,
    ...shellServices.platform,
  };
  const extensions = {
    toolRegistry,
    mcpRegistry,
    ...shellServices.extensions,
  };
  context = {
    session,
    provider,
    workspace,
    platform,
    ops: shellServices.ops,
    extensions,
    clients: {
      operator: operatorClient,
      peer: peerClient,
      providerApi,
      knowledgeApi,
      hookApi,
      mcpApi,
      opsApi,
      transport: directTransport,
    },
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
  };

  return context;
}
