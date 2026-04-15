import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools/agent/manager';
import type { RuntimeStore } from '../store/index.ts';
import type { AcpConnection } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/acp';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type {
  RemoteExecutionArtifact,
  RemoteRunnerContract,
  RemoteRunnerCapabilityCeiling,
  RemoteRunnerEvidenceSummary,
  RemoteRunnerPool,
  RemoteSessionBundle,
} from '@pellux/goodvibes-sdk/platform/runtime/remote/types';
import type { RuntimeTask } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

const DEFAULT_ARTIFACT_DIR = '.goodvibes/remote-artifacts';
const DEFAULT_SESSION_BUNDLE_DIR = '.goodvibes/remote-sessions';

function buildCapabilityCeiling(agent: AgentRecord): RemoteRunnerCapabilityCeiling {
  return Object.freeze({
    allowedTools: [...agent.tools],
    capabilityCeilingTools: [...(agent.capabilityCeilingTools ?? agent.tools)],
    executionProtocol: agent.executionProtocol,
    reviewMode: agent.reviewMode,
    communicationLane: agent.communicationLane,
    orchestrationDepth: agent.orchestrationDepth,
    successCriteria: [...(agent.successCriteria ?? [])],
    requiredEvidence: [...(agent.requiredEvidence ?? [])],
    writeScope: [...(agent.writeScope ?? [])],
  });
}

function buildEvidenceSummary(agent: AgentRecord, connection?: AcpConnection): RemoteRunnerEvidenceSummary {
  return Object.freeze({
    toolCallCount: agent.toolCallCount,
    messageCount: connection?.messageCount ?? 0,
    errorCount: connection?.errorCount ?? 0,
    transportState: connection?.transportState ?? 'disconnected',
    connectedAt: connection?.connectedAt,
    lastError: connection?.lastError ?? agent.error,
    hasKnowledgeInjections: (agent.knowledgeInjections?.length ?? 0) > 0,
  });
}

