import type {
  CommandContext,
  CommandExtensionServices,
  CommandOpsServices,
  CommandPlatformServices,
  CommandProviderServices,
  CommandSessionServices,
  CommandWorkspaceServices,
} from '../command-registry.ts';
import type { UiReadModels } from '../../runtime/ui-read-models.ts';
import type { ShellPathService } from '../../runtime/shell-paths.ts';
import type { EcosystemCatalogPathOptions } from '../../runtime/ecosystem/catalog.ts';
import type { PluginPathOptions } from '../../plugins/loader.ts';
import type { DirectTransport } from '../../runtime/transports/direct.ts';
import type { KnowledgeApi } from '../../knowledge/knowledge-api.ts';
import type { HookApi } from '../../hooks/hook-api.ts';
import type { McpApi } from '../../mcp/mcp-api.ts';
import type { OperatorClient } from '../../runtime/operator-client.ts';
import type { OpsApi } from '../../runtime/ops-api.ts';
import type { PeerClient } from '../../runtime/peer-client.ts';
import type { ProviderApi } from '../../providers/provider-api.ts';
import type {
  ShellAgentManagerService,
  ShellAcpManagerService,
  ShellAutomationManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
} from '../../runtime/shell-command-ops.ts';

function requireContextValue<T>(value: T | null | undefined, name: string): T {
  if (value == null) {
    throw new Error(`commandContext.${name} is required but was not wired at bootstrap`);
  }
  return value;
}

export function requireSession(context: CommandContext): CommandSessionServices {
  return context.session;
}

export function requireProvider(context: CommandContext): CommandProviderServices {
  return context.provider;
}

export function requireWorkspace(context: CommandContext): CommandWorkspaceServices {
  return context.workspace;
}

export function requirePlatform(context: CommandContext): CommandPlatformServices {
  return context.platform;
}

export function requireOps(context: CommandContext): CommandOpsServices {
  return context.ops;
}

export function requireExtensions(context: CommandContext): CommandExtensionServices {
  return context.extensions;
}

export function requireReadModels(context: CommandContext): UiReadModels {
  return requireContextValue(context.platform.readModels, 'platform.readModels');
}

export function requireShellPaths(context: Pick<CommandContext, 'workspace'>): ShellPathService {
  return requireContextValue(context.workspace.shellPaths, 'workspace.shellPaths');
}

export function requireEcosystemCatalogPaths(
  context: CommandContext,
): EcosystemCatalogPathOptions {
  const shellPaths = requireShellPaths(context);
  return {
    cwd: shellPaths.workingDirectory,
    homeDir: shellPaths.homeDirectory,
  };
}

export function requirePluginPathOptions(
  context: CommandContext,
): PluginPathOptions {
  const shellPaths = requireShellPaths(context);
  return {
    cwd: shellPaths.workingDirectory,
    homeDir: shellPaths.homeDirectory,
  };
}

export function openCommandPanel(
  context: Pick<CommandContext, 'showPanel'>,
  panelId: string,
  pane?: 'top' | 'bottom',
): void {
  const showPanel = requireContextValue(context.showPanel, 'showPanel');
  showPanel(panelId, pane);
}

export function requireKeybindingsManager(context: CommandContext) {
  return requireContextValue(context.workspace.keybindingsManager, 'workspace.keybindingsManager');
}

export function requireProfileManager(context: CommandContext) {
  return requireContextValue(context.workspace.profileManager, 'workspace.profileManager');
}

export function requirePanelManager(context: CommandContext) {
  return requireContextValue(context.workspace.panelManager, 'workspace.panelManager');
}

export function requireBookmarkManager(context: CommandContext) {
  return requireContextValue(context.workspace.bookmarkManager, 'workspace.bookmarkManager');
}

export function requireSessionManager(context: CommandContext) {
  return requireContextValue(context.session.sessionManager, 'session.sessionManager');
}

export function requireSecretsManager(context: CommandContext) {
  return requireContextValue(context.platform.secretsManager, 'platform.secretsManager');
}

export function requireSubscriptionManager(context: CommandContext) {
  return requireContextValue(context.platform.subscriptionManager, 'platform.subscriptionManager');
}

export function requireServiceRegistry(context: CommandContext) {
  return requireContextValue(context.platform.serviceRegistry, 'platform.serviceRegistry');
}

export function requireLocalUserAuthManager(context: CommandContext) {
  return requireContextValue(context.platform.localUserAuthManager, 'platform.localUserAuthManager');
}

export function requireTokenAuditor(context: CommandContext) {
  return requireContextValue(context.platform.tokenAuditor, 'platform.tokenAuditor');
}

export function requireReplayEngine(context: CommandContext) {
  return requireContextValue(context.platform.replayEngine, 'platform.replayEngine');
}

export function requireWebhookNotifier(context: CommandContext) {
  return requireContextValue(context.platform.webhookNotifier, 'platform.webhookNotifier');
}

export function requireSessionMemoryStore(context: CommandContext) {
  return requireContextValue(context.session.sessionMemoryStore, 'session.sessionMemoryStore');
}

