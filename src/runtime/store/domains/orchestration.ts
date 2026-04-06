/**
 * Orchestration domain state — task graphs, node lifecycles, and bounded
 * recursive execution telemetry for higher-level worker coordination.
 */

import type { OrchestrationTaskContract } from '../../events/orchestration.ts';

export type OrchestrationMode =
  | 'single-worker'
  | 'parallel-workers'
  | 'review-loop'
  | 'graph-execute';

export type OrchestrationNodeRole =
  | 'planner'
  | 'engineer'
  | 'reviewer'
  | 'fixer'
  | 'verifier'
  | 'researcher'
  | 'integrator';

export type OrchestrationNodeState =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type OrchestrationGraphState =
  | 'planning'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface OrchestrationNodeRecord {
  id: string;
  title: string;
  role: OrchestrationNodeRole;
  status: OrchestrationNodeState;
  parentNodeId?: string;
  childNodeIds: string[];
  dependencyNodeIds: string[];
  taskId?: string;
  agentId?: string;
  latestMessage?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  contract?: OrchestrationTaskContract;
}

export interface OrchestrationGraphRecord {
  id: string;
  title: string;
  mode: OrchestrationMode;
  status: OrchestrationGraphState;
  nodeOrder: string[];
  nodes: Map<string, OrchestrationNodeRecord>;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastRecursionGuard?: {
    depth: number;
    activeAgents: number;
    reason: string;
    nodeId?: string;
    triggeredAt: number;
  };
}

export interface OrchestrationDomainState {
  revision: number;
  lastUpdatedAt: number;
  source: string;
  graphs: Map<string, OrchestrationGraphRecord>;
  activeGraphIds: string[];
  totalGraphs: number;
  totalCompletedGraphs: number;
  totalFailedGraphs: number;
  recursionGuardTrips: number;
}

export function createInitialOrchestrationState(): OrchestrationDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    graphs: new Map(),
    activeGraphIds: [],
    totalGraphs: 0,
    totalCompletedGraphs: 0,
    totalFailedGraphs: 0,
    recursionGuardTrips: 0,
  };
}
