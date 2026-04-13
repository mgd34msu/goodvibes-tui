import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchetypeLoader } from '../../agents/archetypes.ts';
import { AgentMessageBus } from '../../agents/message-bus.ts';
import { AgentOrchestrator } from '../../agents/orchestrator.ts';
import { WrfcController } from '../../agents/wrfc-controller.ts';
import { AutomationManager } from '../../automation/manager-runtime.ts';
import { ChannelPolicyManager } from '../../channels/policy-manager.ts';
import { RouteBindingManager } from '../../channels/route-manager.ts';
import { ToolLLM } from '../../config/tool-llm.ts';
import { ApprovalBroker } from '../../control-plane/approval-broker.ts';
import { GatewayMethodCatalog } from '../../control-plane/method-catalog.ts';
import { SharedSessionBroker } from '../../control-plane/session-broker.ts';
import { GitService } from '../../git/service.ts';
import type { HookDispatcher } from '../../hooks/dispatcher.ts';
import type { HookWorkbench } from '../../hooks/workbench.ts';
import { CodeIntelligence } from '../../intelligence/facade.ts';
import { LspService } from '../../intelligence/lsp/service.ts';
import { TreeSitterService } from '../../intelligence/tree-sitter/service.ts';
import { MediaProviderRegistry } from '../../media/provider-registry.ts';
import { PluginManager } from '../../plugins/manager.ts';
import { createFeatureFlagManager, type FeatureFlagManager } from '../../runtime/feature-flags/index.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { RemoteRunnerRegistry } from '../../runtime/remote/runner-registry.ts';
import { RemoteSupervisor } from '../../runtime/remote/supervisor.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createShellPathService } from '../../runtime/shell-paths.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { TaskScheduler } from '../../scheduler/scheduler.ts';
import { SpawnTokenManager } from '../../security/spawn-tokens.ts';
import { FileUndoManager } from '../../state/file-undo.ts';
import { MemoryEmbeddingProviderRegistry } from '../../state/memory-embeddings.ts';
import { ModeManager } from '../../state/mode-manager.ts';
import { ProjectIndex } from '../../state/project-index.ts';
import { AgentManager, type AgentExecutor } from '../../tools/agent/manager.ts';
import { AutoHealer } from '../../tools/shared/auto-heal.ts';
import { ProcessManager } from '../../tools/shared/process-manager.ts';
import { ScheduleManager, TriggerManager, WorkflowManager } from '../../tools/workflow/index.ts';
import { VoiceProviderRegistry } from '../../voice/provider-registry.ts';
import { WebSearchProviderRegistry } from '../../web-search/provider-registry.ts';
import { ConfigManager } from '../../config/manager.ts';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'gv-test-runtime-'));
const TEST_INTELLIGENCE_WORKING_DIR = join(TEST_ROOT, 'intelligence-workspace');
const TEST_INTELLIGENCE_HOME_DIR = join(TEST_ROOT, 'intelligence-home');
mkdirSync(TEST_INTELLIGENCE_WORKING_DIR, { recursive: true });
mkdirSync(TEST_INTELLIGENCE_HOME_DIR, { recursive: true });
const TEST_INTELLIGENCE_SHELL_PATHS = createShellPathService({
  workingDirectory: TEST_INTELLIGENCE_WORKING_DIR,
  homeDirectory: TEST_INTELLIGENCE_HOME_DIR,
});
process.on('exit', () => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

let runtimeServices: RuntimeServices | null = null;
let runtimeCounter = 0;
let toolLLM: ToolLLM | null = null;
let toolLLMRuntimeServices: RuntimeServices | null = null;
let autoHealer: AutoHealer | null = null;
let lspService: LspService | null = null;
let treeSitterService: TreeSitterService | null = null;
let codeIntelligence: CodeIntelligence | null = null;
let taskScheduler: TaskScheduler | null = null;
let featureFlags: FeatureFlagManager | null = null;
const spawnTokenManagers = new Map<string, SpawnTokenManager>();
const projectIndexes = new Map<string, ProjectIndex>();
const gitServices = new Map<string, GitService>();
let wrfcController: WrfcController | null = null;
let agentExecutorForTests: AgentExecutor | null = null;

function nextRuntimeRoots(): { workingDir: string; configDir: string } {
  runtimeCounter += 1;
  const rootDir = join(TEST_ROOT, `runtime-${runtimeCounter}`);
  const workingDir = join(rootDir, 'workspace');
  const configDir = join(rootDir, 'config');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  return { workingDir, configDir };
}

function applyExecutorIfPresent(services: RuntimeServices): void {
  services.agentManager.setExecutor(agentExecutorForTests);
}

export function resetTestRuntimeServices(): void {
  runtimeServices = null;
  wrfcController = null;
  toolLLM = null;
  toolLLMRuntimeServices = null;
  autoHealer = null;
}

export function getTestRuntimeServices(): RuntimeServices {
  if (!runtimeServices) {
    const { workingDir, configDir } = nextRuntimeRoots();
    runtimeServices = createRuntimeServices({
      configManager: new ConfigManager({
        configDir,
        workingDir,
        homeDir: workingDir,
      }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      workingDir,
      homeDirectory: workingDir,
      getConversationTitle: () => 'test-runtime',
    });
    applyExecutorIfPresent(runtimeServices);
  }
  return runtimeServices;
}

export function getTestArchetypeLoader(): ArchetypeLoader {
  return getTestRuntimeServices().archetypeLoader;
}

export function getTestAgentMessageBus(): AgentMessageBus {
  return getTestRuntimeServices().agentMessageBus;
}

export function getTestAgentOrchestrator(): AgentOrchestrator {
  return getTestRuntimeServices().agentOrchestrator;
}

export function getTestAgentManager(): AgentManager {
  return getTestRuntimeServices().agentManager;
}

export function getTestRouteBindings(): RouteBindingManager {
  return getTestRuntimeServices().routeBindings;
}

export function getTestConfigManager(): RuntimeServices['configManager'] {
  return getTestRuntimeServices().configManager;
}

export function getTestProviderRegistry(): RuntimeServices['providerRegistry'] {
  return getTestRuntimeServices().providerRegistry;
}

export function getTestPanelManager(): RuntimeServices['panelManager'] {
  return getTestRuntimeServices().panelManager;
}

export function getTestBookmarkManager(): RuntimeServices['bookmarkManager'] {
  return getTestRuntimeServices().bookmarkManager;
}

export function getTestSessionManager(): RuntimeServices['sessionManager'] {
  return getTestRuntimeServices().sessionManager;
}

export function getTestSessionOrchestration(): RuntimeServices['sessionOrchestration'] {
  return getTestRuntimeServices().sessionOrchestration;
}

export function getTestReplayEngine(): RuntimeServices['replayEngine'] {
  return getTestRuntimeServices().replayEngine;
}

export function getTestServiceRegistry(): RuntimeServices['serviceRegistry'] {
  return getTestRuntimeServices().serviceRegistry;
}

export function getTestSubscriptionManager(): RuntimeServices['subscriptionManager'] {
  return getTestRuntimeServices().subscriptionManager;
}

export function getTestSessionBroker(): SharedSessionBroker {
  return getTestRuntimeServices().sessionBroker;
}

export function getTestApprovalBroker(): ApprovalBroker {
  return getTestRuntimeServices().approvalBroker;
}

export function getTestAutomationManager(): AutomationManager {
  return getTestRuntimeServices().automationManager;
}

export function getTestChannelPolicyManager(): ChannelPolicyManager {
  return getTestRuntimeServices().channelPolicy;
}

export function getTestFileUndoManager(): FileUndoManager {
  return getTestRuntimeServices().fileUndoManager;
}

export function getTestModeManager(): ModeManager {
  return getTestRuntimeServices().modeManager;
}

export function getTestWorkflowManager(): WorkflowManager {
  return getTestRuntimeServices().workflow.workflowManager;
}

export function getTestTriggerManager(): TriggerManager {
  return getTestRuntimeServices().workflow.triggerManager;
}

export function getTestScheduleManager(): ScheduleManager {
  return getTestRuntimeServices().workflow.scheduleManager;
}

export function getTestGatewayMethodCatalog(): GatewayMethodCatalog {
  return getTestRuntimeServices().gatewayMethods;
}

export function getTestHookDispatcher(): HookDispatcher {
  return getTestRuntimeServices().hookDispatcher;
}

export function getTestHookWorkbench(): HookWorkbench {
  return getTestRuntimeServices().hookWorkbench;
}

export function getTestPluginManager(): PluginManager {
  return getTestRuntimeServices().pluginManager;
}

export function getTestMemoryEmbeddingRegistry(): MemoryEmbeddingProviderRegistry {
  return getTestRuntimeServices().memoryEmbeddingRegistry;
}

export function getTestVoiceProviderRegistry(): VoiceProviderRegistry {
  return getTestRuntimeServices().voiceProviders;
}

export function getTestMediaProviderRegistry(): MediaProviderRegistry {
  return getTestRuntimeServices().mediaProviders;
}

export function getTestWebSearchProviderRegistry(): WebSearchProviderRegistry {
  return getTestRuntimeServices().webSearchProviders;
}

export function getTestRemoteRunnerRegistry(): RemoteRunnerRegistry {
  return getTestRuntimeServices().remoteRunnerRegistry;
}

export function getTestRemoteSupervisor(): RemoteSupervisor {
  return getTestRuntimeServices().remoteSupervisor;
}

export function initTestWrfcController(
  runtimeBus: RuntimeEventBus,
  messageBus: AgentMessageBus = getTestAgentMessageBus(),
): WrfcController {
  const services = getTestRuntimeServices();
  wrfcController = new WrfcController(runtimeBus, messageBus, {
    agentManager: getTestAgentManager(),
    configManager: getTestConfigManager(),
    projectRoot: services.shellPaths.workingDirectory,
  });
  return wrfcController;
}

export function getTestWrfcController(): WrfcController {
  if (!wrfcController) {
    wrfcController = getTestRuntimeServices().wrfcController;
  }
  return wrfcController;
}

export function resetTestWrfcController(): void {
  wrfcController = null;
}

export function getTestToolLLM(): ToolLLM {
  const services = getTestRuntimeServices();
  if (!toolLLM || toolLLMRuntimeServices !== services) {
    toolLLM = new ToolLLM({
      configManager: services.configManager,
      providerRegistry: services.providerRegistry,
    });
    toolLLMRuntimeServices = services;
  }
  return toolLLM;
}

export function resetTestToolLLM(): void {
  toolLLM = null;
  toolLLMRuntimeServices = null;
}

export function getTestAutoHealer(): AutoHealer {
  autoHealer ??= new AutoHealer(getTestConfigManager(), getTestToolLLM());
  return autoHealer;
}

export function resetTestAutoHealer(): void {
  autoHealer = null;
}

export function getTestLspService(): LspService {
  lspService ??= new LspService(TEST_INTELLIGENCE_SHELL_PATHS);
  return lspService;
}

export function resetTestLspService(): void {
  lspService = null;
}

export function getTestTreeSitterService(): TreeSitterService {
  treeSitterService ??= new TreeSitterService();
  return treeSitterService;
}

export function getTestCodeIntelligence(): CodeIntelligence {
  codeIntelligence ??= new CodeIntelligence({
    shellPaths: TEST_INTELLIGENCE_SHELL_PATHS,
    treeSitter: getTestTreeSitterService(),
    lsp: getTestLspService(),
  });
  return codeIntelligence;
}

export function getTestIntelligenceShellPaths() {
  return TEST_INTELLIGENCE_SHELL_PATHS;
}

export function resetTestCodeIntelligence(): void {
  codeIntelligence = null;
  treeSitterService = null;
  lspService = null;
}

export function getTestProcessManager(): ProcessManager {
  return getTestRuntimeServices().processManager;
}

export function resetTestProcessManager(): void {
  resetTestRuntimeServices();
}

export function getTestTaskScheduler(
  config?: string | ConstructorParameters<typeof TaskScheduler>[0],
): TaskScheduler {
  taskScheduler ??= new TaskScheduler(config ?? {
    storePath: join(TEST_ROOT, 'scheduler.json'),
    spawnTask: () => 'test-agent',
  });
  return taskScheduler;
}

export function resetTestTaskScheduler(): void {
  taskScheduler?.stop();
  taskScheduler = null;
}

export function getTestSpawnTokenManager(sessionId: string): SpawnTokenManager {
  const existing = spawnTokenManagers.get(sessionId);
  if (existing) return existing;
  const created = new SpawnTokenManager(sessionId);
  spawnTokenManagers.set(sessionId, created);
  return created;
}

export function resetTestSpawnTokenManagers(): void {
  spawnTokenManagers.clear();
}

export function getTestFeatureFlagManager(): FeatureFlagManager {
  featureFlags ??= createFeatureFlagManager();
  return featureFlags;
}

export function setTestFeatureFlagManager(manager: FeatureFlagManager): void {
  featureFlags = manager;
}

export function resetTestFeatureFlagManager(): void {
  featureFlags = null;
}

export function getTestProjectIndex(cwd: string): ProjectIndex {
  const existing = projectIndexes.get(cwd);
  if (existing) return existing;
  const created = new ProjectIndex(cwd);
  projectIndexes.set(cwd, created);
  return created;
}

export function resetTestProjectIndexes(): void {
  projectIndexes.clear();
}

export function getTestGitService(cwd = process.cwd()): GitService {
  const existing = gitServices.get(cwd);
  if (existing) return existing;
  const created = new GitService(cwd);
  gitServices.set(cwd, created);
  return created;
}

export function resetTestGitServices(cwd?: string): void {
  if (cwd) {
    gitServices.delete(cwd);
    return;
  }
  gitServices.clear();
}

export function resetAllTestServiceState(): void {
  resetTestRuntimeServices();
  resetTestWrfcController();
  resetTestToolLLM();
  resetTestAutoHealer();
  resetTestCodeIntelligence();
  resetTestTaskScheduler();
  resetTestSpawnTokenManagers();
  resetTestFeatureFlagManager();
  resetTestProjectIndexes();
  resetTestGitServices();
}

export function applyTestAgentExecutor(executor: AgentExecutor | null): void {
  agentExecutorForTests = executor;
  if (runtimeServices) {
    runtimeServices.agentManager.setExecutor(executor);
  }
}
