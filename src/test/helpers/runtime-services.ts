import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'bun:test';
import { ArchetypeLoader } from '@pellux/goodvibes-sdk/platform/agents';
import { AgentMessageBus } from '@pellux/goodvibes-sdk/platform/agents';
import { AgentOrchestrator } from '@pellux/goodvibes-sdk/platform/agents';
import { WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { AutomationManager } from '@pellux/goodvibes-sdk/platform/automation';
import { ChannelPolicyManager } from '@pellux/goodvibes-sdk/platform/channels';
import { RouteBindingManager } from '@pellux/goodvibes-sdk/platform/channels';
import { ToolLLM } from '@pellux/goodvibes-sdk/platform/config';
import { ApprovalBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import { SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import { GitService } from '@pellux/goodvibes-sdk/platform/git';
import type { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import type { HookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import { CodeIntelligence } from '@pellux/goodvibes-sdk/platform/intelligence';
import { LspService } from '@pellux/goodvibes-sdk/platform/intelligence';
import { TreeSitterService } from '@pellux/goodvibes-sdk/platform/intelligence';
import { MediaProviderRegistry } from '@pellux/goodvibes-sdk/platform/media';
import { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins';
import { createFeatureFlagManager, type FeatureFlagManager } from '@/runtime/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { RemoteRunnerRegistry } from '@/runtime/index.ts';
import { RemoteSupervisor } from '@/runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { TaskScheduler } from '@pellux/goodvibes-sdk/platform/scheduler';
import { SpawnTokenManager } from '@pellux/goodvibes-sdk/platform/security';
import { FileUndoManager } from '@pellux/goodvibes-sdk/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import { ModeManager } from '@pellux/goodvibes-sdk/platform/state';
import { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state';
import { AgentManager, type AgentExecutor } from '@pellux/goodvibes-sdk/platform/tools';
import { AutoHealer } from '@pellux/goodvibes-sdk/platform/tools';
import { ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import { ScheduleManager, TriggerManager, WorkflowManager } from '@pellux/goodvibes-sdk/platform/tools';
import { VoiceProviderRegistry } from '@pellux/goodvibes-sdk/platform/voice';
import { WebSearchProviderRegistry } from '@pellux/goodvibes-sdk/platform/web-search';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { makeProjectTempDir } from './project-temp.ts';
import { buildTestModelDefinition, patchTestProviderRegistry } from './test-managers.ts';

type IntelligenceTestRoots = {
  root: string;
  workingDir: string;
  homeDir: string;
  shellPaths: ReturnType<typeof createShellPathService>;
};

let testRoots: IntelligenceTestRoots | null = null;

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

  // Cleanup lives in disposeTestRuntimeServicesAfterAll's afterAll below, not
  // here. A `process.on('exit', ...)` registered from inside this lazily-
  // called function used to sit here — the exact same dead-code pattern
  // documented on makeProjectTempDir in project-temp.ts: Bun's test runner
  // never fires process.on('exit') handlers under `bun test`, and even
  // afterAll doesn't reliably attach when called from inside an
  // already-running test/beforeEach rather than at collection time. Confirmed
  // this was leaking one `gv-test-runtime` directory per test file that
  // touched this shared graph — every file calling disposeTestRuntimeServicesAfterAll()
  // already gets a correctly-scoped, top-level afterAll for free.

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

function seedRuntimeProviderTestModels(services: RuntimeServices): void {
  patchTestProviderRegistry(services.providerRegistry);
  const mockProvider = {
    name: 'mock',
    models: ['mock-model'],
    async chat() {
      return {
        content: 'ok',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'completed' as const,
      };
    },
  };
  services.providerRegistry.registerRuntimeProvider({
    provider: mockProvider,
    replace: true,
    models: [buildTestModelDefinition('mock', 'mock-model')],
  });
}

/**
 * Drop the shared test runtime graph, STOPPING it first.
 *
 * Dropping the reference alone is not enough. `createRuntimeServices()` starts
 * pollers while it builds — the fleet registry tick, the knowledge scheduler,
 * the push-subscription sweep, the cross-session orchestration sweep, the
 * orchestration snapshot writer, the config-file watch, the snapshot /
 * retention / consolidation schedulers — and every one of them keeps firing for
 * the rest of the process when the graph is abandoned rather than disposed.
 * This function is called from the `beforeEach`/`afterEach` of most tests that
 * use the shared graph, so it is the single place that decides whether the
 * suite accumulates one whole graph's worth of timers per test or none.
 */
export function resetTestRuntimeServices(): void {
  const previous = runtimeServices;
  runtimeServices = null;
  wrfcController = null;
  toolLLM = null;
  toolLLMRuntimeServices = null;
  autoHealer = null;
  previous?.dispose();
}

/**
 * Stop the shared test runtime graph when the calling test file finishes.
 *
 * Call this at the TOP LEVEL of a test file, next to its imports. It has to be
 * a function each file calls for itself: registering `afterAll` from this
 * module's own scope would run at IMPORT time, and because modules are cached
 * the hook would bind to whichever test file imported this helper first and
 * never run for any of the others.
 *
 * `resetTestRuntimeServices()` in an `afterEach` already covers the graphs a
 * file builds between tests; this covers the last one, which nothing else
 * would ever stop.
 *
 * Also removes `getTestRoots()`'s temp directory (the `gv-test-runtime-*`
 * scratch shared by getTestRuntimeServices/getTestLspService/
 * getTestCodeIntelligence/getTestTaskScheduler), which used to rely on a
 * `process.on('exit', ...)` hook registered lazily inside getTestRoots — Bun's
 * test runner never fires that under `bun test`, so it leaked the ENTIRE
 * directory tree (never removed at all) for every test file that touched any
 * of those shared services. This function is already the established
 * per-file `afterAll` entry point, so folding the cleanup in here reaches
 * every file without a second thing to remember to call.
 *
 * Known residual: confirmed by direct instrumentation that this rmSync
 * genuinely succeeds at the moment it runs, but for some files a handful of
 * files reappear under the same path microtasks later — some subsystem
 * inside the created RuntimeServices graph (not identified further; it is
 * inside @pellux/goodvibes-sdk, not this repo) performs an async write after
 * `previous?.dispose()` above has synchronously returned, without this
 * module awaiting it (resetTestRuntimeServices()'s signature is used
 * synchronously in dozens of afterEach hooks elsewhere, so it isn't safe to
 * make it async just for this). That residue is a small fraction of what
 * used to leak (a file or two under `runtime-N/config/...`, not the whole
 * populated `intelligence-workspace`/`intelligence-home` tree), and is still
 * bounded by the age-gated `.test-tmp` sweep like everything else here.
 */
export function disposeTestRuntimeServicesAfterAll(): void {
  afterAll(() => {
    resetTestRuntimeServices();
    if (testRoots) {
      try {
        rmSync(testRoots.root, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
      testRoots = null;
    }
  });
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
    seedRuntimeProviderTestModels(runtimeServices);
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
