import { truncateDisplay } from '../utils/terminal-width.ts';
import type { WrfcState, Constraint, ConstraintFinding } from '@pellux/goodvibes-sdk/platform/agents';
import { DEFAULT_PANEL_PALETTE, extendPalette } from './polish.ts';
import { activeTokens } from '../renderer/theme.ts';

// ---------------------------------------------------------------------------
// Colour palette + formatting helpers for the WRFC panel.
//
// Extracted from wrfc-panel.ts to keep that module under the architecture
// line-count cap. Leaf module (only polish + terminal-width + sdk types); the
// panel re-exports the public helpers so ./wrfc-panel.ts stays their import site.
// ---------------------------------------------------------------------------
export const C = extendPalette(DEFAULT_PANEL_PALETTE, () => {
  const p = activeTokens();
  return {
    // WRFC state-machine colours (domain status mapped onto theme tokens)
    passed:     p.success,
    failed:     p.error,
    reviewing:  p.warning,
    engineering:p.primary,
    fixing:     p.blocked,
    pending:    p.textMuted,
    gating:     p.secondary,
    committing: p.info,
    integrating:p.accent,

    // Issue-severity ramp
    issueCrit:  p.error,
    issueMaj:   p.blocked,
    issueMin:   p.warning,
    issueSug:   p.textMuted,

    // Selection + divider chrome
    selected:   p.backgroundSelected,
    selectedFg: p.selectedListItemText,
    border:     p.borderSubtle,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SPARKLINE_CHARS = '._-:=+*#';

export function sparkline(scores: number[], maxScore = 10): string {
  if (scores.length === 0) return '';
  return scores
    .map(s => {
      const ratio = Math.max(0, Math.min(1, s / maxScore));
      const idx   = Math.round(ratio * (SPARKLINE_CHARS.length - 1));
      return SPARKLINE_CHARS[idx];
    })
    .join('');
}

export function stateColor(state: WrfcState): string {
  switch (state) {
    case 'passed':          return C.passed;
    case 'failed':          return C.failed;
    case 'reviewing':       return C.reviewing;
    case 'engineering':     return C.engineering;
    case 'fixing':          return C.fixing;
    case 'gating':
    case 'awaiting_gates':  return C.gating;
    case 'committing':      return C.committing;
    case 'integrating':     return C.integrating;
    default:                return C.pending;
  }
}

export function stateLabel(state: WrfcState): string {
  switch (state) {
    case 'engineering':    return 'ENG';
    case 'reviewing':      return 'REV';
    case 'fixing':         return 'FIX';
    case 'gating':         return 'GATE';
    case 'awaiting_gates': return 'WAIT';
    case 'committing':     return 'COMMIT';
    case 'integrating':    return 'INTG';
    case 'passed':         return 'PASS';
    case 'failed':         return 'FAIL';
    default:               return 'PEND';
  }
}

export function issueColor(severity: string): string {
  switch (severity) {
    case 'critical': return C.issueCrit;
    case 'major':    return C.issueMaj;
    case 'minor':    return C.issueMin;
    default:         return C.issueSug;
  }
}

export function issuePrefix(severity: string): string {
  switch (severity) {
    case 'critical': return '[CRIT] ';
    case 'major':    return '[MAJR] ';
    case 'minor':    return '[MINR] ';
    default:         return '[SUGG] ';
  }
}

export function truncate(s: string, max: number): string {
  return truncateDisplay(s, max);
}

// ---------------------------------------------------------------------------
// Constraint helpers
// ---------------------------------------------------------------------------

/**
 * Returns display tag, foreground colour, and dim flag for a single constraint
 * based on whether a reviewer finding exists for it.
 */
export function constraintStatusMarker(
  constraint: Constraint,
  findings: ConstraintFinding[] | undefined,
): { tag: string; fg: string; dim: boolean } {
  const finding = findings?.find(f => f.constraintId === constraint.id);
  if (!finding) {
    return { tag: '[UNV]', fg: C.dim, dim: false };
  }
  if (finding.satisfied) {
    return { tag: '[SAT]', fg: C.good, dim: false };
  }
  // Unsatisfied, use severity to pick colour and tag text
  const sev = finding.severity ?? 'major';
  let sevTag: string;
  let fg: string;
  switch (sev) {
    case 'critical': sevTag = '[UNS CRIT]';  fg = C.issueCrit; break;
    case 'minor':    sevTag = '[UNS MINOR]'; fg = C.issueMin;  break;
    default:         sevTag = '[UNS MAJOR]'; fg = C.issueMaj;  break;
  }
  return { tag: sevTag, fg, dim: false };
}
