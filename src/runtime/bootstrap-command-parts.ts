import { getConfigSnapshot } from '../config/index.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { AdaptivePlanner } from '../core/adaptive-planner.ts';
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
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
  RemoteCommandService,
  PlanRuntimeService,
} from './shell-command-ops.ts';
import type { BootstrapCommandShellServices } from './shell-command-services.ts';
import type { OperatorClient } from './operator-client.ts';
import type { PeerClient } from './peer-client.ts';
import type { DirectTransport } from './transports/direct.ts';

export type BootstrapCommandSessionSection = CommandContext['session'];
export type BootstrapCommandProviderSection = CommandContext['provider'];
export type BootstrapCommandWorkspaceSection = CommandContext['workspace'];
export type BootstrapCommandPlatformSection = CommandContext['platform'];
export type BootstrapCommandOpsSection = CommandContext['ops'];
export type BootstrapCommandExtensionSection = CommandContext['extensions'];
export type BootstrapCommandClientSection = NonNullable<CommandContext['clients']>;

export interface BootstrapCommandActionOptions {
  readonly providerRegistry: ProviderRegistry;
  readonly configManager: ConfigManager;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly requestRender: () => void;
  readonly panelManager: PanelManager;
  readonly loadSystemPrompt: () => string;
  readonly activatePlan: (planId: string, task: string) => void;
  readonly requestPermission: PermissionRequestHandler;
  readonly completeModelSelectionSideEffect?: () => void;
}

export interface BootstrapCommandSectionOptions {
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  readonly conversation: ConversationManager;
  readonly runtime: MutableRuntimeState;
  readonly keybindingsManager?: KeybindingsManager;
  readonly panelManager: PanelManager;
  readonly requestRender: () => void;
  readonly requestPermission: PermissionRequestHandler;
  readonly toolRegistry: ToolRegistry;
  readonly mcpRegistry: McpRegistry;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly readModels: UiReadModels;
  readonly shellPaths: ShellPathService;
  readonly fileUndoManager: FileUndoManager;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
  readonly providerOptimizer?: import('../providers/optimizer.ts').ProviderOptimizer;
  readonly sessionManager?: import('../sessions/manager.ts').SessionManager;
  readonly profileManager?: import('../profiles/manager.ts').ProfileManager;
  readonly bookmarkManager?: import('../bookmarks/manager.ts').BookmarkManager;
  readonly favoritesStore?: import('../providers/favorites.ts').FavoritesStore;
  readonly benchmarkStore?: import('../providers/model-benchmarks.ts').BenchmarkStore;
  readonly subscriptionManager?: import('../config/subscriptions.ts').SubscriptionManager;
  readonly secretsManager?: import('../config/secrets.ts').SecretsManager;
  readonly serviceRegistry?: import('../config/service-registry.ts').ServiceRegistry;
  readonly localUserAuthManager?: import('../security/user-auth.ts').UserAuthManager;
  readonly tokenAuditor?: import('../security/token-audit.ts').ApiTokenAuditor;
  readonly replayEngine?: import('../core/deterministic-replay.ts').DeterministicReplayEngine;
  readonly webhookNotifier?: import('../integrations/webhooks.ts').WebhookNotifier;
  readonly sessionMemoryStore?: import('../core/session-memory.ts').SessionMemoryStore;
  readonly sessionLineageTracker?: import('../core/session-lineage.ts').SessionLineageTracker;
  readonly changeTracker?: import('../sessions/change-tracker.ts').SessionChangeTracker;
  readonly agentManager?: ShellAgentManagerService;
  readonly modeManager?: ShellModeManagerService;
  readonly automationManager?: ShellAutomationManagerRuntimeService;
  readonly planManager?: ShellPlanManagerService;
  readonly adaptivePlanner?: AdaptivePlanner;
  readonly sessionOrchestration?: ShellSessionOrchestrationService;
  readonly remoteRuntime?: RemoteCommandService;
  readonly planRuntime?: PlanRuntimeService;
  readonly operatorClient?: OperatorClient;
  readonly peerClient?: PeerClient;
  readonly providerApi?: ProviderApi;
  readonly knowledgeApi?: KnowledgeApi;
  readonly hookApi?: HookApi;
  readonly mcpApi?: McpApi;
  readonly opsApi?: OpsApi;
  readonly directTransport?: DirectTransport;
  readonly panelHealthMonitor: PanelHealthMonitor;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
}

function unwiredShellAction(name: string): never {
  throw new Error(`commandContext.${name} was called before the shell bridge was attached in main.ts`);
}

