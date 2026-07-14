import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core';
import type { ConversationManager } from '../core/conversation';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { MemorySpineClient } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import type { HookApi } from '@pellux/goodvibes-sdk/platform/hooks';
import type { McpApi } from '@pellux/goodvibes-sdk/platform/mcp';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderApi } from '@pellux/goodvibes-sdk/platform/providers';
import type { OpsApi } from '@/runtime/index.ts';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { CommandContext } from '../input/command-registry.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import type { PermissionRequestHandler } from '@pellux/goodvibes-sdk/platform/permissions';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import type { PolicyRuntimeState } from '@/runtime/index.ts';
import type { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state';
import type { WorkspaceCheckpointManager } from '@pellux/goodvibes-sdk/platform/workspace';
import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { WorkspaceTrustManager } from './trust/workspace-trust.ts';
import type { WorkspaceRegistrationManager } from './trust/workspace-registration.ts';
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
} from '@/runtime/index.ts';
import { createBootstrapCommandShellServices, type PlanRuntimeService, type RemoteCommandService } from '@/runtime/index.ts';
import type { OperatorClient } from '@/runtime/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import type { DirectTransport } from '@/runtime/index.ts';
import type { VoiceProviderRegistry, VoiceService } from '@pellux/goodvibes-sdk/platform/voice';
import {
  createBootstrapCommandActions,
  createBootstrapCommandClientsSection,
  createBootstrapCommandExtensionsSection,
  createBootstrapCommandOpsSection,
  createBootstrapCommandPlatformSection,
  createBootstrapCommandProviderSection,
  createBootstrapCommandSessionSection,
  createBootstrapCommandWorkspaceSection,
} from './bootstrap-command-parts.ts';

export type CreateBootstrapCommandContextOptions = {
  configManager: ConfigManager;
  pairingTokens?: import('@pellux/goodvibes-sdk/platform/pairing').PairingTokenManager;
  featureFlagManager?: import('@/runtime/index.ts').FeatureFlagManager;
  providerRegistry: ProviderRegistry;
  conversation: ConversationManager;
  runtime: MutableRuntimeState;
  requestRender: () => void;
  keybindingsManager?: KeybindingsManager;
  requestPermission: PermissionRequestHandler;
  toolRegistry: ToolRegistry;
  mcpRegistry: McpRegistry;
  voiceProviderRegistry?: VoiceProviderRegistry;
  voiceService?: VoiceService;
  /** Direct-command consumers (`/search`, `/image`) of already-constructed RuntimeServices. */
  webSearchService?: import('@pellux/goodvibes-sdk/platform/web-search').WebSearchService;
  mediaProviders?: import('@pellux/goodvibes-sdk/platform/media').MediaProviderRegistry;
  artifactStore?: import('@pellux/goodvibes-sdk/platform/artifacts').ArtifactStore;
  forensicsRegistry: ForensicsRegistry;
  policyRuntimeState: PolicyRuntimeState;
  readModels: UiReadModels;
  shellPaths: ShellPathService;
  remoteRuntime?: RemoteCommandService;
  planRuntime?: PlanRuntimeService;
  fileUndoManager: FileUndoManager;
  workspaceCheckpointManager?: WorkspaceCheckpointManager;
  gatewayMethods?: GatewayMethodCatalog;
  workspaceTrustManager?: WorkspaceTrustManager;
  workspaceRegistrationManager?: WorkspaceRegistrationManager;
  memoryRegistry?: MemoryRegistry;
  integrationHelpers?: IntegrationHelperService;
  automationManager?: ShellAutomationManagerRuntimeService;
  knowledgeService?: KnowledgeService;
  projectPlanningService?: import('@pellux/goodvibes-sdk/platform/knowledge').ProjectPlanningService;
  projectPlanningProjectId?: string;
  workPlanStore?: import('../work-plans/work-plan-store.ts').WorkPlanStore;
  providerOptimizer?: import('@pellux/goodvibes-sdk/platform/providers').ProviderOptimizer;
  pluginManager?: PluginManager;
  hookWorkbench?: HookWorkbench;
  agentManager?: ShellAgentManagerService;
  modeManager?: ShellModeManagerService;
  sessionManager?: import('@pellux/goodvibes-sdk/platform/sessions').SessionManager;
  profileManager?: import('@pellux/goodvibes-sdk/platform/profiles').ProfileManager;
  bookmarkManager?: import('@pellux/goodvibes-sdk/platform/bookmarks').BookmarkManager;
  favoritesStore?: import('@pellux/goodvibes-sdk/platform/providers').FavoritesStore;
  benchmarkStore?: import('@pellux/goodvibes-sdk/platform/providers').BenchmarkStore;
  providerApi?: ProviderApi;
  subscriptionManager?: import('@pellux/goodvibes-sdk/platform/config').SubscriptionManager;
  secretsManager?: import('../config/secrets.ts').SecretsManager;
  serviceRegistry?: import('@pellux/goodvibes-sdk/platform/config').ServiceRegistry;
  localUserAuthManager?: import('@pellux/goodvibes-sdk/platform/security').UserAuthManager;
  tokenAuditor?: import('@pellux/goodvibes-sdk/platform/security').ApiTokenAuditor;
  replayEngine?: import('@pellux/goodvibes-sdk/platform/core').DeterministicReplayEngine;
  webhookNotifier?: import('@pellux/goodvibes-sdk/platform/integrations').WebhookNotifier;
  sessionMemoryStore?: import('@pellux/goodvibes-sdk/platform/core').SessionMemoryStore;
  changeTracker?: import('@pellux/goodvibes-sdk/platform/sessions').SessionChangeTracker;
  planManager?: ShellPlanManagerService;
  adaptivePlanner?: AdaptivePlanner;
  sessionOrchestration?: ShellSessionOrchestrationService;
  operatorClient?: OperatorClient;
  userPermissionRuleStore?: import('@pellux/goodvibes-sdk/platform/permissions').UserPermissionRuleStore;
  peerClient?: PeerClient;
  knowledgeApi?: KnowledgeApi;
  memorySpine?: MemorySpineClient;
  hookApi?: HookApi;
  mcpApi?: McpApi;
  opsApi?: OpsApi;
  directTransport?: DirectTransport;
  panelManager: PanelManager;
  worktreeRegistry: WorktreeRegistry;
  sandboxSessionRegistry: SandboxSessionRegistry;
  loadSystemPrompt: () => string;
  activatePlan: (planId: string, task: string) => void;
  completeModelSelectionSideEffect?: () => void;
  sessionLineageTracker?: import('@pellux/goodvibes-sdk/platform/core').SessionLineageTracker;
  wrfcController?: import('@pellux/goodvibes-sdk/platform/agents').WrfcController;
  componentHealthMonitor: import('@/runtime/index.ts').ComponentHealthMonitor;
  hydrateSessionUsage?: () => void;
  workstreamEngine?: import('./workstream-services.ts').WorkstreamCommandService;
  codeIndexStore?: import('@pellux/goodvibes-sdk/platform/state').CodeIndexStore;
  codeIndexReindexScheduler?: import('@pellux/goodvibes-sdk/platform/state').CodeIndexReindexScheduler;
  isPassiveCodeInjectionFlagEnabled?: () => boolean;
  getMainSessionTurnInjections?: () => readonly import('../renderer/turn-injection.ts').TurnInjectionEntry[];
};