export function requireSessionLineageTracker(context: CommandContext) {
  return requireContextValue(context.session.sessionLineageTracker, 'session.sessionLineageTracker');
}

export function requireSessionChangeTracker(context: CommandContext) {
  return requireContextValue(context.session.changeTracker, 'session.changeTracker');
}

export function requirePlanManager(context: CommandContext): ShellPlanManagerService {
  return requireContextValue(context.ops.planManager, 'ops.planManager') as ShellPlanManagerService;
}

export function requireAdaptivePlanner(context: CommandContext): unknown {
  return requireContextValue(context.ops.adaptivePlanner, 'ops.adaptivePlanner');
}

export function requireSessionOrchestration(context: CommandContext): ShellSessionOrchestrationService {
  return requireContextValue(context.ops.sessionOrchestration, 'ops.sessionOrchestration') as ShellSessionOrchestrationService;
}

export function requireForensicsRegistry(context: CommandContext) {
  return requireContextValue(context.extensions.forensicsRegistry, 'extensions.forensicsRegistry');
}

export function requirePluginManager(context: CommandContext) {
  return requireContextValue(context.extensions.pluginManager, 'extensions.pluginManager');
}

export function requirePolicyRuntimeState(context: CommandContext) {
  return requireContextValue(context.extensions.policyRuntimeState, 'extensions.policyRuntimeState');
}

export function requireMcpRegistry(context: CommandContext) {
  return requireContextValue(context.extensions.mcpRegistry, 'extensions.mcpRegistry');
}

export function requireToolRegistry(context: CommandContext) {
  return requireContextValue(context.extensions.toolRegistry, 'extensions.toolRegistry');
}

export function requireHookWorkbench(context: CommandContext) {
  return requireContextValue(context.extensions.hookWorkbench, 'extensions.hookWorkbench');
}

export function requireIntegrationHelpers(context: CommandContext) {
  return requireContextValue(context.extensions.integrationHelpers, 'extensions.integrationHelpers');
}

export function requireProviderOptimizer(context: CommandContext) {
  return requireContextValue(context.provider.providerOptimizer, 'provider.providerOptimizer');
}

export function requireFavoritesStore(context: CommandContext) {
  return requireContextValue(context.provider.favoritesStore, 'provider.favoritesStore');
}

export function requireBenchmarkStore(context: CommandContext) {
  return requireContextValue(context.provider.benchmarkStore, 'provider.benchmarkStore');
}

export function requireRemoteRuntime(context: CommandContext) {
  return requireContextValue(context.ops.remoteRuntime, 'ops.remoteRuntime');
}

export function requireOperatorClient(context: CommandContext): OperatorClient {
  return requireContextValue(context.clients?.operator, 'clients.operator');
}

export function requirePeerClient(context: CommandContext): PeerClient {
  return requireContextValue(context.clients?.peer, 'clients.peer');
}

export function requireProviderApi(context: CommandContext): ProviderApi {
  return requireContextValue(context.clients?.providerApi, 'clients.providerApi');
}

export async function compactConversation(context: CommandContext): Promise<void> {
  await context.session.conversationManager.compact(
    context.provider.providerRegistry,
    context.session.runtime.model,
    'manual',
    context.session.runtime.provider,
  );
}

export function requireKnowledgeApi(context: CommandContext): KnowledgeApi {
  return requireContextValue(context.clients?.knowledgeApi, 'clients.knowledgeApi');
}

export function requireHookApi(context: CommandContext): HookApi {
  return requireContextValue(context.clients?.hookApi, 'clients.hookApi');
}

export function requireMcpApi(context: CommandContext): McpApi {
  return requireContextValue(context.clients?.mcpApi, 'clients.mcpApi');
}

export function requireOpsApi(context: CommandContext): OpsApi {
  return requireContextValue(context.clients?.opsApi, 'clients.opsApi');
}

export function requireDirectTransport(context: CommandContext): DirectTransport {
  return requireContextValue(context.clients?.transport, 'clients.transport');
}

export function requireAgentManager(context: CommandContext): ShellAgentManagerService {
  return requireContextValue(context.ops.agentManager, 'ops.agentManager') as ShellAgentManagerService;
}

export function requireAcpManager(context: CommandContext): ShellAcpManagerService {
  return requireContextValue(context.ops.acpManager, 'ops.acpManager') as ShellAcpManagerService;
}

export function requireModeManager(context: CommandContext): ShellModeManagerService {
  return requireContextValue(context.ops.modeManager, 'ops.modeManager') as ShellModeManagerService;
}

export function requireAutomationManager(context: CommandContext): ShellAutomationManagerRuntimeService {
  return requireContextValue(context.ops.automationManager, 'ops.automationManager') as ShellAutomationManagerRuntimeService;
}

export function requireSandboxSessionRegistry(context: CommandContext) {
  return requireContextValue(context.workspace.sandboxSessionRegistry, 'workspace.sandboxSessionRegistry');
}

export function requireWorktreeRegistry(context: CommandContext) {
  return requireContextValue(context.workspace.worktreeRegistry, 'workspace.worktreeRegistry');
}
