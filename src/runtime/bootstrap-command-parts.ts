import { getConfigSnapshot } from '../config/index.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { MemorySpineClient } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { HookApi } from '@pellux/goodvibes-sdk/platform/hooks';
import type { McpApi } from '@pellux/goodvibes-sdk/platform/mcp';
import type { PanelManager, PanelDeepLinkTarget } from '../panels/panel-manager.ts';
import type { ProviderApi } from '@pellux/goodvibes-sdk/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { CodeIndexStore, FileUndoManager } from '@pellux/goodvibes-sdk/platform/state';
import type { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { IntegrationHelperService } from '@/runtime/index.ts';
import type { KnowledgeService } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins';
import type { HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import type { WorktreeRegistry } from '@/runtime/index.ts';
import type { SandboxSessionRegistry } from '@/runtime/index.ts';
import type { UiReadModels } from './ui-read-models.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import type {
  ShellAgentManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
  RemoteCommandService,
  PlanRuntimeService,
} from '@/runtime/index.ts';
import type { BootstrapCommandShellServices } from '@/runtime/index.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import type { DirectTransport } from '@/runtime/index.ts';
import type { VoiceProviderRegistry, VoiceService } from '@pellux/goodvibes-sdk/platform/voice';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { LocalAuthPanel } from '../panels/local-auth-panel.ts';

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
  readonly localUserAuthManager?: import('@pellux/goodvibes-sdk/platform/security').UserAuthManager;
}

export interface BootstrapCommandSectionOptions {
  readonly configManager: ConfigManager;
  readonly featureFlagManager?: FeatureFlagManager;
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
  /** B31: direct-command consumers (`/search`, `/image`) of already-constructed RuntimeServices. */
  readonly webSearchService?: import('@pellux/goodvibes-sdk/platform/web-search').WebSearchService;
  readonly mediaProviders?: import('@pellux/goodvibes-sdk/platform/media').MediaProviderRegistry;
  readonly artifactStore?: import('@pellux/goodvibes-sdk/platform/artifacts').ArtifactStore;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly readModels: UiReadModels;
  readonly shellPaths: ShellPathService;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager?: WorkspaceCheckpointManager;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly projectPlanningService?: import('@pellux/goodvibes-sdk/platform/knowledge').ProjectPlanningService;
  readonly projectPlanningProjectId?: string;
  readonly workPlanStore?: import('../work-plans/work-plan-store.ts').WorkPlanStore;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
  readonly providerOptimizer?: import('@pellux/goodvibes-sdk/platform/providers').ProviderOptimizer;
  readonly sessionManager?: import('@pellux/goodvibes-sdk/platform/sessions').SessionManager;
  readonly profileManager?: import('@pellux/goodvibes-sdk/platform/profiles').ProfileManager;
  readonly bookmarkManager?: import('@pellux/goodvibes-sdk/platform/bookmarks').BookmarkManager;
  readonly favoritesStore?: import('@pellux/goodvibes-sdk/platform/providers').FavoritesStore;
  readonly benchmarkStore?: import('@pellux/goodvibes-sdk/platform/providers').BenchmarkStore;
  readonly subscriptionManager?: import('@pellux/goodvibes-sdk/platform/config').SubscriptionManager;
  readonly secretsManager?: import('../config/secrets.ts').SecretsManager;
  readonly serviceRegistry?: import('@pellux/goodvibes-sdk/platform/config').ServiceRegistry;
  readonly localUserAuthManager?: import('@pellux/goodvibes-sdk/platform/security').UserAuthManager;
  readonly tokenAuditor?: import('@pellux/goodvibes-sdk/platform/security').ApiTokenAuditor;
  readonly replayEngine?: import('@pellux/goodvibes-sdk/platform/core').DeterministicReplayEngine;
  readonly webhookNotifier?: import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier;
  readonly sessionMemoryStore?: import('@pellux/goodvibes-sdk/platform/core').SessionMemoryStore;
  readonly sessionLineageTracker?: import('@pellux/goodvibes-sdk/platform/core').SessionLineageTracker;
  readonly wrfcController?: import('@pellux/goodvibes-sdk/platform/agents').WrfcController;
  readonly changeTracker?: import('@pellux/goodvibes-sdk/platform/sessions').SessionChangeTracker;
  readonly hydrateSessionUsage?: () => void;
  readonly workstreamEngine?: import('./workstream-services.ts').WorkstreamCommandService;
  readonly codeIndexStore?: CodeIndexStore;
  readonly codeIndexReindexScheduler?: import('@pellux/goodvibes-sdk/platform/state').CodeIndexReindexScheduler;
  readonly isPassiveCodeInjectionFlagEnabled?: () => boolean;
  readonly getMainSessionTurnInjections?: () => readonly import('../renderer/turn-injection.ts').TurnInjectionEntry[];
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
  readonly memorySpine?: MemorySpineClient;
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
  | 'openMcpWorkspace'
  | 'openSecurityPanel'
  | 'openKnowledgePanel'
  | 'openMemoryPanel'
  | 'openRemotePanel'
  | 'openSubscriptionPanel'
  | 'openLocalAuthMaskedEntry'
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
    localUserAuthManager,
  } = options;

  const showPanel = (panelId: string, pane?: 'top' | 'bottom', target?: PanelDeepLinkTarget) => {
    // W6.1 (the purge): a MIGRATE-TO-MODAL id resolves to a modal, not a panel.
    // panelManager.open() fires the injected openModal callback and returns a
    // no-op sentinel — so skip panelManager.show() (which would reveal an empty
    // panel workspace behind the modal) when this id redirects. Keeps every
    // showPanel-based front-door (openHooksPanel/openSecurityPanel/… and the
    // migrated command runtimes) opening the modal cleanly.
    const redirected = panelManager.getModalRedirect(panelId) !== undefined;
    panelManager.open(panelId, pane, target);
    if (!redirected) panelManager.show();
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
        } else if (resolvedTarget === 'tts') {
          configManager.set('tts.llmProvider', def.provider);
          configManager.set('tts.llmModel', key);
          conversation.log(`TTS LLM set to: ${def.displayName} (${def.provider})`, { fg: '135' });
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
    openMcpWorkspace: () => unwiredShellAction('openMcpWorkspace'),
    openSecurityPanel: () => {
      showPanel('security');
    },
    openKnowledgePanel: () => {
      showPanel('knowledge');
    },
    openMemoryPanel: () => {
      showPanel('memory');
    },
    // W6.1: remote/subscription migrated to config-modal surfaces. open() hits
    // the modal redirect and invokes the openModal callback — do NOT go through
    // showPanel here, which would additionally reveal + focus an (empty) panel
    // workspace behind the fullscreen modal.
    openRemotePanel: () => {
      panelManager.open('remote');
    },
    openSubscriptionPanel: () => {
      panelManager.open('subscription');
    },
    openLocalAuthMaskedEntry: (kind, username) => {
      showPanel('local-auth');
      const panel = panelManager.getPanel('local-auth');
      if (panel instanceof LocalAuthPanel && localUserAuthManager) {
        panel.openMaskedEntry(kind, username, localUserAuthManager);
      } else {
        conversation.log('Masked entry unavailable: local auth is not configured in this session.', { fg: '#ef4444' });
        requestRender();
      }
    },
  };
}

export function createBootstrapCommandSessionSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'conversation' | 'runtime' | 'sessionManager' | 'sessionMemoryStore' | 'sessionLineageTracker' | 'wrfcController' | 'changeTracker' | 'hydrateSessionUsage' | 'workstreamEngine' | 'codeIndexStore' | 'codeIndexReindexScheduler' | 'isPassiveCodeInjectionFlagEnabled' | 'getMainSessionTurnInjections'
  >,
): BootstrapCommandSessionSection {
  return {
    conversationManager: options.conversation,
    runtime: options.runtime,
    sessionManager: options.sessionManager,
    sessionMemoryStore: options.sessionMemoryStore,
    sessionLineageTracker: options.sessionLineageTracker,
    wrfcController: options.wrfcController,
    changeTracker: options.changeTracker,
    hydrateSessionUsage: options.hydrateSessionUsage,
    workstreamEngine: options.workstreamEngine,
    codeIndexStore: options.codeIndexStore,
    codeIndexReindexScheduler: options.codeIndexReindexScheduler,
    isPassiveCodeInjectionFlagEnabled: options.isPassiveCodeInjectionFlagEnabled,
    getMainSessionTurnInjections: options.getMainSessionTurnInjections,
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
    'keybindingsManager' | 'fileUndoManager' | 'workspaceCheckpointManager' | 'panelManager' | 'profileManager' | 'bookmarkManager'
    | 'projectPlanningService' | 'projectPlanningProjectId' | 'workPlanStore'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandWorkspaceSection {
  return {
    keybindingsManager: options.keybindingsManager,
    fileUndoManager: options.fileUndoManager,
    workspaceCheckpointManager: options.workspaceCheckpointManager,
    panelManager: options.panelManager,
    profileManager: options.profileManager,
    bookmarkManager: options.bookmarkManager,
    projectPlanningService: options.projectPlanningService,
    projectPlanningProjectId: options.projectPlanningProjectId,
    workPlanStore: options.workPlanStore,
    ...shellServices.workspace,
  };
}

export function createBootstrapCommandPlatformSection(
  options: Pick<
    BootstrapCommandSectionOptions,
    'configManager' | 'featureFlagManager' | 'voiceProviderRegistry' | 'voiceService' | 'webSearchService' | 'mediaProviders' | 'artifactStore'
  >,
  shellServices: BootstrapCommandShellServices,
): BootstrapCommandPlatformSection {
  return {
    config: getConfigSnapshot(options.configManager),
    configManager: options.configManager,
    featureFlagManager: options.featureFlagManager,
    voiceProviderRegistry: options.voiceProviderRegistry,
    voiceService: options.voiceService,
    webSearchService: options.webSearchService,
    mediaProviders: options.mediaProviders,
    artifactStore: options.artifactStore,
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
    'operatorClient' | 'peerClient' | 'providerApi' | 'knowledgeApi' | 'memorySpine' | 'hookApi' | 'mcpApi' | 'opsApi' | 'directTransport'
  >,
): BootstrapCommandClientSection {
  return {
    operator: options.operatorClient,
    peer: options.peerClient,
    providerApi: options.providerApi,
    knowledgeApi: options.knowledgeApi,
    memorySpine: options.memorySpine,
    hookApi: options.hookApi,
    mcpApi: options.mcpApi,
    opsApi: options.opsApi,
    transport: options.directTransport,
  };
}
