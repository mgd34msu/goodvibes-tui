/**
 * OpsEvent — discriminated union covering all operator control plane events.
 *
 * These events are emitted when the operator intervenes in task or agent
 * lifecycle via the /ops command or Ctrl+O panel. Every intervention emits
 * an audit event with a reason code for traceability.
 */

/** Reason codes for operator interventions. */
export type OpsInterventionReason =
  | 'user_requested'        // Operator explicitly issued the command
  | 'ops_cancel'            // /ops task cancel
  | 'ops_pause'             // /ops task pause
  | 'ops_resume'            // /ops task resume
  | 'ops_retry'             // /ops task retry
  | 'ops_agent_cancel';     // /ops agent cancel

export type OpsEvent =
  /** Context usage crossed a warning threshold. */
  | {
      type: 'OPS_CONTEXT_WARNING';
      usage: number;
      threshold: number;
    }
  /** Cache hit-rate and token metrics snapshot. */
  | {
      type: 'OPS_CACHE_METRICS';
      hitRate: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalInputTokens: number;
      turns: number;
    }
  /** Helper-model cumulative usage snapshot. */
  | {
      type: 'OPS_HELPER_USAGE';
      inputTokens: number;
      outputTokens: number;
      calls: number;
    }
  /** Operator cancelled a running or queued task. */
  | {
      type: 'OPS_TASK_CANCELLED';
      taskId: string;
      reason: OpsInterventionReason;
      note?: string;
    }
  /** Operator paused a running task (transitions to blocked). */
  | {
      type: 'OPS_TASK_PAUSED';
      taskId: string;
      reason: OpsInterventionReason;
      note?: string;
    }
  /** Operator resumed a blocked task. */
  | {
      type: 'OPS_TASK_RESUMED';
      taskId: string;
      reason: OpsInterventionReason;
      note?: string;
    }
  /** Operator retried a failed or cancelled task. */
  | {
      type: 'OPS_TASK_RETRIED';
      taskId: string;
      reason: OpsInterventionReason;
      note?: string;
    }
  /** Operator cancelled a running agent. */
  | {
      type: 'OPS_AGENT_CANCELLED';
      agentId: string;
      reason: OpsInterventionReason;
      note?: string;
    }
  /** Audit trail entry for any ops intervention. */
  | {
      type: 'OPS_AUDIT';
      action: string;
      targetId: string;
      targetKind: 'task' | 'agent';
      reason: OpsInterventionReason;
      note?: string;
      outcome: 'success' | 'rejected' | 'error';
      errorMessage?: string;
    };

/** All ops event type literals as a union. */
export type OpsEventType = OpsEvent['type'];
