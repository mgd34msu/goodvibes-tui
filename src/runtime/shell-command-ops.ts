import { handlePlanCommand } from '../core/plan-command-handler.ts';
import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
import type { SubagentTask } from '@pellux/goodvibes-sdk/platform/acp/protocol';
import { exportRemoteArtifactForAgent } from './remote/runner-registry.ts';
import type { RuntimeEventBus } from './events/index.ts';
import type { RuntimeStore } from './store/index.ts';
import type { AgentInput } from '@pellux/goodvibes-sdk/platform/tools/agent/schema';
import type { AgentRecord } from '../tools/agent/manager.ts';
import type { AcpConnection } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';
import type { UiRemoteSnapshot } from './ui-read-models.ts';
import type { RemoteRunnerRegistry } from './remote/index.ts';
import type {
  RemoteExecutionArtifact,
  RemoteRunnerContract,
  RemoteRunnerPool,
  RemoteSessionBundle,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/types';
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
} from '@pellux/goodvibes-sdk/platform/sessions/orchestration/index';
import type { ExecutionPlan, PlanItem } from '@pellux/goodvibes-sdk/platform/core/execution-plan';
import type { DomainVerbosity } from '@pellux/goodvibes-sdk/platform/runtime/notifications/types';
import type { HITLMode, HITLModeDefinition } from '@pellux/goodvibes-sdk/platform/state/mode-manager';

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

export interface CreateShellOpsServicesOptions extends CommandOpsShellServices {}

export function createShellOpsServices(
  options: CreateShellOpsServicesOptions,
): CommandOpsShellServices {
  const {
    agentManager,
    acpManager,
    automationManager,
    modeManager,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    remoteRuntime,
    planRuntime,
  } = options;

  return {
    agentManager,
    acpManager,
    automationManager,
    modeManager,
    planManager,
    adaptivePlanner,
    sessionOrchestration,
    remoteRuntime,
    planRuntime,
  };
}

export function createShellRemoteCommandService(options: {
  readonly readModels: import('./ui-read-models.ts').UiReadModels;
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