function summarizeOutput(agent: AgentRecord): string {
  const raw = agent.fullOutput ?? agent.progress ?? agent.error ?? 'No output recorded.';
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function buildContract(agent: AgentRecord, connection?: AcpConnection, existing?: RemoteRunnerContract): RemoteRunnerContract {
  return Object.freeze({
    id: `runner:${agent.id}`,
    runnerId: agent.id,
    poolId: existing?.poolId,
    taskId: connection?.taskId,
    label: connection?.label ?? `${agent.template} runner`,
    sourceTransport: connection ? 'acp' : 'daemon',
    trustClass: connection ? 'self-hosted-acp' : 'local-daemon',
    template: agent.template,
    parentAgentId: agent.parentAgentId,
    orchestrationGraphId: agent.orchestrationGraphId,
    orchestrationNodeId: agent.orchestrationNodeId,
    capabilityCeiling: buildCapabilityCeiling(agent),
    createdAt: agent.startedAt,
    lastUpdatedAt: agent.completedAt ?? Date.now(),
    transport: Object.freeze({
      state: connection?.transportState ?? 'disconnected',
      connectedAt: connection?.connectedAt,
      messageCount: connection?.messageCount ?? 0,
      errorCount: connection?.errorCount ?? 0,
      lastError: connection?.lastError,
    }),
  });
}

function buildArtifact(agent: AgentRecord, contract: RemoteRunnerContract, connection?: AcpConnection): RemoteExecutionArtifact {
  return Object.freeze({
    id: `artifact:${agent.id}:${Date.now()}`,
    runnerId: agent.id,
    createdAt: Date.now(),
    runnerContract: contract,
    task: Object.freeze({
      task: agent.task,
      status: agent.status,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      summary: summarizeOutput(agent),
      fullOutput: agent.fullOutput,
      error: agent.error,
      progress: agent.progress,
    }),
    evidence: buildEvidenceSummary(agent, connection),
    knowledgeInjections: Object.freeze([...(agent.knowledgeInjections ?? [])]),
  });
}

function summarizeTaskOutput(task?: RuntimeTask): string {
  if (!task) return 'No task output recorded.';
  const payload = (
    typeof task.result === 'string'
      ? task.result
      : task.error
        ?? (task.result !== undefined ? JSON.stringify(task.result) : task.description)
        ?? task.title
  );
  const normalized = String(payload).replace(/\s+/g, ' ').trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function findTaskForContract(contract: RemoteRunnerContract, store?: RuntimeStore): RuntimeTask | undefined {
  if (!store) return undefined;
  const tasks = store.getState().tasks.tasks;
  if (contract.taskId) {
    const byTaskId = tasks.get(contract.taskId);
    if (byTaskId) return byTaskId;
  }
  for (const task of tasks.values()) {
    if (task.owner === contract.runnerId && task.kind === 'acp') {
      return task;
    }
  }
  return undefined;
}

function mapTaskStatus(
  task?: RuntimeTask,
): 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' {
  switch (task?.status) {
    case 'queued':
      return 'pending';
    case 'running':
    case 'blocked':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

function buildArtifactFromStore(
  contract: RemoteRunnerContract,
  store?: RuntimeStore,
): RemoteExecutionArtifact {
  const connection = contract.runnerId ? store?.getState().acp.connections.get(contract.runnerId) : undefined;
  const task = findTaskForContract(contract, store);
  return Object.freeze({
    id: `artifact:${contract.runnerId}:${Date.now()}`,
    runnerId: contract.runnerId,
    createdAt: Date.now(),
    runnerContract: contract,
    task: Object.freeze({
      task: task?.description ?? task?.title ?? contract.label,
      status: mapTaskStatus(task),
      startedAt: task?.startedAt ?? contract.createdAt,
      completedAt: task?.endedAt,
      summary: summarizeTaskOutput(task),
      ...(typeof task?.result === 'string' ? { fullOutput: task.result } : {}),
      ...(task?.error ? { error: task.error } : {}),
    }),
    evidence: Object.freeze({
      toolCallCount: 0,
      messageCount: connection?.messageCount ?? contract.transport.messageCount,
      errorCount: connection?.errorCount ?? contract.transport.errorCount,
      transportState: connection?.transportState ?? contract.transport.state,
      connectedAt: connection?.connectedAt ?? contract.transport.connectedAt,
      lastError: connection?.lastError ?? contract.transport.lastError,
      hasKnowledgeInjections: false,
    }),
    knowledgeInjections: Object.freeze([]),
  });
}

export class RemoteRunnerRegistry {
  private readonly contracts = new Map<string, RemoteRunnerContract>();
  private readonly artifacts = new Map<string, RemoteExecutionArtifact>();
  private readonly pools = new Map<string, RemoteRunnerPool>();
  constructor(private readonly agentManager: Pick<AgentManager, 'getStatus' | 'list'>) {
  }

  private resolveConnection(agentId: string, store?: RuntimeStore): AcpConnection | undefined {
    return store?.getState().acp.connections.get(agentId);
  }

  upsertContractForAgent(agentId: string, store?: RuntimeStore): RemoteRunnerContract | null {
    const agent = this.agentManager.getStatus(agentId);
    if (!agent) return null;
    const contract = buildContract(agent, this.resolveConnection(agentId, store), this.contracts.get(agentId) ?? undefined);
    this.contracts.set(agentId, contract);
    if (contract.poolId) {
      this.assignRunnerToPool(contract.poolId, contract.runnerId);
    }
    return contract;
  }

  getContract(agentId: string): RemoteRunnerContract | null {
    return this.contracts.get(agentId) ?? null;
  }

  registerContract(contract: RemoteRunnerContract): RemoteRunnerContract {
    this.contracts.set(contract.runnerId, contract);
    if (contract.poolId) {
      this.assignRunnerToPool(contract.poolId, contract.runnerId);
    }
    return contract;
  }

  listContracts(): RemoteRunnerContract[] {
    return [...this.contracts.values()].sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  }

  createPool(input: {
    id: string;
    label?: string;
    description?: string;
    trustClass?: RemoteRunnerPool['trustClass'];
    preferredTemplate?: string;
    maxRunners?: number;
  }): RemoteRunnerPool {
    const existing = this.pools.get(input.id);
    const now = Date.now();
    const pool: RemoteRunnerPool = Object.freeze({
      id: input.id,
      label: input.label ?? existing?.label ?? input.id,
      description: input.description ?? existing?.description,
      trustClass: input.trustClass ?? existing?.trustClass ?? 'self-hosted-acp',
      preferredTemplate: input.preferredTemplate ?? existing?.preferredTemplate,
      maxRunners: input.maxRunners ?? existing?.maxRunners,
      runnerIds: existing?.runnerIds ?? [],
      createdAt: existing?.createdAt ?? now,
      lastUpdatedAt: now,
    });
    this.pools.set(pool.id, pool);
    return pool;
  }

  getPool(poolId: string): RemoteRunnerPool | null {
    return this.pools.get(poolId) ?? null;
  }

  listPools(): RemoteRunnerPool[] {
    return [...this.pools.values()].sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  }

  assignRunnerToPool(poolId: string, runnerId: string): RemoteRunnerPool | null {
    const contract = this.contracts.get(runnerId);
    const pool = this.pools.get(poolId) ?? this.createPool({ id: poolId, label: poolId });
    if (pool.maxRunners !== undefined && !pool.runnerIds.includes(runnerId) && pool.runnerIds.length >= pool.maxRunners) {
      return null;
    }
    const nextRunnerIds = pool.runnerIds.includes(runnerId)
      ? pool.runnerIds
      : [...pool.runnerIds, runnerId];
    const nextPool: RemoteRunnerPool = Object.freeze({
      ...pool,
      runnerIds: nextRunnerIds,
      lastUpdatedAt: Date.now(),
    });
    this.pools.set(poolId, nextPool);
    if (contract && contract.poolId !== poolId) {
      this.contracts.set(runnerId, Object.freeze({ ...contract, poolId, lastUpdatedAt: Date.now() }));
    }
    return nextPool;
  }

  removeRunnerFromPool(poolId: string, runnerId: string): RemoteRunnerPool | null {
    const pool = this.pools.get(poolId);
    if (!pool) return null;
    const nextPool: RemoteRunnerPool = Object.freeze({
      ...pool,
      runnerIds: pool.runnerIds.filter((id) => id !== runnerId),
      lastUpdatedAt: Date.now(),
    });
    this.pools.set(poolId, nextPool);
    const contract = this.contracts.get(runnerId);
    if (contract?.poolId === poolId) {
      this.contracts.set(runnerId, Object.freeze({ ...contract, poolId: undefined, lastUpdatedAt: Date.now() }));
    }
    return nextPool;
  }

  captureArtifactForAgent(agentId: string, store?: RuntimeStore): RemoteExecutionArtifact | null {
    const agent = this.agentManager.getStatus(agentId);
    if (!agent) return null;
    const connection = this.resolveConnection(agentId, store);
    const contract = this.upsertContractForAgent(agentId, store) ?? buildContract(agent, connection);
    const artifact = buildArtifact(agent, contract, connection);
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  captureArtifactForRunner(runnerId: string, store?: RuntimeStore): RemoteExecutionArtifact | null {
    const byAgent = this.captureArtifactForAgent(runnerId, store);
    if (byAgent) return byAgent;
    const contract = this.contracts.get(runnerId);
    if (!contract) return null;
    const artifact = buildArtifactFromStore(contract, store);
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  getArtifact(artifactId: string): RemoteExecutionArtifact | null {
    return this.artifacts.get(artifactId) ?? null;
  }

  listArtifacts(): RemoteExecutionArtifact[] {
    return [...this.artifacts.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async exportArtifact(
    artifactId: string,
    explicitPath?: string,
  ): Promise<{ artifact: RemoteExecutionArtifact; path: string } | null> {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) return null;
    const path = explicitPath
      ? resolve(explicitPath)
      : resolve(DEFAULT_ARTIFACT_DIR, `${artifact.id.replace(/[:]/g, '_')}.json`);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
    return { artifact, path };
  }

  async importArtifact(path: string): Promise<RemoteExecutionArtifact> {
    const raw = await readFile(resolve(path), 'utf-8');
    const parsed = JSON.parse(raw) as RemoteExecutionArtifact;
    this.artifacts.set(parsed.id, parsed);
    this.contracts.set(parsed.runnerId, parsed.runnerContract);
    return parsed;
  }

  buildSessionBundle(store?: RuntimeStore): RemoteSessionBundle {
    this.ensureContractsFromStore(store);
    const activeConnectionIds = store?.getState().acp.activeConnectionIds ?? [];
    return Object.freeze({
      version: 1,
      exportedAt: Date.now(),
      sessionId: store?.getState().session.id || 'unknown-session',
      activeConnectionIds: Object.freeze([...activeConnectionIds]),
      pools: Object.freeze(this.listPools()),
      contracts: Object.freeze(this.listContracts()),
      artifacts: Object.freeze(this.listArtifacts()),
    });
  }

  async exportSessionBundle(
    store?: RuntimeStore,
    explicitPath?: string,
  ): Promise<{ bundle: RemoteSessionBundle; path: string }> {
    const bundle = this.buildSessionBundle(store);
    const path = explicitPath
      ? resolve(explicitPath)
      : resolve(DEFAULT_SESSION_BUNDLE_DIR, `${bundle.sessionId}-${bundle.exportedAt}.json`);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
    return { bundle, path };
  }

  async importSessionBundle(path: string): Promise<RemoteSessionBundle> {
    const raw = await readFile(resolve(path), 'utf-8');
    const parsed = JSON.parse(raw) as RemoteSessionBundle;
    for (const pool of parsed.pools) {
      this.pools.set(pool.id, pool);
    }
    for (const contract of parsed.contracts) {
      this.contracts.set(contract.runnerId, contract);
    }
    for (const artifact of parsed.artifacts) {
      this.artifacts.set(artifact.id, artifact);
    }
    return parsed;
  }

  buildReviewSummary(artifactId: string): string | null {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) return null;
    const lines = [
      `Remote Artifact ${artifact.id}`,
      `  runner: ${artifact.runnerId}`,
      `  template: ${artifact.runnerContract.template}`,
      `  status: ${artifact.task.status}`,
      `  summary: ${artifact.task.summary}`,
      `  tools: ${artifact.runnerContract.capabilityCeiling.allowedTools.join(', ') || '(none)'}`,
      `  evidence: toolCalls=${artifact.evidence.toolCallCount} messages=${artifact.evidence.messageCount} errors=${artifact.evidence.errorCount}`,
    ];
    if (artifact.task.error) lines.push(`  error: ${artifact.task.error}`);
    if (artifact.knowledgeInjections.length > 0) {
      lines.push(`  knowledge: ${artifact.knowledgeInjections.map((entry) => entry.id).join(', ')}`);
    }
    return lines.join('\n');
  }

  ensureContractsFromStore(store?: RuntimeStore): void {
    for (const agent of this.agentManager.list()) {
      if (agent.orchestrationGraphId || agent.parentAgentId || store?.getState().acp.connections.has(agent.id)) {
        this.upsertContractForAgent(agent.id, store);
      }
    }
  }

  clear(): void {
    this.contracts.clear();
    this.artifacts.clear();
    this.pools.clear();
  }
}

export async function exportRemoteArtifactForAgent(
  registry: RemoteRunnerRegistry,
  agentId: string,
  store?: RuntimeStore,
  path?: string,
): Promise<{ artifact: RemoteExecutionArtifact; path: string } | null> {
  const artifact = registry.captureArtifactForAgent(agentId, store);
  if (!artifact) return null;
  return registry.exportArtifact(artifact.id, path);
}

export async function importRemoteArtifact(
  registry: RemoteRunnerRegistry,
  path: string,
): Promise<RemoteExecutionArtifact> {
  try {
    return await registry.importArtifact(path);
  } catch (error) {
    logger.debug('RemoteRunnerRegistry.importArtifact failed', { path, error: summarizeError(error) });
    throw error;
  }
}
