/**
 * Failure Forensics types — core data model for automatic failure reports.
 *
 * A FailureReport is generated automatically whenever a task or turn reaches
 * a terminal failure state. It captures the causal chain derived from phase
 * timings, cascade events, and stop reasons so failures can be classified
 * without manual log spelunking.
 */

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Broad failure category used as the primary classification label.
 * Designed for machine-readable filtering and auto-triage.
 */
export type FailureClass =
  | 'llm_error'          // LLM API call failed (network, 5xx, timeout)
  | 'tool_failure'       // Tool execution failed or was denied
  | 'permission_denied'  // Permission check blocked a tool call
  | 'cascade_failure'    // Health cascade propagated into this entity
  | 'turn_timeout'       // Turn exceeded configured timeout
  | 'cancelled'          // Entity was explicitly cancelled
  | 'max_tokens'         // Model stopped due to token limit
  | 'compaction_error'   // Context compaction failed
  | 'unknown';           // Could not be auto-classified

// ── Phase timing ─────────────────────────────────────────────────────────────

/**
 * Timing record for a single named phase within a turn or task.
 * Used to reconstruct execution timelines in the forensics panel.
 */
export interface PhaseTimingEntry {
  /** Phase name (e.g. 'PREFLIGHT', 'STREAM', 'TOOL_BATCH', 'POST_HOOKS'). */
  readonly phase: string;
  /** Epoch ms when the phase started. */
  readonly startedAt: number;
  /** Epoch ms when the phase ended (undefined if still in progress at report time). */
  readonly endedAt?: number;
  /** Duration in ms (undefined if still in progress). */
  readonly durationMs?: number;
  /** Whether this phase completed successfully. */
  readonly success: boolean;
  /** Error message if the phase failed. */
  readonly error?: string;
}

export type PhaseLedgerOutcome = 'in_progress' | 'succeeded' | 'failed' | 'cancelled';

export interface PhaseLedgerEntry {
  readonly seq: number;
  readonly domain: 'turn' | 'task';
  readonly phase: string;
  readonly enterEventType: string;
  readonly enteredAt: number;
  readonly exitEventType?: string;
  readonly exitedAt?: number;
  readonly durationMs?: number;
  readonly outcome: PhaseLedgerOutcome;
  readonly error?: string;
}

// ── Causal chain ─────────────────────────────────────────────────────────────

/**
 * A single link in the failure's causal chain.
 * Ordered from root cause to terminal state.
 */
export interface CausalChainEntry {
  /** Monotonic sequence within this report. */
  readonly seq: number;
  /** Epoch ms when this causal event occurred. */
  readonly ts: number;
  /** Human-readable description of this causal event. */
  readonly description: string;
  /** Event type that produced this link (from the event bus). */
  readonly sourceEventType: string;
  /** Optional structured context (tool name, error code, domain, etc.). */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
  /** Whether this link is the diagnosed root cause. */
  readonly isRootCause: boolean;
}

// ── Jump links ────────────────────────────────────────────────────────────────

/**
 * A navigable reference linking a forensics report to a related panel or action.
 * The TUI renders these as actionable jump targets.
 */
export interface ForensicsJumpLink {
  /**
   * Label displayed in the panel (e.g. 'Replay turn', 'Open health dashboard',
   * 'View task in ops-control').
   */
  readonly label: string;
  /**
   * Destination kind determines how the TUI navigates.
   * - 'panel': open a named panel
   * - 'command': execute a slash command
   */
  readonly kind: 'panel' | 'command';
  /** Panel ID or slash command string (without leading slash). */
  readonly target: string;
  /** Optional arguments (e.g. task ID or turn ID to pre-select). */
  readonly args?: string;
}

// ── Failure report ────────────────────────────────────────────────────────────

/**
 * Complete failure forensics report.
 * Generated automatically on terminal failure states.
 */
