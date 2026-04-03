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
  /** Causal chain from root cause to terminal state (root cause first). */
  readonly causalChain: readonly CausalChainEntry[];
  /** Cascade events that contributed to or were triggered by this failure. */
  readonly cascadeEvents: readonly CausalChainEntry[];
  /** Jump links to replay and related diagnostics. */
  readonly jumpLinks: readonly ForensicsJumpLink[];
}
