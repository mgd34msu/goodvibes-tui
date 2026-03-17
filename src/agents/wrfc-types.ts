import type { CompletionReport, ReviewerReport } from './completion-report.ts';

/** WRFC chain lifecycle states. */
export type WrfcState =
  | 'pending'
  | 'engineering'
  | 'reviewing'
  | 'fixing'
  | 'gating'
  | 'passed'
  | 'failed'
  | 'committing';

/** A single WRFC chain instance. */
export interface WrfcChain {
  id: string;
  state: WrfcState;
  task: string;
  engineerAgentId?: string;
  reviewerAgentId?: string;
  fixerAgentId?: string;
  /** All agent IDs involved in this chain (for worktree cleanup). */
  allAgentIds: string[];
  engineerReport?: CompletionReport;
  reviewerReport?: ReviewerReport;
  fixAttempts: number;
  reviewCycles: number;
  gateResults?: QualityGateResult[];
  createdAt: number;
  completedAt?: number;
  parentChainId?: string;
  /** Whether quality gates passed. Only meaningful when state is 'passed'. */
  gatesPassed?: boolean;
  error?: string;
}

/** Quality gate definition. */
export interface QualityGate {
  name: string;
  command: string;
  enabled: boolean;
}

/** Result of running a quality gate. */
export interface QualityGateResult {
  gate: QualityGate['name'];
  passed: boolean;
  output: string;
  durationMs: number;
}