export function createBootstrapCommandContext(
  options: CreateBootstrapCommandContextOptions,
): CommandContext {
  const {
    providerRegistry,
    configManager,
    pairingTokens,
    featureFlagManager,
    conversation,
    runtime,
    requestRender,
    keybindingsManager,
    requestPermission,
    toolRegistry,
    mcpRegistry,
    voiceProviderRegistry,
    voiceService,
    webSearchService,
    mediaProviders,
    artifactStore,
    forensicsRegistry,
    policyRuntimeState,
    readModels,
    shellPaths,
    remoteRuntime,
    planRuntime,
    fileUndoManager,
    workspaceCheckpointManager,
    gatewayMethods,
    workspaceTrustManager,
    workspaceRegistrationManager,
    memoryRegistry,
    integrationHelpers,
    automationManager,
    knowledgeService,
    projectPlanningService,
    projectPlanningProjectId,
    workPlanStore,
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
    wrfcController,
    changeTracker,
    hydrateSessionUsage,
    workstreamEngine,
    codeIndexStore,
    codeIndexReindexScheduler,
    isPassiveCodeInjectionFlagEnabled,
    getMainSessionTurnInjections,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    operatorClient,
    userPermissionRuleStore,
    peerClient,
    knowledgeApi,
    memorySpine,
    hookApi,
    mcpApi,
    opsApi,
    directTransport,
    panelManager,
    worktreeRegistry,
    sandboxSessionRegistry,
    loadSystemPrompt,
    activatePlan,
    completeModelSelectionSideEffect,
    componentHealthMonitor,
  } = options;

  const shellServices = createBootstrapCommandShellServices({
    agentManager,
    automationManager,
    modeManager,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    shellPaths,
    componentHealthMonitor,
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
  const session = createBootstrapCommandSessionSection({
    conversation,
    runtime,
    sessionManager,
    sessionMemoryStore,
    sessionLineageTracker,
    wrfcController,
    changeTracker,
    hydrateSessionUsage,
    workstreamEngine,
    codeIndexStore,
    codeIndexReindexScheduler,
    isPassiveCodeInjectionFlagEnabled,
    getMainSessionTurnInjections,
  });
  const provider = createBootstrapCommandProviderSection({
    providerRegistry,
    providerOptimizer,
    favoritesStore,
    benchmarkStore,
  });
  const workspace = createBootstrapCommandWorkspaceSection({
    keybindingsManager,
    fileUndoManager,
    workspaceCheckpointManager,
    gatewayMethods,
    workspaceTrustManager,
    workspaceRegistrationManager,
    panelManager,
    profileManager,
    bookmarkManager,
    projectPlanningService,
    projectPlanningProjectId,
    workPlanStore,
  }, shellServices);
  const platform = createBootstrapCommandPlatformSection({ configManager, pairingTokens, featureFlagManager, voiceProviderRegistry, voiceService, webSearchService, mediaProviders, artifactStore }, shellServices);
  const extensions = createBootstrapCommandExtensionsSection({
    toolRegistry,
    mcpRegistry,
  }, shellServices);
  const clients = createBootstrapCommandClientsSection({
    operatorClient,
    userPermissionRuleStore,
    peerClient,
    providerApi,
    knowledgeApi,
    memorySpine,
    hookApi,
    mcpApi,
    opsApi,
    directTransport,
  });
  const actions = createBootstrapCommandActions({
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
  });

  return {
    session,
    provider,
    workspace,
    platform,
    ops: createBootstrapCommandOpsSection(shellServices),
    extensions,
    clients,
    ...actions,
  };
}
