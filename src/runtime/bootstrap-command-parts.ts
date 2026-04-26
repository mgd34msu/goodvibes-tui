import { getConfigSnapshot } from '../config/index.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge/knowledge-api';
import type { HookApi } from '@pellux/goodvibes-sdk/platform/hooks/hook-api';
import type { McpApi } from '@pellux/goodvibes-sdk/platform/mcp/mcp-api';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderApi } from '@pellux/goodvibes-sdk/platform/providers/provider-api';
import type { OpsApi } from '@pellux/goodvibes-sdk/platform/runtime/ops-api';
import type { MutableRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/mutable-runtime-state';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { CommandContext } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions/prompt';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import type { ForensicsRegistry } from '@pellux/goodvibes-sdk/platform/runtime/forensics/index';
import type { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';
import type { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state/file-undo';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp/registry';
import type { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/memory-store';
import type { IntegrationHelperService } from '@pellux/goodvibes-sdk/platform/runtime/integration/helpers';
import type { KnowledgeService } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import type { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins/manager';
import type { HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks/workbench';
import type { WorktreeRegistry } from '@pellux/goodvibes-sdk/platform/runtime/worktree/registry';
import type { SandboxSessionRegistry } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/session-registry';
import type { UiReadModels } from './ui-read-models.ts';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import type {
  ShellAgentManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
  RemoteCommandService,
  PlanRuntimeService,
} from '@pellux/goodvibes-sdk/platform/runtime/shell-command-ops';
import type { BootstrapCommandShellServices } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-services';
import type { OperatorClient } from '@pellux/goodvibes-sdk/platform/runtime/operator-client';
import type { PeerClient } from '@pellux/goodvibes-sdk/platform/runtime/peer-client';
import type { DirectTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct';
import type { VoiceProviderRegistry, VoiceService } from '@pellux/goodvibes-sdk/platform/voice/index';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

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
  readonly voiceProviderRegistry?: VoiceProviderRegistry;
  readonly voiceService?: VoiceService;
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
  readonly providerOptimizer?: import('@pellux/goodvibes-sdk/platform/providers/optimizer').ProviderOptimizer;
  readonly sessionManager?: import('@pellux/goodvibes-sdk/platform/sessions/manager').SessionManager;
  readonly profileManager?: import('@pellux/goodvibes-sdk/platform/profiles/manager').ProfileManager;
  readonly bookmarkManager?: import('@pellux/goodvibes-sdk/platform/bookmarks/manager').BookmarkManager;
  readonly favoritesStore?: import('@pellux/goodvibes-sdk/platform/providers/favorites').FavoritesStore;
  readonly benchmarkStore?: import('@pellux/goodvibes-sdk/platform/providers/model-benchmarks').BenchmarkStore;
  readonly subscriptionManager?: import('@pellux/goodvibes-sdk/platform/config/subscriptions').SubscriptionManager;
  readonly secretsManager?: import('../config/secrets.ts').SecretsManager;
  readonly serviceRegistry?: import('@pellux/goodvibes-sdk/platform/config/service-registry').ServiceRegistry;
  readonly localUserAuthManager?: import('@pellux/goodvibes-sdk/platform/security/user-auth').UserAuthManager;
  readonly tokenAuditor?: import('@pellux/goodvibes-sdk/platform/security/token-audit').ApiTokenAuditor;
  readonly replayEngine?: import('@pellux/goodvibes-sdk/platform/core/deterministic-replay').DeterministicReplayEngine;
  readonly webhookNotifier?: import('@pellux/goodvibes-sdk/platform/integrations/webhooks').WebhookNotifier;
  readonly sessionMemoryStore?: import('@pellux/goodvibes-sdk/platform/core/session-memory').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@pellux/goodvibes-sdk/platform/core/session-lineage').SessionLineageTracker;
  readonly changeTracker?: import('@pellux/goodvibes-sdk/platform/sessions/change-tracker').SessionChangeTracker;
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
    completeModelSelection: ({ model, effort, contextCap, target }) => {
      if (!model) return;
      const def = model;
      const key = def.registryKey ?? `${def.provider}:${def.id}`;
      const resolvedTarget = target ?? 'main';
      try {
        if (resolvedTarget === 'helper') {
          // Write to helper config keys and enable the helper
          configManager.set('helper.globalProvider', def.provider);
          configManager.set('helper.globalModel', key);
          configManager.set('helper.enabled', true);
          conversation.log(`Helper model set to: ${def.displayName} (${def.provider})`, { fg: '135' });
        } else if (resolvedTarget === 'tool') {
          // Write to tool LLM config keys and enable the tool LLM
          configManager.set('tools.llmProvider', def.provider);
          configManager.set('tools.llmModel', key);
          configManager.setDynamic('tools.llmEnabled' as never, true);
          conversation.log(`Tool LLM set to: ${def.displayName} (${def.provider})`, { fg: '135' });
        } else {
          // Default: main provider/model
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
        }
      } catch (e) {
        conversation.log(`Error switching model: ${summarizeError(e)}`, { fg: '#ef4444' });
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
    'configManager' | 'voiceProviderRegistry' | 'voiceService'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandPlatformSection {
  return {
    config: getConfigSnapshot(options.configManager),
    configManager: options.configManager,
    voiceProviderRegistry: options.voiceProviderRegistry,
    voiceService: options.voiceService,
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
