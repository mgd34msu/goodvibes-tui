/**
 * PermissionEvent — discriminated union covering all permission evaluation events.
 *
 * Covers permission evaluation events for the runtime event bus.
 */

export type PermissionEvent =
  /** A tool call is requesting permission evaluation. */
  | {
      type: 'PERMISSION_REQUESTED';
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      category: string;
      classification?: string;
      riskLevel?: string;
      summary?: string;
      reasons?: readonly string[];
    }
  /** Permission rules have been collected from all sources. */
  | { type: 'RULES_COLLECTED'; callId: string; tool: string; ruleCount: number }
  /** Tool arguments have been normalised for policy evaluation. */
  | { type: 'INPUT_NORMALIZED'; callId: string; tool: string }
  /** Static policy rules have been evaluated. */
  | { type: 'POLICY_EVALUATED'; callId: string; tool: string; result: 'allow' | 'deny' | 'unknown' }
  /** Trust mode (yolo/normal/restricted) has been evaluated. */
  | { type: 'MODE_EVALUATED'; callId: string; tool: string; mode: string; result: 'allow' | 'deny' | 'unknown' }
  /** Session-level overrides (always-allow list) have been evaluated. */
  | { type: 'SESSION_OVERRIDE_EVALUATED'; callId: string; tool: string; overrideApplied: boolean }
  /** Safety checks (path traversal, sandbox escapes, etc.) have been run. */
  | { type: 'SAFETY_CHECKED'; callId: string; tool: string; safe: boolean; warnings: string[] }
  /** Final permission decision has been emitted. */
  | {
      type: 'DECISION_EMITTED';
      callId: string;
      tool: string;
      approved: boolean;
      source: string;
      sourceLayer?: string;
      persisted?: boolean;
      reasonCode?: string;
      classification?: string;
      riskLevel?: string;
      summary?: string;
    };

/** All permission event type literals as a union. */
export type PermissionEventType = PermissionEvent['type'];
