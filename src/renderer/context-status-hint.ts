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
 *
 * Evidence policy (why the guards below exist)
 * ────────────────────────────────────────────
 * A fresh boot printed "Context high (0% used) — auto-compact will run before
 * the next turn." before a single token had been counted. The evaluator was
 * not at fault: `evaluateSessionMaintenance` reaches 'suggest-compact' when
 * `remainingTokens <= 15_000`, and at boot the resolved window is still the
 * SDK's DEFAULT_CONTEXT_WINDOW fallback (8,192 — the "8.2k" the footer meter
 * shows before the real window arrives), so 8,192 free tokens tripped that
 * rule instantly. Arithmetically consistent; factually false. No context had
 * been consumed and no auto-compact was imminent.
 *
 * So a pressure claim here has to be backed by evidence, not merely by a
 * level:
 *   1. Usage has actually been measured. At zero tokens consumed there is no
 *      pressure to report, whatever the window says.
 *   2. The window is one the provider vouched for, not the fallback constant.
 *      A model whose real window happens to equal the fallback is
 *      indistinguishable from "not resolved yet", and in that ambiguity
 *      staying quiet is the honest choice — the Tokens panel and /context
 *      still show the real numbers either way.
 * Neither guard touches 'compacting', which reports work that is provably
 * running rather than a prediction about headroom.
 */

import { DEFAULT_CONTEXT_WINDOW } from '@pellux/goodvibes-sdk/platform/providers';
import type { PanelSessionMaintenanceLevel } from '../panels/session-maintenance.ts';

interface ContextStatusHintOptions {
  /** Maintenance level from evaluateSessionMaintenance. */
  readonly level: PanelSessionMaintenanceLevel;
  /** Whether auto-compaction is active (threshold > 0 in config). */
  readonly autoCompactEnabled: boolean;
  /** Current usage percent 0–100. */
  readonly usagePct: number;
  /** Tokens actually counted so far this session (orchestrator.lastInputTokens). */
  readonly currentTokens: number;
  /** The resolved context window the usage percent was computed against. */
  readonly contextWindow: number;
}

/**
 * Whether the numbers backing a pressure claim are real yet: usage has been
 * counted, and the window is not the provider fallback the app boots with.
 */
function hasRealContextNumbers(
  options: Pick<ContextStatusHintOptions, 'currentTokens' | 'contextWindow' | 'usagePct'>,
): boolean {
  if (options.currentTokens <= 0 || options.usagePct <= 0) return false;
  if (options.contextWindow <= 0 || options.contextWindow === DEFAULT_CONTEXT_WINDOW) return false;
  return true;
}

/**
 * Build the passive status-line hint text for context pressure.
 *
 * Returns null when no hint is warranted (stable / watch / unknown), and also
 * when a pressure level is not yet backed by real numbers — see the evidence
 * policy above. The caller renders this as a dim informational line — no
 * prompts, no blocking, no confirmation required.
 */
function buildContextStatusHint(options: ContextStatusHintOptions): string | null {
  const { level, autoCompactEnabled, usagePct } = options;

  switch (level) {
    case 'needs-repair':
      if (!hasRealContextNumbers(options)) return null;
      return `  Context pressure critical (${usagePct}% used) — compaction needs attention. Run /compact or /health review.`;

    case 'suggest-compact':
      if (!hasRealContextNumbers(options)) return null;
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

/**
 * Evaluate session maintenance and turn it into the footer hint in one call.
 * The ONE public seam of this module, deliberately: the guards above need the
 * exact `currentTokens` / `contextWindow` the evaluator was handed, and a
 * caller free to pass different values to each half is how they drift apart.
 */
export function resolveContextStatusHint(input: {
  readonly evaluate: (args: { readonly currentTokens: number; readonly contextWindow: number }) => {
    readonly level: PanelSessionMaintenanceLevel;
    readonly autoCompactEnabled: boolean;
    readonly usagePct: number;
  };
  readonly currentTokens: number;
  readonly contextWindow: number;
}): string | null {
  const status = input.evaluate({ currentTokens: input.currentTokens, contextWindow: input.contextWindow });
  return buildContextStatusHint({
    level: status.level,
    autoCompactEnabled: status.autoCompactEnabled,
    usagePct: status.usagePct,
    currentTokens: input.currentTokens,
    contextWindow: input.contextWindow,
  });
}
