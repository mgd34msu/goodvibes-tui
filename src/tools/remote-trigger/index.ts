import type { Tool } from '../../types/tools.ts';
import { AgentManager } from '../agent/index.ts';
import { RemoteRunnerRegistry } from '../../runtime/remote/runner-registry.ts';
import { REMOTE_TRIGGER_TOOL_SCHEMA, type RemoteTriggerToolInput } from './schema.ts';

function summarizePool(pool: ReturnType<RemoteRunnerRegistry['listPools']>[number]) {
  return {
    id: pool.id,
    label: pool.label,
    runnerCount: pool.runnerIds.length,
    runnerIds: pool.runnerIds,
    updatedAt: pool.lastUpdatedAt,
  };
}

function summarizeContract(contract: ReturnType<RemoteRunnerRegistry['listContracts']>[number]) {
  return {
    id: contract.id,
    runnerId: contract.runnerId,
    label: contract.label,
    sourceTransport: contract.sourceTransport,
    trustClass: contract.trustClass,
    template: contract.template,
    transportState: contract.transport.state,
    toolCount: contract.capabilityCeiling.allowedTools.length,
    reviewMode: contract.capabilityCeiling.reviewMode,
    communicationLane: contract.capabilityCeiling.communicationLane,
  };
}

function summarizeArtifact(artifact: ReturnType<RemoteRunnerRegistry['listArtifacts']>[number]) {
  return {
    id: artifact.id,
    runnerId: artifact.runnerId,
    createdAt: artifact.createdAt,
    task: artifact.task.task,
    status: artifact.task.status,
    hasKnowledgeInjections: artifact.knowledgeInjections.length > 0,
  };
}

export function createRemoteTool(registry: RemoteRunnerRegistry): Tool {
  return {
    definition: {
      name: 'remote',
      description: 'Manage remote runner pools, contracts, and portable artifacts.',
      parameters: REMOTE_TRIGGER_TOOL_SCHEMA.parameters,
      sideEffects: ['workflow', 'state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as RemoteTriggerToolInput;
      const view = input.view ?? 'summary';

      if (input.mode === 'create-pool') {
        if (!input.poolId) return { success: false, error: 'create-pool requires poolId.' };
        const pool = registry.createPool({ id: input.poolId, label: input.label });
        return { success: true, output: JSON.stringify(pool) };
      }

      if (input.mode === 'pools') {
        const pools = registry.listPools();
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: pools.length,
            pools: view === 'full' ? pools : pools.map(summarizePool),
          }),
        };
      }

      if (input.mode === 'assign') {
        if (!input.poolId || !input.runnerId) return { success: false, error: 'assign requires poolId and runnerId.' };
        const pool = registry.assignRunnerToPool(input.poolId, input.runnerId);
        if (!pool) return { success: false, error: `Unable to assign ${input.runnerId} to ${input.poolId}` };
        return { success: true, output: JSON.stringify(pool) };
      }

      if (input.mode === 'unassign') {
        if (!input.poolId || !input.runnerId) return { success: false, error: 'unassign requires poolId and runnerId.' };
        const pool = registry.removeRunnerFromPool(input.poolId, input.runnerId);
        if (!pool) return { success: false, error: `Unknown pool: ${input.poolId}` };
        return { success: true, output: JSON.stringify(pool) };
      }

      if (input.mode === 'contracts') {
        const contracts = registry.listContracts();
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: contracts.length,
            contracts: view === 'full' ? contracts : contracts.map(summarizeContract),
          }),
        };
      }

      if (input.mode === 'artifacts') {
        const artifacts = registry.listArtifacts();
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: artifacts.length,
            artifacts: view === 'full' ? artifacts : artifacts.map(summarizeArtifact),
          }),
        };
      }

      if (input.mode === 'review') {
        if (!input.artifactId) return { success: false, error: 'review requires artifactId.' };
        const summary = registry.buildReviewSummary(input.artifactId);
        if (!summary) return { success: false, error: `Unknown artifact: ${input.artifactId}` };
        return { success: true, output: summary };
      }

      if (input.mode === 'import-artifact') {
        if (!input.path) return { success: false, error: 'import-artifact requires path.' };
        const artifact = await registry.importArtifact(input.path);
        return { success: true, output: JSON.stringify(artifact) };
      }

      return { success: false, error: `Unknown mode: ${input.mode}` };
    },
  };
}

export const remoteTool: Tool = createRemoteTool(new RemoteRunnerRegistry(new AgentManager()));
