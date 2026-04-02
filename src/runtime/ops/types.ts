/**
 * Type definitions for operational runbooks.
 *
 * Playbooks are machine-readable structured runbooks consumed by the
 * diagnostics panel and the ops registry. Each playbook describes
 * symptoms, diagnostic checks, resolution steps, and escalation criteria.
 */

// ── Diagnostic check ─────────────────────────────────────────────────────────

/** Severity level of a diagnostic check result. */
export type DiagnosticSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Result of running a single diagnostic check. */
export interface DiagnosticCheckResult {
  /** Whether the check passed. */
  readonly passed: boolean;
  /** Human-readable summary of the check outcome. */
  readonly summary: string;
  /** Optional structured context for the diagnostics panel. */
  readonly context?: Record<string, string | number | boolean>;
  /** Severity when the check fails. */
  readonly severity: DiagnosticSeverity;
}

/**
 * A single diagnostic check.
 *
 * The `run` function must not throw — it should catch all internal errors
 * and return them as a failing check result.
 */
export interface DiagnosticCheck {
  /** Unique identifier for this check (e.g. 'queue.overflow'). */
  readonly id: string;
  /** Short human-readable label. */
  readonly label: string;
  /** Longer description of what this check verifies. */
  readonly description: string;
  /** Execute the check and return a result. Never throws. */
  readonly run: () => Promise<DiagnosticCheckResult>;
}

// ── Playbook step ─────────────────────────────────────────────────────────────

/** Category of action required for a step. */
export type PlaybookStepKind =
  | 'command'    // Execute a shell/runtime command
  | 'config'     // Modify configuration
  | 'observe'    // Inspect logs/metrics/state
  | 'wait'       // Wait for a condition
  | 'escalate';  // Escalate to human or automated alert

/** A single resolution step within a playbook. */
export interface PlaybookStep {
  /** Step number (1-indexed). */
  readonly step: number;
  /** Short title for display in the diagnostics panel. */
  readonly title: string;
  /** Detailed action description. */
  readonly action: string;
  /** Category of this step. */
  readonly kind: PlaybookStepKind;
  /**
   * For 'command' steps: the command or API call to run.
   * For 'config' steps: the config key and value to set.
   * For 'wait' steps: condition description.
   * Optional for 'observe' and 'escalate' steps.
   */
  readonly command?: string;
  /** Expected outcome if the step succeeds. */
  readonly expectedOutcome?: string;
  /** Whether this step can be safely automated. */
  readonly automatable: boolean;
}

// ── Playbook ──────────────────────────────────────────────────────────────────

/** A complete operational runbook. */
export interface Playbook {
  /** Unique identifier (e.g. 'stuck-turn'). */
  readonly id: string;
  /** Short human-readable name. */
  readonly name: string;
  /** Description of what this playbook addresses. */
  readonly description: string;
  /**
   * Observable symptoms that suggest this playbook applies.
   * Used by the diagnostics panel to surface relevant runbooks.
   */
  readonly symptoms: string[];
  /**
   * Diagnostic checks to run when this playbook is triggered.
   * Results are displayed in the diagnostics panel.
   */
  readonly checks: DiagnosticCheck[];
  /** Ordered resolution steps. */
  readonly steps: PlaybookStep[];
  /**
   * Conditions that indicate the issue has escalated beyond
   * automated remediation and requires human intervention.
   */
  readonly escalationCriteria: string[];
  /** Tags for filtering/categorisation in the diagnostics panel. */
  readonly tags: string[];
}

// ── Playbook registry ─────────────────────────────────────────────────────────

/** Registry entry wrapping a playbook with metadata. */
export interface PlaybookRegistryEntry {
  readonly playbook: Playbook;
  /** Version string (semver-like, e.g. '1.0.0'). */
  readonly version: string;
  /** ISO timestamp of when this playbook was last updated. */
  readonly updatedAt: string;
}

/** A map of playbook IDs to their registry entries. */
export type PlaybookRegistry = Map<string, PlaybookRegistryEntry>;
