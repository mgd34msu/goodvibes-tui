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
} from '@pellux/goodvibes-sdk/platform/runtime/shell-command-ops';
import { createBootstrapCommandShellServices, type PlanRuntimeService, type RemoteCommandService } from '@pellux/goodvibes-sdk/platform/runtime/shell-command-services';
import type { OperatorClient } from '@pellux/goodvibes-sdk/platform/runtime/operator-client';
import type { PeerClient } from '@pellux/goodvibes-sdk/platform/runtime/peer-client';
import type { DirectTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct';
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
  providerOptimizer?: import('@pellux/goodvibes-sdk/platform/providers/optimizer').ProviderOptimizer;
  pluginManager?: PluginManager;
  hookWorkbench?: HookWorkbench;
  agentManager?: ShellAgentManagerService;
  modeManager?: ShellModeManagerService;
  sessionManager?: import('@pellux/goodvibes-sdk/platform/sessions/manager').SessionManager;
  profileManager?: import('@pellux/goodvibes-sdk/platform/profiles/manager').ProfileManager;
  bookmarkManager?: import('@pellux/goodvibes-sdk/platform/bookmarks/manager').BookmarkManager;
  favoritesStore?: import('@pellux/goodvibes-sdk/platform/providers/favorites').FavoritesStore;
  benchmarkStore?: import('@pellux/goodvibes-sdk/platform/providers/model-benchmarks').BenchmarkStore;
  providerApi?: ProviderApi;
  subscriptionManager?: import('@pellux/goodvibes-sdk/platform/config/subscriptions').SubscriptionManager;
  secretsManager?: import('../config/secrets.ts').SecretsManager;
  serviceRegistry?: import('@pellux/goodvibes-sdk/platform/config/service-registry').ServiceRegistry;
  localUserAuthManager?: import('@pellux/goodvibes-sdk/platform/security/user-auth').UserAuthManager;
  tokenAuditor?: import('@pellux/goodvibes-sdk/platform/security/token-audit').ApiTokenAuditor;
  replayEngine?: import('@pellux/goodvibes-sdk/platform/core/deterministic-replay').DeterministicReplayEngine;
  webhookNotifier?: import('@pellux/goodvibes-sdk/platform/integrations/webhooks').WebhookNotifier;
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
  worktreeRegistry: WorktreeRegistry;
  sandboxSessionRegistry: SandboxSessionRegistry;
  loadSystemPrompt: () => string;
  activatePlan: (planId: string, task: string) => void;
  completeModelSelectionSideEffect?: () => void;
  sessionLineageTracker?: import('@pellux/goodvibes-sdk/platform/core/session-lineage').SessionLineageTracker;
  componentHealthMonitor: import('@pellux/goodvibes-sdk/platform/runtime/perf/component-health-monitor').ComponentHealthMonitor;
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
