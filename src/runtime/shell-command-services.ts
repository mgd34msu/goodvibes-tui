import { handlePlanCommand } from '../core/plan-command-handler.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { SecretsManager } from '../config/secrets.ts';
import type { SubscriptionManager } from '../config/subscriptions.ts';
import type { DeterministicReplayEngine } from '../core/deterministic-replay.ts';
import type { ForensicsRegistry } from './forensics/index.ts';
import type { IntegrationHelperService } from './integration/helpers.ts';
import type { HookWorkbench } from '../hooks/workbench.ts';
import type { WebhookNotifier } from '../integrations/webhooks.ts';
import type { KnowledgeService } from '../knowledge/index.ts';
import type { PluginManager } from '../plugins/manager.ts';
import type { UserAuthManager } from '../security/user-auth.ts';
import type { ApiTokenAuditor } from '../security/token-audit.ts';
import type { SubagentTask } from '../acp/protocol.ts';
import type { MemoryRegistry } from '../state/memory-store.ts';
import { exportRemoteArtifactForAgent } from './remote/runner-registry.ts';
import type { PolicyRegistry } from './permissions/policy-registry.ts';
import type { PolicyRuntimeState } from './permissions/policy-runtime.ts';
import type { PanelHealthMonitor } from './perf/panel-health-monitor.ts';
import type { SandboxSessionRegistry } from './sandbox/session-registry.ts';
import type { ShellPathService } from './shell-paths.ts';
import type { WorktreeRegistry } from './worktree/registry.ts';
import type { RuntimeEventBus } from './events/index.ts';
import type { RuntimeStore } from './store/index.ts';
import type { AdaptivePlanner } from '../core/adaptive-planner.ts';
import type { AgentInput } from '../tools/agent/schema.ts';
import type { AgentRecord } from '../tools/agent/manager.ts';
import type { AcpConnection } from './store/domains/acp.ts';
import type { UiReadModels, UiRemoteSnapshot } from './ui-read-models.ts';
import type { RemoteRunnerRegistry } from './remote/index.ts';
import type {
  RemoteExecutionArtifact,
  RemoteRunnerContract,
  RemoteRunnerPool,
  RemoteSessionBundle,
} from './remote/types.ts';
import type {
  AutomationJob,
  AutomationRun,
  CreateAutomationJobInput,
  AutomationManager,
} from '../automation/index.ts';
import type {
  CancellationRequest,
  CancellationResult,
  CrossSessionTaskRef,
  SessionTaskGraphSnapshot,
  TaskHandoffRecord,
} from '../sessions/orchestration/index.ts';
import type { ExecutionPlan, PlanItem } from '../core/execution-plan.ts';
import type { DomainVerbosity } from './notifications/types.ts';
import type { HITLMode, HITLModeDefinition } from '../state/mode-manager.ts';

export interface ShellAgentManagerService {
  spawn(input: AgentInput): AgentRecord;
  cancel(agentId: string): boolean;
  cancelGraph(graphId: string): string[];
  cancelSubtree(rootAgentId: string): string[];
  clear(): void;
  exportState(): AgentRecord[];
  importState(records: AgentRecord[]): void;
}

export interface ShellAcpManagerService {
  spawn(task: SubagentTask): Promise<string>;
  cancel(agentId: string): Promise<void>;
}

