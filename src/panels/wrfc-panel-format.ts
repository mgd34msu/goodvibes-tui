import { truncateDisplay } from '../utils/terminal-width.ts';
import type { WrfcState, Constraint, ConstraintFinding } from '@pellux/goodvibes-sdk/platform/agents';
import { DEFAULT_PANEL_PALETTE, extendPalette } from './polish.ts';

// ---------------------------------------------------------------------------
// Colour palette + formatting helpers for the WRFC panel.
//
// Extracted from wrfc-panel.ts to keep that module under the architecture
// line-count cap. Leaf module (only polish + terminal-width + sdk types); the
// panel re-exports the public helpers so ./wrfc-panel.ts stays their import site.
// ---------------------------------------------------------------------------
export const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  // WRFC state-machine colours (domain status -- no shared equivalent)
  passed:     '#22c55e', // green
  failed:     '#ef4444', // red
  reviewing:  '#eab308', // yellow
  engineering:'#22d3ee', // cyan
  fixing:     '#f97316', // orange
  pending:    '#6b7280', // grey
  gating:     '#a78bfa', // violet
  committing: '#38bdf8', // sky
  integrating:'#818cf8', // indigo

  // Issue-severity ramp (domain -- no shared equivalent)
  issueCrit:  '#ef4444',
  issueMaj:   '#f97316',
  issueMin:   '#eab308',
  issueSug:   '#6b7280',

  // Selection + divider chrome with no shared equivalent
  selected:   '#1e40af', // selection bg
  selectedFg: '#f8fafc',
  border:     '#334155',
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
    return { tag: '[UNV]', fg: C.dim, dim: true };
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
