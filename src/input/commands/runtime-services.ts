import type {
  CommandContext,
  CommandExtensionServices,
  CommandOpsServices,
  CommandPlatformServices,
  CommandProviderServices,
  CommandSessionServices,
  CommandWorkspaceServices,
} from '../command-registry.ts';
import { compactSmallWindow, getLastCompactionEvent, SMALL_WINDOW_THRESHOLD } from '@pellux/goodvibes-sdk/platform/core';
import type { CompactionContext, CompactionEvent } from '@pellux/goodvibes-sdk/platform/core';
import { recordCompactionQualityScore, scoreCompactionRun } from '../../renderer/compaction-quality.ts';
import type { CompactionQualityScore } from '../../renderer/compaction-quality.ts';
import type { UiReadModels } from '../../runtime/ui-read-models.ts';
import type { ShellPathService, SessionSurface } from '@/runtime/index.ts';
import type { EcosystemCatalogPathOptions } from '@/runtime/index.ts';
import type { PluginPathOptions } from '@pellux/goodvibes-sdk/platform/plugins';
import type { DirectTransport } from '@/runtime/index.ts';
import type { KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import type { HookApi } from '@pellux/goodvibes-sdk/platform/hooks';
import type { McpApi } from '@pellux/goodvibes-sdk/platform/mcp';
import type { OperatorClient } from '@/runtime/index.ts';
import type { OpsApi } from '@/runtime/index.ts';
import type { PeerClient } from '@/runtime/index.ts';
import type { ProviderApi } from '@pellux/goodvibes-sdk/platform/providers';
import type {
  ShellAgentManagerService,
  ShellAcpManagerService,
  ShellAutomationManagerService,
  ShellAutomationManagerRuntimeService,
  ShellModeManagerService,
  ShellPlanManagerService,
  ShellSessionOrchestrationService,
} from '@/runtime/index.ts';

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

/**
 * The runtime's declare-once session-storage handle. Commands that touch
 * session state take their paths from here rather than rebuilding a scope out
 * of shellPaths, so a command and the runtime that wrote the file always agree
 * on where it lives.
 */
export function requireSurface(context: Pick<CommandContext, 'workspace'>): SessionSurface {
  return requireContextValue(context.workspace.surface, 'workspace.surface');
}

export function requireEcosystemCatalogPaths(
  context: CommandContext,
): EcosystemCatalogPathOptions {
  const shellPaths = requireShellPaths(context);
  return {
    cwd: shellPaths.workingDirectory,
    homeDir: shellPaths.homeDirectory,
    projectCatalogRoot: shellPaths.resolveProjectPath('tui', 'ecosystem'),
    userCatalogRoot: shellPaths.resolveUserPath('tui', 'ecosystem'),
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

/**
 * (group-B migration): open a config-modal surface by name via the
 * ctx.openModal seam (ui-openers wires it; the host replaces the interim
 * "not available yet" implementation with real dispatch). Front-doors for
 * panels that migrated to modals call this instead of openCommandPanel — the
 * modal is the surface's new home. Stubbed in tests by setting ctx.openModal.
 */
export function openModalCommand(
  context: Pick<CommandContext, 'openModal'>,
  modalName: string,
): void {
  const openModal = requireContextValue(context.openModal, 'openModal');
  openModal(modalName);
}

export function openOnboardingWizard(
  context: Pick<CommandContext, 'openOnboardingWizard'>,
  modeOrOptions?: import('../onboarding/onboarding-wizard.ts').OnboardingWizardMode
    | import('../handler-ui-state.ts').OpenOnboardingWizardOptions,
): void {
  const openWizard = requireContextValue(context.openOnboardingWizard, 'openOnboardingWizard');
  openWizard(modeOrOptions);
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

/** Result of a manual /compact run: the SDK's CompactionEvent, plus an
 * out-of-band quality score () when one could be computed. */
export interface CompactionRunResult {
  readonly event: CompactionEvent;
  readonly qualityScore: CompactionQualityScore | null;
}

/**
 * Compact the conversation and return the CompactionEvent recorded by the SDK
 * (plus an out-of-band quality score), or null if no event was recorded (e.g.
 * compaction was skipped or produced no change).
 */
export async function compactConversation(context: CommandContext): Promise<CompactionRunResult | null> {
  const conversationManager = context.session.conversationManager;
  const providerRegistry = context.provider.providerRegistry;
  // Resolve the live context window for the current model so manual /compact
  // matches the auto-compaction path (which scales behaviour by window size)
  // instead of passing a meaningless 0.
  const contextWindow = providerRegistry.getContextWindowForModel(
    providerRegistry.getCurrentModel(),
  );

  // Small-window models lack room for the structured (multi-LLM) extraction
  // pipeline, so mirror the SDK auto-compaction path and degrade to the
  // simplified "keep the most recent messages" compaction.
  if (contextWindow > 0 && contextWindow < SMALL_WINDOW_THRESHOLD) {
    const compacted = compactSmallWindow(conversationManager.getMessagesForLLM(), 10);
    conversationManager.replaceMessagesForLLM(compacted);
    return null;
  }

  const eventBefore = getLastCompactionEvent();
  const messagesBefore = conversationManager.getMessagesForLLM();
  const sessionMemories = context.session.sessionMemoryStore?.list() ?? [];
  const lineageTracker = context.session.sessionLineageTracker;
  const agentManager = context.ops.agentManager;
  const planManager = context.ops.planManager;
  const compactionCtx: CompactionContext = {
    messages: messagesBefore,
    sessionMemories,
    // Mirror buildAutoCompactionContext: pass ALL agent records (not just
    // running/pending) so completed/failed subagent work reaches the
    // "Completed Agent Work" / "Currently Running" compaction sections, plus
    // the active execution plan and the session-lineage log so the handoff
    // summary and lineage section are populated correctly (not "compaction #0").
    agents: agentManager?.exportState() ?? [],
    // Mirror buildAutoCompactionContext: include the live WRFC chains (wired
    // through context.session.wrfcController) so the handoff summary's
    // orchestration section matches the SDK auto-compaction path.
    wrfcChains: context.session.wrfcController?.listChains() ?? [],
    activePlan: planManager?.getActive(context.session.runtime.sessionId) ?? null,
    lineageEntries: lineageTracker?.getEntries() ?? [],
    compactionCount: lineageTracker?.getCompactionCount() ?? 0,
    // Mirror buildAutoCompactionContext: pass the recorded original task so
    // the "Original task" lineage line reflects the session's actual first
    // task instead of falling back to the current message on every manual
    // compaction after the first.
    originalTask: lineageTracker?.getOriginalTask() ?? undefined,
    contextWindow,
    trigger: 'manual',
    extractionModelId: context.session.runtime.model,
    extractionProvider: context.session.runtime.provider,
  };
  await conversationManager.compact(
    providerRegistry,
    context.session.runtime.model,
    'manual',
    context.session.runtime.provider,
    compactionCtx,
  );
  const eventAfter = getLastCompactionEvent();
  // Return the new event only if it differs from the one recorded before the call.
  if (eventAfter !== null && eventAfter !== eventBefore) {
    //: score this run out-of-band (see compaction-quality.ts for why
    // this can't just subscribe to the SDK's own CompactionManager pipeline)
    // and keep the score keyed by this event's timestamp for /compact-history.
    const qualityScore = scoreCompactionRun({
      sessionId: context.session.runtime.sessionId,
      contextWindow,
      messagesBefore,
      messagesAfter: conversationManager.getMessagesForLLM(),
      tokensBefore: eventAfter.tokensBeforeEstimate,
      tokensAfter: eventAfter.tokensAfterEstimate,
    });
    recordCompactionQualityScore(eventAfter.timestamp, qualityScore);
    return { event: eventAfter, qualityScore };
  }
  return null;
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
