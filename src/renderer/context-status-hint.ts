/**
 * Context status hint — TASK-056.
 *
 * Produces a short, dismissible status-line hint when the session maintenance
 * level indicates compaction is recommended or repair is needed.  The hint is
 * passive and non-blocking: it appears in the footer status row and disappears
 * once the pressure signal clears.
 *
 * Honest wording policy:
 *  - suggest-compact → describes the situation and offers /compact
 *  - needs-repair    → names the failure state honestly without alarming
 *  - compacting      → shows in-progress text so the user knows something is running
 *  - watch           → no hint (not yet actionable)
 *  - stable/unknown  → no hint
 */

import type { PanelSessionMaintenanceLevel } from '../panels/session-maintenance.ts';

export interface ContextStatusHintOptions {
  /** Maintenance level from evaluateSessionMaintenance. */
  readonly level: PanelSessionMaintenanceLevel;
  /** Whether auto-compaction is active (threshold > 0 in config). */
  readonly autoCompactEnabled: boolean;
  /** Current usage percent 0–100. */
  readonly usagePct: number;
}

/**
 * Build the passive status-line hint text for context pressure.
 *
 * Returns null when no hint is warranted (stable / watch / unknown).
 * The caller renders this as a dim informational line — no prompts, no
 * blocking, no confirmation required.
 */
export function buildContextStatusHint(options: ContextStatusHintOptions): string | null {
  const { level, autoCompactEnabled, usagePct } = options;

  switch (level) {
    case 'needs-repair':
      return `  Context pressure critical (${usagePct}% used) — compaction needs attention. Run /compact or /health review.`;

    case 'suggest-compact':
      if (autoCompactEnabled) {
        return `  Context high (${usagePct}% used) — auto-compact will run before the next turn.`;
      }
      return `  Context high (${usagePct}% used) — run /compact to recover headroom.`;

    case 'compacting':
      return `  Compacting context — freeing headroom...`;

    default:
      return null;
  }
}
