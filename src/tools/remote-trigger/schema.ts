import type { ToolDefinition } from '../../types/tools.ts';

export const REMOTE_TRIGGER_TOOL_SCHEMA: ToolDefinition = {
  name: 'remote',
  description: 'Manage remote runner pools, contracts, and portable artifacts.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['create-pool', 'pools', 'assign', 'unassign', 'contracts', 'artifacts', 'review', 'import-artifact'] },
      view: { type: 'string', enum: ['summary', 'full'] },
      poolId: { type: 'string' },
      label: { type: 'string' },
      runnerId: { type: 'string' },
      artifactId: { type: 'string' },
      path: { type: 'string' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface RemoteTriggerToolInput {
  readonly mode: 'create-pool' | 'pools' | 'assign' | 'unassign' | 'contracts' | 'artifacts' | 'review' | 'import-artifact';
  readonly view?: 'summary' | 'full';
  readonly poolId?: string;
  readonly label?: string;
  readonly runnerId?: string;
  readonly artifactId?: string;
  readonly path?: string;
}