export function createBootstrapCommandActions(
  options: BootstrapCommandActionOptions,
): Pick<
  CommandContext,
  | 'renderRequest'
  | 'submitInput'
  | 'executeCommand'
  | 'cancelGeneration'
  | 'clearScreen'
  | 'activatePlan'
  | 'requestPermission'
  | 'completeModelSelection'
  | 'jumpToBookmark'
  | 'scrollToLine'
  | 'print'
  | 'exit'
  | 'reloadSystemPrompt'
  | 'showPanel'
  | 'openForensicsPanel'
  | 'openIncidentPanel'
  | 'openPolicyPanel'
  | 'openHooksPanel'
  | 'openCommunicationPanel'
  | 'openOrchestrationPanel'
  | 'openCockpitPanel'
  | 'openMcpPanel'
  | 'openSecurityPanel'
  | 'openKnowledgePanel'
  | 'openRemotePanel'
  | 'openSubscriptionPanel'
> {
  const {
    providerRegistry,
    configManager,
    conversation,
    runtime,
    requestRender,
    panelManager,
    loadSystemPrompt,
    activatePlan,
    requestPermission,
    completeModelSelectionSideEffect,
  } = options;

  const showPanel = (panelId: string, pane?: 'top' | 'bottom') => {
    panelManager.open(panelId, pane);
    panelManager.show();
    requestRender();
  };

  return {
    renderRequest: requestRender,
    submitInput: () => unwiredShellAction('submitInput'),
    executeCommand: async () => unwiredShellAction('executeCommand'),
    cancelGeneration: () => unwiredShellAction('cancelGeneration'),
    clearScreen: () => unwiredShellAction('clearScreen'),
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
    jumpToBookmark: () => unwiredShellAction('jumpToBookmark'),
    scrollToLine: () => unwiredShellAction('scrollToLine'),
    print: (text: string) => {
      conversation.log(text, { fg: '252' });
      requestRender();
    },
    exit: () => unwiredShellAction('exit'),
    reloadSystemPrompt: loadSystemPrompt,
    showPanel,
    openForensicsPanel: () => {
      showPanel('forensics');
    },
    openIncidentPanel: () => {
      showPanel('incident');
    },
    openPolicyPanel: () => {
      showPanel('policy');
    },
    openHooksPanel: () => {
      showPanel('hooks');
    },
    openCommunicationPanel: () => {
      showPanel('communication');
    },
    openOrchestrationPanel: () => {
      showPanel('orchestration');
    },
    openCockpitPanel: () => {
      showPanel('cockpit');
    },
    openMcpPanel: () => {
      showPanel('mcp');
    },
    openSecurityPanel: () => {
      showPanel('security');
    },
    openKnowledgePanel: () => {
      showPanel('knowledge');
    },
    openRemotePanel: () => {
      showPanel('remote');
    },
    openSubscriptionPanel: () => {
      showPanel('subscription');
    },
  };
}

export function createBootstrapCommandSessionSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'conversation' | 'runtime' | 'sessionManager' | 'sessionMemoryStore' | 'sessionLineageTracker' | 'changeTracker'
  >,
): BootstrapCommandSessionSection {
  return {
    conversationManager: options.conversation,
    runtime: options.runtime,
    sessionManager: options.sessionManager,
    sessionMemoryStore: options.sessionMemoryStore,
    sessionLineageTracker: options.sessionLineageTracker,
    changeTracker: options.changeTracker,
  };
}

export function createBootstrapCommandProviderSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'providerRegistry' | 'providerOptimizer' | 'favoritesStore' | 'benchmarkStore'
  >,
): BootstrapCommandProviderSection {
  return {
    providerRegistry: options.providerRegistry,
    providerOptimizer: options.providerOptimizer,
    favoritesStore: options.favoritesStore,
    benchmarkStore: options.benchmarkStore,
  };
}

export function createBootstrapCommandWorkspaceSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'keybindingsManager' | 'fileUndoManager' | 'panelManager' | 'profileManager' | 'bookmarkManager'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandWorkspaceSection {
  return {
    keybindingsManager: options.keybindingsManager,
    fileUndoManager: options.fileUndoManager,
    panelManager: options.panelManager,
    profileManager: options.profileManager,
    bookmarkManager: options.bookmarkManager,
    ...shellServices.workspace,
  };
}

export function createBootstrapCommandPlatformSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'configManager'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandPlatformSection {
  return {
    config: getConfigSnapshot(options.configManager),
    configManager: options.configManager,
    ...shellServices.platform,
  };
}

export function createBootstrapCommandOpsSection(
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandOpsSection {
  return shellServices.ops;
}

export function createBootstrapCommandExtensionsSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'toolRegistry' | 'mcpRegistry'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandExtensionSection {
  return {
    toolRegistry: options.toolRegistry,
    mcpRegistry: options.mcpRegistry,
    ...shellServices.extensions,
  };
}

export function createBootstrapCommandClientsSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'operatorClient' | 'peerClient' | 'providerApi' | 'knowledgeApi' | 'hookApi' | 'mcpApi' | 'opsApi' | 'directTransport'
  >,
): BootstrapCommandClientSection {
  return {
    operator: options.operatorClient,
    peer: options.peerClient,
    providerApi: options.providerApi,
    knowledgeApi: options.knowledgeApi,
    hookApi: options.hookApi,
    mcpApi: options.mcpApi,
    opsApi: options.opsApi,
    transport: options.directTransport,
  };
}
