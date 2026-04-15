import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ArchetypeLoader } from '@pellux/goodvibes-sdk/platform/agents/archetypes';
import { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents/message-bus';
import { AgentOrchestrator } from '@pellux/goodvibes-sdk/platform/agents/orchestrator';
import { WrfcController } from '@pellux/goodvibes-sdk/platform/agents/wrfc-controller';
import { AutomationManager } from '@pellux/goodvibes-sdk/platform/automation/manager-runtime';
import { ChannelPolicyManager } from '@pellux/goodvibes-sdk/platform/channels/policy-manager';
import { RouteBindingManager } from '@pellux/goodvibes-sdk/platform/channels/route-manager';
import { ToolLLM } from '@pellux/goodvibes-sdk/platform/config/tool-llm';
import { ApprovalBroker } from '@pellux/goodvibes-sdk/platform/control-plane/approval-broker';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane/method-catalog';
import { SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane/session-broker';
import { GitService } from '@pellux/goodvibes-sdk/platform/git/service';
import type { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks/dispatcher';
import type { HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks/workbench';
import { CodeIntelligence } from '@pellux/goodvibes-sdk/platform/intelligence/facade';
import { LspService } from '@pellux/goodvibes-sdk/platform/intelligence/lsp/service';
import { TreeSitterService } from '@pellux/goodvibes-sdk/platform/intelligence/tree-sitter/service';
import { MediaProviderRegistry } from '@pellux/goodvibes-sdk/platform/media/provider-registry';
import { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins/manager';
import { createFeatureFlagManager, type FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { RemoteRunnerRegistry } from '@pellux/goodvibes-sdk/platform/runtime/remote/runner-registry';
import { RemoteSupervisor } from '@pellux/goodvibes-sdk/platform/runtime/remote/supervisor';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { TaskScheduler } from '@pellux/goodvibes-sdk/platform/scheduler/scheduler';
import { SpawnTokenManager } from '@pellux/goodvibes-sdk/platform/security/spawn-tokens';
import { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state/file-undo';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state/memory-embeddings';
import { ModeManager } from '@pellux/goodvibes-sdk/platform/state/mode-manager';
import { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state/project-index';
import { AgentManager, type AgentExecutor } from '@pellux/goodvibes-sdk/platform/tools/agent/manager';
import { AutoHealer } from '@pellux/goodvibes-sdk/platform/tools/shared/auto-heal';
import { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools/shared/process-manager';
import { ScheduleManager, TriggerManager, WorkflowManager } from '@pellux/goodvibes-sdk/platform/tools/workflow/index';
import { VoiceProviderRegistry } from '@pellux/goodvibes-sdk/platform/voice/provider-registry';
import { WebSearchProviderRegistry } from '@pellux/goodvibes-sdk/platform/web-search/provider-registry';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { makeProjectTempDir } from './project-temp.ts';

type IntelligenceTestRoots = {
  root: string;
  workingDir: string;
  homeDir: string;
  shellPaths: ReturnType<typeof createShellPathService>;
};

let testRoots: IntelligenceTestRoots | null = null;
let cleanupRegistered = false;

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

function getTestRoots(): IntelligenceTestRoots {
  if (testRoots) return testRoots;

  const root = makeProjectTempDir('gv-test-runtime');
  const workingDir = join(root, 'intelligence-workspace');
  const homeDir = join(root, 'intelligence-home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  testRoots = {
    root,
    workingDir,
    homeDir,
    shellPaths: createShellPathService({
      workingDirectory: workingDir,
      homeDirectory: homeDir,
    }),
  };

  if (!cleanupRegistered) {
    process.on('exit', () => {
      if (!testRoots) return;
      try {
        rmSync(testRoots.root, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    });
    cleanupRegistered = true;
  }

  return testRoots;
}

function nextRuntimeRoots(): { workingDir: string; configDir: string } {
  runtimeCounter += 1;
  const rootDir = join(getTestRoots().root, `runtime-${runtimeCounter}`);
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
      configManager: new ConfigManager({ surfaceRoot: 'tui',
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
  lspService ??= new LspService(getTestRoots().shellPaths);
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
    shellPaths: getTestRoots().shellPaths,
    treeSitter: getTestTreeSitterService(),
    lsp: getTestLspService(),
  });
  return codeIntelligence;
}

export function getTestIntelligenceShellPaths() {
  return getTestRoots().shellPaths;
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
    storePath: join(getTestRoots().root, 'scheduler.json'),
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
