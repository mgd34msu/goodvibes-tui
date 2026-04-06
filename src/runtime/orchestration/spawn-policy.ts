import { configManager } from '../../config/index.ts';

export type OrchestrationSpawnMode = 'manual-batch' | 'plan-auto' | 'recursive-child';

export type OrchestrationSpawnDecision = {
  allowed: boolean;
  reason?: string;
  maxAgents: number;
  activeAgents: number;
  availableSlots: number;
  requestedDepth: number;
  maxDepth: number;
  mode: OrchestrationSpawnMode;
};

export function evaluateOrchestrationSpawn(input: {
  mode: OrchestrationSpawnMode;
  activeAgents: number;
  requestedDepth?: number;
  overrides?: {
    recursionEnabled?: boolean;
    maxAgents?: number;
    maxDepth?: number;
  };
}): OrchestrationSpawnDecision {
  const maxAgents = input.overrides?.maxAgents ?? ((configManager.get('orchestration.maxActiveAgents') as number | null) ?? 8);
  const maxDepth = input.overrides?.maxDepth ?? ((configManager.get('orchestration.maxDepth') as number | null) ?? 0);
  const recursionEnabled = input.overrides?.recursionEnabled ?? ((configManager.get('orchestration.recursionEnabled') as boolean | null) ?? false);
  const requestedDepth = input.requestedDepth ?? 0;
  const availableSlots = Math.max(0, maxAgents - input.activeAgents);

  if (input.mode === 'recursive-child' || input.mode === 'plan-auto') {
    if (!recursionEnabled) {
      return {
        allowed: false,
        reason: 'recursive orchestration is disabled',
        maxAgents,
        activeAgents: input.activeAgents,
        availableSlots,
        requestedDepth,
        maxDepth,
        mode: input.mode,
      };
    }
  }

  if (input.mode === 'recursive-child' && requestedDepth > maxDepth) {
    return {
      allowed: false,
      reason: `requested depth ${requestedDepth} exceeds configured recursion depth ${maxDepth}`,
      maxAgents,
      activeAgents: input.activeAgents,
      availableSlots,
      requestedDepth,
      maxDepth,
      mode: input.mode,
    };
  }

  if (availableSlots <= 0) {
    return {
      allowed: false,
      reason: `agent capacity reached (${input.activeAgents}/${maxAgents})`,
      maxAgents,
      activeAgents: input.activeAgents,
      availableSlots,
      requestedDepth,
      maxDepth,
      mode: input.mode,
    };
  }

  return {
    allowed: true,
    maxAgents,
    activeAgents: input.activeAgents,
    availableSlots,
    requestedDepth,
    maxDepth,
    mode: input.mode,
  };
}
