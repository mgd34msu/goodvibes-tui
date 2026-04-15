import type { ConfigManager } from '../config/manager.ts';
import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
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
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import type { ForensicsRegistry } from './forensics/index.ts';
import type { PolicyRuntimeState } from './permissions/policy-runtime.ts';
import type { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state/file-undo';
import type { McpRegistry } from '../mcp/registry.ts';
import type { MemoryRegistry } from '../state/memory-store.ts';
import type { IntegrationHelperService } from './integration/helpers.ts';
import type { KnowledgeService } from '../knowledge/index.ts';
import type { PluginManager } from '../plugins/manager.ts';
import type { HookWorkbench } from '../hooks/workbench.ts';
import type { PanelHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/panel-health-monitor';
import type { WorktreeRegistry } from './worktree/registry.ts';
import type { SandboxSessionRegistry } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/session-registry';
import type { UiReadModels } from './ui-read-models.ts';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import type {
  ShellAgentManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
} from './shell-command-ops.ts';
import { createBootstrapCommandShellServices, type PlanRuntimeService, type RemoteCommandService } from './shell-command-services.ts';
import type { OperatorClient } from './operator-client.ts';
import type { PeerClient } from './peer-client.ts';
import type { DirectTransport } from './transports/direct.ts';
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
  profileManager?: import('@pellux/goodvibes-sdk/platform/profiles/manager').ProfileManager;
  bookmarkManager?: import('@pellux/goodvibes-sdk/platform/bookmarks/manager').BookmarkManager;
  favoritesStore?: import('@pellux/goodvibes-sdk/platform/providers/favorites').FavoritesStore;
  benchmarkStore?: import('@pellux/goodvibes-sdk/platform/providers/model-benchmarks').BenchmarkStore;
  providerApi?: ProviderApi;
  subscriptionManager?: import('@pellux/goodvibes-sdk/platform/config/subscriptions').SubscriptionManager;
  secretsManager?: import('../config/secrets.ts').SecretsManager;
  serviceRegistry?: import('../config/service-registry.ts').ServiceRegistry;
  localUserAuthManager?: import('@pellux/goodvibes-sdk/platform/security/user-auth').UserAuthManager;
  tokenAuditor?: import('@pellux/goodvibes-sdk/platform/security/token-audit').ApiTokenAuditor;
  replayEngine?: import('@pellux/goodvibes-sdk/platform/core/deterministic-replay').DeterministicReplayEngine;
  webhookNotifier?: import('../integrations/webhooks.ts').WebhookNotifier;
  sessionMemoryStore?: import('@pellux/goodvibes-sdk/platform/core/session-memory').SessionMemoryStore;
  changeTracker?: import('@pellux/goodvibes-sdk/platform/sessions/change-tracker').SessionChangeTracker;
  planManager?: ShellPlanManagerService;
  adaptivePlanner?: AdaptivePlanner;
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
  sessionLineageTracker?: import('@pellux/goodvibes-sdk/platform/core/session-lineage').SessionLineageTracker;
};

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
  const session = createBootstrapCommandSessionSection({
    conversation,
    runtime,
    sessionManager,
    sessionMemoryStore,
    sessionLineageTracker,
    changeTracker,
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
    panelManager,
    profileManager,
    bookmarkManager,
  }, shellServices);
  const platform = createBootstrapCommandPlatformSection({ configManager }, shellServices);
  const extensions = createBootstrapCommandExtensionsSection({
    toolRegistry,
    mcpRegistry,
  }, shellServices);
  const clients = createBootstrapCommandClientsSection({
    operatorClient,
    peerClient,
    providerApi,
    knowledgeApi,
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