export interface ShellAutomationManagerService {
  start(): Promise<void>;
  listJobs(): AutomationJob[];
  createJob(input: CreateAutomationJobInput): Promise<AutomationJob>;
  removeJob(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<AutomationJob | null>;
  runNow(id: string): Promise<AutomationRun>;
}

export type ShellAutomationManagerRuntimeService = ShellAutomationManagerService & AutomationManager;

export interface ShellModeManagerService {
  getHITLMode(): HITLMode;
  getHITLPreset(): HITLModeDefinition;
  listHITLPresets(): HITLModeDefinition[];
  setHITLMode(mode: HITLMode): void;
  setDomainVerbosity(domain: string, verbosity: DomainVerbosity): void;
  getDomainOverrides(): Record<string, DomainVerbosity>;
}

export interface ShellPlanManagerService {
  getActive(sessionId?: string): ExecutionPlan | null;
  getSummary(plan: ExecutionPlan): string;
  list(): ExecutionPlan[];
  toMarkdown(plan: ExecutionPlan): string;
  create(title: string, items: Omit<PlanItem, 'id' | 'status'>[], sessionId?: string): ExecutionPlan;
  save(plan: ExecutionPlan): void;
}

export interface ShellSessionOrchestrationService {
  linkTask(ref: CrossSessionTaskRef, dependsOn?: { sessionId: string; taskId: string }): { ok: boolean; error?: string };
  initiateHandoff(
    taskRef: { sessionId: string; taskId: string },
    fromSessionId: string,
    toSessionId: string,
    reason?: string,
  ): { ok: boolean; error?: string; handoffId?: string };
  snapshot(): SessionTaskGraphSnapshot;
  getDependencies(sessionId: string, taskId: string): CrossSessionTaskRef[];
  getDependents(sessionId: string, taskId: string): CrossSessionTaskRef[];
  getHandoffs(): TaskHandoffRecord[];
  cancel(request: CancellationRequest): CancellationResult;
}

export interface RemoteCommandService {
  listActiveConnections(): readonly AcpConnection[];
  getSnapshot(): UiRemoteSnapshot;
  listPools(): readonly RemoteRunnerPool[];
  getPool(id: string): RemoteRunnerPool | null;
  createPool(input: { id: string; label: string }): RemoteRunnerPool;
  assignRunnerToPool(poolId: string, runnerId: string): RemoteRunnerPool | null;
  removeRunnerFromPool(poolId: string, runnerId: string): RemoteRunnerPool | null;
  listContracts(): readonly RemoteRunnerContract[];
  getContract(runnerId: string): RemoteRunnerContract | null;
  registerContract(contract: RemoteRunnerContract): RemoteRunnerContract;
  upsertContractForAgent(runnerId: string): RemoteRunnerContract | null;
  listArtifacts(): readonly RemoteExecutionArtifact[];
  getArtifact(artifactId: string): RemoteExecutionArtifact | null;
  buildReviewSummary(artifactId: string): string | null;
  exportArtifact(artifactId: string, path?: string): Promise<{ artifact: RemoteExecutionArtifact; path: string } | null>;
  exportArtifactForAgent(agentId: string, path?: string): Promise<{ artifact: RemoteExecutionArtifact; path: string } | null>;
  importArtifact(path: string): Promise<RemoteExecutionArtifact>;
  exportSessionBundle(path: string): Promise<{ bundle: RemoteSessionBundle; path: string }>;
  importSessionBundle(path: string): Promise<RemoteSessionBundle>;
}

export type PlanRuntimeService = (subcommand: string, args: string[]) => {
  readonly output: string;
  readonly ok: boolean;
};

/**
 * Shell bridge-owned runtime surfaces that commands are allowed to see.
 * CommandContext composes these smaller groups instead of importing raw
 * runtime service types directly into the input layer.
 */
export interface CommandWorkspaceShellServices {
  readonly shellPaths?: ShellPathService;
  readonly panelHealthMonitor?: PanelHealthMonitor;
  readonly worktreeRegistry?: WorktreeRegistry;
  readonly sandboxSessionRegistry?: SandboxSessionRegistry;
}

export interface CommandPlatformShellServices {
  readonly readModels?: UiReadModels;
  readonly serviceRegistry?: ServiceRegistry;
  readonly subscriptionManager?: SubscriptionManager;
  readonly secretsManager?: SecretsManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly tokenAuditor?: ApiTokenAuditor;
  readonly replayEngine?: DeterministicReplayEngine;
  readonly webhookNotifier?: WebhookNotifier;
}

export interface CommandOpsShellServices {
  agentManager?: ShellAgentManagerService;
  acpManager?: ShellAcpManagerService;
  automationManager?: ShellAutomationManagerRuntimeService;
  modeManager?: ShellModeManagerService;
  planManager?: ShellPlanManagerService;
  adaptivePlanner?: unknown;
  sessionOrchestration?: ShellSessionOrchestrationService;
  remoteRuntime?: RemoteCommandService;
  planRuntime?: PlanRuntimeService;
}

export interface CommandExtensionShellServices {
  readonly forensicsRegistry?: ForensicsRegistry;
  readonly policyRegistry?: PolicyRegistry;
  readonly policyRuntimeState?: PolicyRuntimeState;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
}

export interface BootstrapCommandShellServices {
  readonly workspace: Required<Pick<CommandWorkspaceShellServices,
    'shellPaths' | 'panelHealthMonitor' | 'worktreeRegistry' | 'sandboxSessionRegistry'
  >>;
  readonly platform: Required<Pick<CommandPlatformShellServices, 'readModels'>> & Omit<CommandPlatformShellServices, 'readModels'>;
  readonly ops: CommandOpsShellServices;
  readonly extensions: Required<Pick<CommandExtensionShellServices,
    'forensicsRegistry' | 'policyRuntimeState'
  >> & Omit<CommandExtensionShellServices, 'forensicsRegistry' | 'policyRuntimeState'>;
}

export type CreateBootstrapCommandShellServicesOptions = {
  readonly agentManager?: ShellAgentManagerService;
  readonly acpManager?: ShellAcpManagerService;
  readonly automationManager?: ShellAutomationManagerRuntimeService;
  readonly modeManager?: ShellModeManagerService;
  readonly planManager?: ShellPlanManagerService;
  readonly adaptivePlanner?: unknown;
  readonly sessionOrchestration?: ShellSessionOrchestrationService;
  readonly shellPaths: ShellPathService;
  readonly panelHealthMonitor: PanelHealthMonitor;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly readModels: UiReadModels;
  readonly serviceRegistry?: ServiceRegistry;
  readonly subscriptionManager?: SubscriptionManager;
  readonly secretsManager?: SecretsManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly tokenAuditor?: ApiTokenAuditor;
  readonly replayEngine?: DeterministicReplayEngine;
  readonly webhookNotifier?: WebhookNotifier;
  readonly remoteRuntime?: RemoteCommandService;
  readonly planRuntime?: PlanRuntimeService;
  readonly forensicsRegistry: ForensicsRegistry;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly memoryRegistry?: MemoryRegistry;
  readonly integrationHelpers?: IntegrationHelperService;
  readonly knowledgeService?: KnowledgeService;
  readonly pluginManager?: PluginManager;
  readonly hookWorkbench?: HookWorkbench;
};

export function createBootstrapCommandShellServices(
  options: CreateBootstrapCommandShellServicesOptions,
): BootstrapCommandShellServices {
  const {
    agentManager,
    acpManager,
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
  } = options;

  return {
    workspace: {
      shellPaths,
      panelHealthMonitor,
      worktreeRegistry,
      sandboxSessionRegistry,
    },
    platform: {
      readModels,
      serviceRegistry,
      subscriptionManager,
      secretsManager,
      localUserAuthManager,
      tokenAuditor,
      replayEngine,
      webhookNotifier,
    },
    ops: {
      agentManager,
      acpManager,
      automationManager,
      modeManager,
      planManager,
      adaptivePlanner,
      sessionOrchestration,
      remoteRuntime,
      planRuntime,
    },
    extensions: {
      forensicsRegistry,
      policyRegistry: policyRuntimeState.getRegistry(),
      policyRuntimeState,
      memoryRegistry,
      integrationHelpers,
      knowledgeService,
      pluginManager,
      hookWorkbench,
    },
  };
}

export function createShellRemoteCommandService(options: {
  readonly readModels: UiReadModels;
  readonly remoteRunnerRegistry?: RemoteRunnerRegistry;
  readonly runtimeStore: RuntimeStore;
}): RemoteCommandService | undefined {
  const { readModels, remoteRunnerRegistry, runtimeStore } = options;
  if (!remoteRunnerRegistry) return undefined;
  return {
    listActiveConnections: () => readModels.remote.getSnapshot().acp.activeConnections,
    getSnapshot: () => readModels.remote.getSnapshot(),
    listPools: () => remoteRunnerRegistry.listPools(),
    getPool: (id) => remoteRunnerRegistry.getPool(id),
    createPool: (input) => remoteRunnerRegistry.createPool(input),
    assignRunnerToPool: (poolId, runnerId) => remoteRunnerRegistry.assignRunnerToPool(poolId, runnerId),
    removeRunnerFromPool: (poolId, runnerId) => remoteRunnerRegistry.removeRunnerFromPool(poolId, runnerId),
    listContracts: () => remoteRunnerRegistry.listContracts(),
    getContract: (runnerId) => remoteRunnerRegistry.getContract(runnerId),
    registerContract: (contract) => remoteRunnerRegistry.registerContract(contract),
    upsertContractForAgent: (runnerId) => remoteRunnerRegistry.upsertContractForAgent(runnerId, runtimeStore),
    listArtifacts: () => remoteRunnerRegistry.listArtifacts(),
    getArtifact: (artifactId) => remoteRunnerRegistry.getArtifact(artifactId),
    buildReviewSummary: (artifactId) => remoteRunnerRegistry.buildReviewSummary(artifactId),
    exportArtifact: (artifactId, path) => remoteRunnerRegistry.exportArtifact(artifactId, path),
    exportArtifactForAgent: async (agentId, path) => (
      await exportRemoteArtifactForAgent(remoteRunnerRegistry, agentId, runtimeStore, path)
      ?? await (async () => {
        const artifact = remoteRunnerRegistry.captureArtifactForRunner(agentId, runtimeStore);
        if (!artifact) return null;
        return remoteRunnerRegistry.exportArtifact(artifact.id, path);
      })()
    ),
    importArtifact: (path) => remoteRunnerRegistry.importArtifact(path),
    exportSessionBundle: (path) => remoteRunnerRegistry.exportSessionBundle(runtimeStore, path),
    importSessionBundle: (path) => remoteRunnerRegistry.importSessionBundle(path),
  };
}

export function createShellPlanRuntime(options: {
  readonly adaptivePlanner?: AdaptivePlanner;
  readonly runtimeBus?: RuntimeEventBus;
}): PlanRuntimeService | undefined {
  const { adaptivePlanner, runtimeBus } = options;
  if (!adaptivePlanner) return undefined;
  return (subcommand, args) => handlePlanCommand({ adaptivePlanner, runtimeBus }, subcommand, args);
}