export interface FailureReport {
  /** Unique report identifier (short hex, derived from trace ID). */
  readonly id: string;
  /** Full trace ID of the originating event envelope. */
  readonly traceId: string;
  /** Session ID where the failure occurred. */
  readonly sessionId: string;
  /** Epoch ms when the report was generated. */
  readonly generatedAt: number;
  /** Auto-classified failure category. */
  readonly classification: FailureClass;
  /** Human-readable summary of the failure for the panel header. */
  readonly summary: string;
  /** Stop reason from the LLM provider (if applicable). */
  readonly stopReason?: string;
  /** Terminal error message (most specific error available). */
  readonly errorMessage?: string;
  /** Task ID if this is a task failure. */
  readonly taskId?: string;
  /** Turn ID if this is a turn failure. */
  readonly turnId?: string;
  /** Agent ID if this failure was associated with a specific agent. */
  readonly agentId?: string;
  /** Ordered phase timings from the originating turn or task execution. */
  readonly phaseTimings: readonly PhaseTimingEntry[];
  /** Ordered phase transition ledger for explicit runtime reconstruction. */
  readonly phaseLedger: readonly PhaseLedgerEntry[];
  /** Causal chain from root cause to terminal state (root cause first). */
  readonly causalChain: readonly CausalChainEntry[];
  /** Cascade events that contributed to or were triggered by this failure. */
  readonly cascadeEvents: readonly CausalChainEntry[];
  /** Permission request and decision evidence correlated to this failure. */
  readonly permissionEvidence: readonly PermissionEvidenceEntry[];
  /** Tool budget and timeout breaches correlated to this failure. */
  readonly budgetBreaches: readonly BudgetBreachEvidence[];
  /** Jump links to replay and related diagnostics. */
  readonly jumpLinks: readonly ForensicsJumpLink[];
}

// ── Export bundle ───────────────────────────────────────────────────────────

export interface PermissionEvidenceEntry {
  readonly callId: string;
  readonly tool: string;
  readonly requestedAt?: number;
  readonly decidedAt?: number;
  readonly durationMs?: number;
  readonly approved?: boolean;
  readonly source?: string;
  readonly reasonCode?: string;
  readonly classification?: string;
  readonly riskLevel?: string;
  readonly summary?: string;
}

export interface BudgetBreachEvidence {
  readonly callId: string;
  readonly tool: string;
  readonly eventType: 'BUDGET_EXCEEDED_MS' | 'BUDGET_EXCEEDED_TOKENS' | 'BUDGET_EXCEEDED_COST';
  readonly phase: string;
  readonly ts: number;
  readonly meta: Readonly<Record<string, number>>;
}

export interface ForensicsReplayMismatchEvidence {
  readonly rev: number;
  readonly kind: string;
  readonly description: string;
  readonly eventName?: string;
  readonly ownerDomain?: string;
  readonly failureMode?: string;
  readonly relatedTurnId?: string;
}

export interface ForensicsReplayTurnEvidence {
  readonly turnId: string;
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  readonly terminalEvent: 'PREFLIGHT_FAIL' | 'TURN_COMPLETED' | 'TURN_ERROR' | 'TURN_CANCEL';
  readonly startedRev?: number;
  readonly terminalRev: number;
  readonly stopReason?: string;
  readonly message?: string;
}

export interface ForensicsReplayEvidence {
  readonly status: 'unavailable' | 'not_loaded' | 'available';
  readonly runId?: string;
  readonly currentRev?: number;
  readonly totalRevisions?: number;
  readonly mismatchCount: number;
  readonly mismatches: readonly ForensicsReplayMismatchEvidence[];
  readonly relatedMismatches: readonly ForensicsReplayMismatchEvidence[];
  readonly mismatchBreakdown: {
    readonly byKind: Readonly<Record<string, number>>;
    readonly byFailureMode: Readonly<Record<string, number>>;
    readonly byOwnerDomain: Readonly<Record<string, number>>;
  };
  readonly turnSummaries: readonly ForensicsReplayTurnEvidence[];
  readonly matchingTurnSummary?: ForensicsReplayTurnEvidence;
}

export interface ForensicsEvidenceSummary {
  readonly rootCause?: string;
  readonly terminalPhase?: string;
  readonly terminalOutcome?: PhaseLedgerOutcome;
  readonly phaseCount: number;
  readonly causalCount: number;
  readonly cascadeCount: number;
  readonly permissionDecisionCount: number;
  readonly deniedPermissionCount: number;
  readonly budgetBreachCount: number;
  readonly slowPhases: readonly string[];
  readonly jumpLinkCount: number;
  readonly relatedIds: {
    readonly turnId?: string;
    readonly taskId?: string;
    readonly agentId?: string;
  };
}

export interface ForensicsBundle {
  readonly schemaVersion: 'v1';
  readonly exportedAt: number;
  readonly report: FailureReport;
  readonly evidence: ForensicsEvidenceSummary;
  readonly replay: ForensicsReplayEvidence;
}
