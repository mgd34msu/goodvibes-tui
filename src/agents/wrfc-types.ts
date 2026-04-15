import type { CompletionReport, ReviewerReport } from '@pellux/goodvibes-sdk/platform/agents/completion-report';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools/agent/index';

/** Queued chain waiting to start. */
export interface QueuedChain {
  record: AgentRecord;
  queuedAt: number;
}

/** WRFC chain lifecycle states. */
export type WrfcState =
  | 'pending'
  | 'engineering'
  | 'reviewing'
  | 'fixing'
  | 'awaiting_gates'
  | 'gating'
  | 'passed'
  | 'failed'
  | 'committing';

/** A single WRFC chain instance. */
export interface WrfcChain {
  id: string;
  state: WrfcState;
  task: string;
  currentNodeId?: string;
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
  /** Fingerprint of gate failures: used for same-error detection across chained chains. */
  gateFailureFingerprint?: string;
  /** How many gate-failure retry cycles deep this chain is. 0 = original chain. */
  gateRetryDepth: number;
  /** Review scores history — used to detect regression (2 consecutive below initial). */
  reviewScores: number[];
  error?: string;
  /** Buffered agent completion — set when agent finishes while chain is still queued/pending. */
  bufferedCompletion?: { agentId: string; fullOutput?: string };
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
