/**
 * SecurityEvent — discriminated union covering token scope and rotation audit events.
 *
 * These events are emitted by the ApiTokenAuditor during audit runs.
 * Consumers (diagnostics panel, ops handlers) subscribe to these to surface
 * security posture in the TUI and in operator alerts.
 */

export type SecurityEvent =
  /** A token was found to hold scopes beyond its policy's allowedScopes. */
  | {
      type: 'TOKEN_SCOPE_VIOLATION';
      tokenId: string;
      label: string;
      policyId: string;
      excessScopes: string[];
    }
  /** A token is approaching its rotation deadline (within warning threshold). */
  | {
      type: 'TOKEN_ROTATION_WARNING';
      tokenId: string;
      label: string;
      msUntilDue: number;
      dueAt: number;
      ageMs: number;
    }
  /** A token is past its rotation deadline and has not been rotated. */
  | {
      type: 'TOKEN_ROTATION_EXPIRED';
      tokenId: string;
      label: string;
      ageMs: number;
      cadenceMs: number;
      dueAt: number;
    }
  /** A token has been blocked by the auditor in managed mode. */
  | {
      type: 'TOKEN_BLOCKED';
      tokenId: string;
      label: string;
      reason: 'scope_violation' | 'rotation_overdue' | 'scope_violation_and_rotation_overdue';
    };

/** All security event type literals as a union. */
export type SecurityEventType = SecurityEvent['type'];
