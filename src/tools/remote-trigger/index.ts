import type { Tool } from '../../types/tools.ts';
import { getRemoteRunnerRegistry } from '../../runtime/remote/runner-registry.ts';
import { REMOTE_TRIGGER_TOOL_SCHEMA, type RemoteTriggerToolInput } from './schema.ts';

export const remoteTool: Tool = {
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
    const registry = getRemoteRunnerRegistry();

    if (input.mode === 'create-pool') {
      if (!input.poolId) return { success: false, error: 'create-pool requires poolId.' };
      const pool = registry.createPool({ id: input.poolId, label: input.label });
      return { success: true, output: JSON.stringify(pool) };
    }

    if (input.mode === 'pools') {
      return { success: true, output: JSON.stringify({ pools: registry.listPools() }) };
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
      return { success: true, output: JSON.stringify({ contracts: registry.listContracts() }) };
    }

    if (input.mode === 'artifacts') {
      return { success: true, output: JSON.stringify({ artifacts: registry.listArtifacts() }) };
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
