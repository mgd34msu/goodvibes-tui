import type { Line } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import type { WrfcChain, WrfcState, QualityGateResult } from '@pellux/goodvibes-sdk/platform/agents';
import type { Constraint, ConstraintFinding } from '@pellux/goodvibes-sdk/platform/agents';
import type { WrfcController } from '@pellux/goodvibes-sdk/platform/agents';
import { BasePanel } from './base-panel.ts';
import type { WorkflowEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import {
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelWorkspaceSection,
  buildSelectablePanelLine,
  buildStyledPanelLine,
  buildEmptyState,
} from './polish.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import {
  type ConfirmState,
  handleConfirmInput,
} from './confirm-state.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Chains in non-terminal state with no event for this long are shown as STALLED. */
const STALL_THRESHOLD_MS = 5 * 60 * 1000;

/** Terminal states — chains in these states cannot be resumed or cancelled. */
const TERMINAL_STATES: readonly WrfcState[] = ['passed', 'failed'];

/**
 * States from which resume is permitted. These mirror the states
 * WrfcController.resumeChain() actually recovers from: 'pending' (awaiting
 * retry / start engineering), 'reviewing' and 'fixing' (re-spawn the
 * interrupted child), and 'awaiting_gates' (re-run gates). resumeChain no-ops
 * safely when a child is still running, so offering resume for these states is
 * always safe — it is exactly the set an operator needs after a restart or a
 * STALLED chain.
 */
const RESUMABLE_STATES: readonly WrfcState[] = ['pending', 'reviewing', 'fixing', 'awaiting_gates'];

// ---------------------------------------------------------------------------
// Colour palette
// ---------------------------------------------------------------------------
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
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

function issueColor(severity: string): string {
  switch (severity) {
    case 'critical': return C.issueCrit;
    case 'major':    return C.issueMaj;
    case 'minor':    return C.issueMin;
    default:         return C.issueSug;
  }
}

function issuePrefix(severity: string): string {
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
  // Unsatisfied — use severity to pick colour and tag text
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

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
export interface WrfcPanelDeps {
  readonly controller: Pick<WrfcController, 'listChains' | 'resumeChain'>;
  /** Cancel the active agent for a chain by its ownerAgentId. Returns true if cancelled. */
  readonly cancelChain: (agentId: string) => boolean;
}

export class WrfcPanel extends BasePanel {
  private chains: WrfcChain[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private expandedChainIds = new Set<string>();
  private unsubscribers: Array<() => void> = [];
  /** Last event timestamp per chain id, for stall detection. */
  private lastEventAt = new Map<string, number>();
  /** Pending cancel confirmation: subject is the chain id to cancel. */
  private confirmCancel: ConfirmState<string> | null = null;
  /** Controller error seen after initialization (distinct from pre-init silence). */
  private controllerError: string | null = null;

  constructor(
    private readonly workflowEvents: UiEventFeed<WorkflowEvent>,
    private readonly deps: WrfcPanelDeps,
  ) {
    super('wrfc', 'WRFC', 'W', 'agent');
    this.subscribeToEvents();
    this.syncFromController();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  override onActivate(): void {
    super.onActivate();
    this.syncFromController();
  }

  override onDestroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  handleInput(key: string): boolean {
    // Confirm-cancel flow takes priority over all other keys.
    // Enter and y both confirm; n, escape both cancel; any other key is absorbed.
    if (this.confirmCancel) {
      const confirmResult = handleConfirmInput(this.confirmCancel, key);
      if (confirmResult === 'confirmed') {
        const chain = this.chains.find(c => c.id === this.confirmCancel!.subject);
        if (chain && !TERMINAL_STATES.includes(chain.state)) {
          this.deps.cancelChain(chain.ownerAgentId);
        }
        this.confirmCancel = null;
        this.markDirty();
        return true;
      }
      if (confirmResult === 'cancelled') {
        this.confirmCancel = null;
        this.markDirty();
      }
      // absorbed: confirm stays pending, key swallowed
      return true;
    }

    // Normal key dispatch.
    switch (key) {
      case 'up':    this.moveSelection(-1); return true;
      case 'down':  this.moveSelection(1);  return true;
      case 'return':
      case 'enter': this.toggleExpanded();  return true;
      case 'c':     this.beginCancelConfirm(); return true;
      case 'r':     this.doResume();           return true;
      default:      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
    const now = Date.now();
    const activeCount  = this.chains.filter(c => !TERMINAL_STATES.includes(c.state)).length;
    const passedCount  = this.chains.filter(c => c.state === 'passed').length;
    const failedCount  = this.chains.filter(c => c.state === 'failed').length;

    if (this.chains.length === 0) {
      const emptySections: PanelWorkspaceSection[] = [
        {
          lines: buildEmptyState(
            width,
            ' No WRFC chains yet',
            'WRFC chains appear here as review/fix cycles execute. Expanded rows show scores, gates, issues, and failure detail.',
            [],
            DEFAULT_PANEL_PALETTE,
          ),
        },
      ];
      if (this.controllerError) {
        emptySections.push({
          lines: [
            buildPanelLine(width, [
              [' controller: ', DEFAULT_PANEL_PALETTE.dim],
              [truncate(this.controllerError, width - 16), DEFAULT_PANEL_PALETTE.warn],
            ]),
          ],
        });
      }
      return buildPanelWorkspace(width, height, {
        title: ' WRFC Chain Monitor',
        intro: 'Track WRFC engineering, review, fixing, gating, and final chain outcomes.',
        sections: emptySections,
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const chainLines: Line[] = [];
    let selectedLineIndex = 0;
    for (let i = 0; i < this.chains.length; i++) {
      const chain      = this.chains[i];
      const isSelected = i === this.selectedIndex;
      const isExpanded = this.expandedChainIds.has(chain.id);
      const rowBg      = isSelected ? C.selected : '';
      const rowFg      = isSelected ? C.selectedFg : '';
      const stalled    = this.isStalled(chain, now);

      if (isSelected) selectedLineIndex = chainLines.length;
      chainLines.push(...this.renderChainRow(chain, width, isSelected, isExpanded, rowBg, rowFg, stalled));

      if (isExpanded) {
        chainLines.push(...this.renderChainDetail(chain, width, 12));
      }
    }

    const selectedChain = this.chains[this.selectedIndex];
    const selectedLines: Line[] = selectedChain
      ? [
          buildPanelLine(width, [
            [' State ', DEFAULT_PANEL_PALETTE.label],
            [stateLabel(selectedChain.state), stateColor(selectedChain.state)],
            ['   Task ', DEFAULT_PANEL_PALETTE.label],
            [truncate(selectedChain.task, Math.max(8, width - 24)), DEFAULT_PANEL_PALETTE.value],
          ]),
          buildPanelLine(width, [
            [' Reviews ', DEFAULT_PANEL_PALETTE.label],
            [String(selectedChain.reviewCycles), DEFAULT_PANEL_PALETTE.value],
            ['   Fixes ', DEFAULT_PANEL_PALETTE.label],
            [String(selectedChain.fixAttempts), DEFAULT_PANEL_PALETTE.value],
            ['   Scores ', DEFAULT_PANEL_PALETTE.label],
            [selectedChain.reviewScores.length > 0 ? selectedChain.reviewScores.map((score) => score.toFixed(0)).join(' -> ') : 'none', DEFAULT_PANEL_PALETTE.info],
          ]),
          ...(selectedChain.constraints.length > 0 ? [
            buildPanelLine(width, (() => {
              const total = selectedChain.constraints.length;
              const findings = selectedChain.reviewerReport?.constraintFindings;
              const satisfied = findings ? findings.filter(f => f.satisfied).length : 0;
              const satFg = !findings || findings.length === 0
                ? DEFAULT_PANEL_PALETTE.dim
                : satisfied === total ? C.good : C.bad;
              return [
                [' Constraints ', DEFAULT_PANEL_PALETTE.label],
                [`${satisfied} sat / ${total} total`, satFg],
              ] as Array<[string, string]>;
            })()),
          ] : []),
        ]
      : [];

    const summarySection: PanelWorkspaceSection = {
      title: 'Summary',
      lines: [
        buildPanelLine(width, [
          [' Active ', DEFAULT_PANEL_PALETTE.label],
          [String(activeCount), activeCount > 0 ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
          ['   Passed ', DEFAULT_PANEL_PALETTE.label],
          [String(passedCount), DEFAULT_PANEL_PALETTE.good],
          ['   Failed ', DEFAULT_PANEL_PALETTE.label],
          [String(failedCount), failedCount > 0 ? DEFAULT_PANEL_PALETTE.bad : DEFAULT_PANEL_PALETTE.dim],
        ]),
      ],
    };
    const selectedSection: PanelWorkspaceSection = {
      title: 'Selected',
      lines: selectedLines,
    };
    // Confirm-cancel overlay section.
    const confirmSection: PanelWorkspaceSection | null = this.confirmCancel ? {
      title: 'Confirm Cancel',
      lines: [
        buildPanelLine(width, [
          [' Cancel chain "', DEFAULT_PANEL_PALETTE.warn],
          [truncate(this.confirmCancel.label, Math.max(8, width - 32)), DEFAULT_PANEL_PALETTE.value],
          ['"?', DEFAULT_PANEL_PALETTE.warn],
        ]),
        buildPanelLine(width, [
          [' y', DEFAULT_PANEL_PALETTE.info], ['  confirm', DEFAULT_PANEL_PALETTE.dim],
          ['   Enter', DEFAULT_PANEL_PALETTE.info], ['  confirm', DEFAULT_PANEL_PALETTE.dim],
          ['   n / Esc', DEFAULT_PANEL_PALETTE.info], ['  cancel', DEFAULT_PANEL_PALETTE.dim],
        ]),
      ],
    } : null;

    // Footer: show resume-disabled reason for the selected chain.
    const selectedForFooter = this.chains[this.selectedIndex];
    const resumeReason = selectedForFooter ? this.resumeDisabledReason(selectedForFooter) : null;
    const footerLines: Line[] = [
      buildPanelLine(width, [
        [' Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim],
        ['   Enter', DEFAULT_PANEL_PALETTE.info],  [' expand',   DEFAULT_PANEL_PALETTE.dim],
        ['   c', DEFAULT_PANEL_PALETTE.info],      [' cancel',   DEFAULT_PANEL_PALETTE.dim],
        ['   r', resumeReason ? DEFAULT_PANEL_PALETTE.dim : DEFAULT_PANEL_PALETTE.info],
        [resumeReason ? ` resume (${resumeReason})` : ' resume', DEFAULT_PANEL_PALETTE.dim],
      ]),
    ];

    const chainsSection = resolveScrollablePanelSection(width, height, {
      intro: 'Track WRFC engineering, review, fixing, gating, and final chain outcomes.',
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summarySection],
      section: {
        title: 'Chains',
        scrollableLines: chainLines,
        selectedIndex: selectedLineIndex,
        scrollOffset: this.scrollOffset,
        minRows: 8,
      },
      afterSections: confirmSection
        ? [selectedSection, confirmSection]
        : [selectedSection],
    });
    this.scrollOffset = chainsSection.scrollOffset;
    const sections: PanelWorkspaceSection[] = [
      summarySection,
      chainsSection.section,
      selectedSection,
      ...(confirmSection ? [confirmSection] : []),
    ];

    // Controller error section (post-init only).
    if (this.controllerError) {
      sections.push({
        lines: [
          buildPanelLine(width, [
            [' controller: ', DEFAULT_PANEL_PALETTE.dim],
            [truncate(this.controllerError, width - 16), DEFAULT_PANEL_PALETTE.warn],
          ]),
        ],
      });
    }

    return buildPanelWorkspace(width, height, {
      title: ' WRFC Chain Monitor',
      intro: 'Track WRFC engineering, review, fixing, gating, and final chain outcomes.',
      sections,
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
    });
  }


  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------
  private renderChainRow(
    chain: WrfcChain,
    width: number,
    isSelected: boolean,
    isExpanded: boolean,
    bg: string,
    fg: string,
    stalled = false,
  ): Line[] {
    const stateCol   = stalled ? C.warn : stateColor(chain.state);
    const stateTag   = stalled
      ? ` STALLED`
      : ` ${stateLabel(chain.state).padEnd(6)}`;
    const arrow      = isExpanded ? '▾' : '▸';
    const chainIdShort = chain.id.slice(-6);
    const prefix     = ` ${arrow} [${chainIdShort}] `;
    const fixes      = chain.fixAttempts > 0 ? ` fix:${chain.fixAttempts}` : '';
    const cycles     = chain.reviewCycles > 0 ? ` rev:${chain.reviewCycles}` : '';
    const latestScore = chain.reviewScores.length > 0
      ? ` ${chain.reviewScores[chain.reviewScores.length - 1].toFixed(1)}/10`
      : '';
    const stalledBadge = stalled ? ' [STALLED]' : '';
    // Constraint badge: c:sat/total — only when constraints exist
    let constraintBadge = '';
    if (chain.constraints.length > 0) {
      const total = chain.constraints.length;
      const findings = chain.reviewerReport?.constraintFindings;
      const satisfied = findings ? findings.filter(f => f.satisfied).length : 0;
      constraintBadge = ` c:${satisfied}/${total}`;
    }
    const rightInfo  = `${stalledBadge}${latestScore}${fixes}${cycles}${constraintBadge} `;

    // Compute how much space the task text can use, then check if rightInfo fits.
    // If the terminal is narrow and rightInfo would overflow, omit it entirely
    // rather than producing corrupted layout.
    const usedWithoutTask = getDisplayWidth(prefix) + getDisplayWidth(stateTag) + 1; // prefix + stateTag + space
    const taskMax    = width - usedWithoutTask - getDisplayWidth(rightInfo);
    const taskText   = truncate(chain.task, Math.max(8, taskMax));
    const usedWidth  = usedWithoutTask + getDisplayWidth(taskText);
    const remaining  = width - usedWidth;

    const segments = [
      { text: prefix,   fg: isSelected ? fg : C.label },
      { text: stateTag, fg: stateCol, bold: true },
      { text: ' ',      fg: '' },
      { text: taskText, fg: isSelected ? fg : C.value },
    ];
    if (remaining >= rightInfo.length + 1) {
      // Right-align rightInfo in the remaining space
      // Colour the constraint badge separately when present
      if (chain.constraints.length > 0 && !isSelected) {
        const total = chain.constraints.length;
        const findings = chain.reviewerReport?.constraintFindings;
        const satisfied = findings ? findings.filter(f => f.satisfied).length : 0;
        // Determine badge colour
        let badgeFg: string;
        if (!findings || findings.length === 0) {
          badgeFg = C.dim;
        } else if (satisfied === total) {
          badgeFg = C.good;
        } else if (findings.some(f => !f.satisfied)) {
          badgeFg = C.bad;
        } else {
          badgeFg = C.reviewing; // some unverified but none failed
        }
        // Split: everything before the badge, then the badge
        const badgeText = ` c:${satisfied}/${total}`;
        const beforeBadge = rightInfo.slice(0, rightInfo.length - badgeText.length - 1);
        const padding = remaining - rightInfo.length;
        segments.push({ text: beforeBadge.padStart(padding + beforeBadge.length), fg: isSelected ? fg : C.label });
        segments.push({ text: badgeText, fg: badgeFg });
        segments.push({ text: ' ', fg: '' });
      } else {
        segments.push({ text: rightInfo.padStart(remaining), fg: isSelected ? fg : C.label });
      }
    }
    // else: no room — makeSegmentedLine will pad with spaces to fill width

    const row = buildSelectablePanelLine(width, segments, {
      selected: isSelected,
      selectedBg: bg,
      fillFg: isSelected ? fg : '',
    });

    return [row];
  }

  private renderChainDetail(chain: WrfcChain, width: number, maxLines: number): Line[] {
    const lines: Line[] = [];
    const indent = '     ';

    // Score sparkline
    if (chain.reviewScores.length > 0) {
      const spark = sparkline(chain.reviewScores);
      const latestScore = chain.reviewScores[chain.reviewScores.length - 1];
      const sparkColor  = latestScore >= 8 ? C.good : latestScore >= 5 ? C.info : C.bad;
      lines.push(buildStyledPanelLine(width, [
        { text: `${indent}Scores  `, fg: C.label },
        { text: spark,               fg: sparkColor },
        { text: ` (${chain.reviewScores.map(s => s.toFixed(0)).join(' -> ')})`, fg: C.dim },
      ]));
    }

    // Fix attempts + review cycles
    if (chain.fixAttempts > 0 || chain.reviewCycles > 0) {
      lines.push(buildStyledPanelLine(width, [
        { text: `${indent}Cycles  `, fg: C.label },
        { text: `${chain.reviewCycles} review`,  fg: C.value },
        { text: '  ',                             fg: '' },
        { text: `${chain.fixAttempts} fix`,       fg: chain.fixAttempts > 0 ? C.fixing : C.value },
      ]));
    }

    // Constraints section (between Cycles and Gates)
    if (chain.constraints.length > 0 && lines.length < maxLines) {
      lines.push(buildStyledPanelLine(width, [{ text: `${indent}Constraints`, fg: C.label }]));
      const MAX_CONSTRAINTS = 10;
      const findings = chain.reviewerReport?.constraintFindings;
      const displayed = chain.constraints.slice(0, MAX_CONSTRAINTS);
      for (const constraint of displayed) {
        if (lines.length >= maxLines) break;
        const marker = constraintStatusMarker(constraint, findings);
        const statusTag = marker.tag;
        const rowPrefix = `${indent}  ${statusTag}  `;
        const textMax = Math.max(8, width - rowPrefix.length);
        const constraintText = truncate(constraint.text, textMax);
        lines.push(buildStyledPanelLine(width, [
          { text: `${indent}  `, fg: C.dim },
          { text: statusTag,      fg: marker.fg, dim: marker.dim, bold: !marker.dim },
          { text: '  ',           fg: '' },
          { text: constraintText, fg: C.value },
        ]));
      }
      const remaining = chain.constraints.length - MAX_CONSTRAINTS;
      if (remaining > 0 && lines.length < maxLines) {
        lines.push(buildStyledPanelLine(width, [
          { text: `${indent}  (+${remaining} more)`, fg: C.dim, dim: true },
        ]));
      }
    }

    // Quality gate results
    if (chain.gateResults && chain.gateResults.length > 0) {
      lines.push(buildStyledPanelLine(width, [{ text: `${indent}Gates`, fg: C.label }]));
      for (const gate of chain.gateResults) {
        if (lines.length >= maxLines) break;
        lines.push(this.renderGateResult(gate, width, indent + '  '));
      }
    }

    // Gate status (no results yet but state is gating)
    if (chain.state === 'gating' || chain.state === 'awaiting_gates') {
      if (!chain.gateResults || chain.gateResults.length === 0) {
        lines.push(buildStyledPanelLine(width, [{ text: `${indent}Gates   awaiting...`, fg: C.gating, dim: true }]));
      }
    }

    // Synthetic issues injected by controller (continuity violations)
    if (chain.syntheticIssues && chain.syntheticIssues.length > 0 && lines.length < maxLines) {
      lines.push(buildStyledPanelLine(width, [{ text: `${indent}Controller flags`, fg: C.issueCrit, bold: true }]));
      for (const synthetic of chain.syntheticIssues) {
        if (lines.length >= maxLines) break;
        const prefix = `${indent}  [CRIT] `;
        const descMax = Math.max(8, width - prefix.length);
        const desc = truncate(synthetic.description, descMax);
        lines.push(buildStyledPanelLine(width, [
          { text: prefix, fg: C.issueCrit, bold: true },
          { text: desc,   fg: C.value },
        ]));
      }
    }

    // Issues from reviewer
    const issues = chain.reviewerReport?.issues ?? [];
    if (issues.length > 0 && lines.length < maxLines) {
      lines.push(buildStyledPanelLine(width, [{ text: `${indent}Issues`, fg: C.label }]));
      for (const issue of issues) {
        if (lines.length >= maxLines) break;
        const prefix = `${indent}  ${issuePrefix(issue.severity)}`;
        const descMax = width - prefix.length;
        const desc = truncate(issue.description, Math.max(8, descMax));
        lines.push(buildStyledPanelLine(width, [
          { text: prefix, fg: issueColor(issue.severity), bold: issue.severity === 'critical' },
          { text: desc,   fg: C.value },
        ]));
      }
    }

    // Error
    if (chain.error && lines.length < maxLines) {
      const errPrefix = `${indent}Error   `;
      lines.push(buildStyledPanelLine(width, [
        { text: errPrefix,                                fg: C.failed, bold: true },
        { text: truncate(chain.error, width - errPrefix.length), fg: C.value },
      ]));
    }

    // Divider after expanded section
    if (lines.length < maxLines) {
      lines.push(buildStyledPanelLine(width, [{ text: '  ' + '-'.repeat(Math.max(0, width - 4)) + '  ', fg: C.border, dim: true }]));
    }

    return lines.slice(0, maxLines);
  }

  private renderGateResult(gate: QualityGateResult, width: number, indent: string): Line {
    const icon   = gate.passed ? '✓' : '✕';
    const iconFg = gate.passed ? C.good : C.bad;
    const dur    = `${gate.durationMs}ms`;
    const nameMax = width - indent.length - 2 - dur.length - 4;
    const name   = truncate(gate.gate, Math.max(8, nameMax));

    return buildStyledPanelLine(width, [
      { text: indent,          fg: C.dim },
      { text: `${icon} `,      fg: iconFg, bold: true },
      { text: name,            fg: gate.passed ? C.value : C.failed },
      { text: ` (${dur})`,     fg: C.dim },
    ]);
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------
  private moveSelection(delta: number): void {
    if (this.chains.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.chains.length - 1, this.selectedIndex + delta));
    this.markDirty();
  }

  private toggleExpanded(): void {
    const chain = this.chains[this.selectedIndex];
    if (!chain) return;
    if (this.expandedChainIds.has(chain.id)) {
      this.expandedChainIds.delete(chain.id);
    } else {
      this.expandedChainIds.add(chain.id);
    }
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Event subscriptions
  // -------------------------------------------------------------------------
  private subscribeToEvents(): void {
    const refreshWithTimestamp = (chainId?: string) => {
      if (chainId) this.lastEventAt.set(chainId, Date.now());
      this.syncFromController();
      this.markDirty();
    };

    // Each workflow event carries the chainId in its payload — record it for
    // stall tracking.  The handler signature is (event) => void; we extract
    // chainId where present using a narrow type guard so we never guess.
    const timestamped = (e: WorkflowEvent) => {
      const chainId = 'chainId' in e && typeof e.chainId === 'string' ? e.chainId : undefined;
      refreshWithTimestamp(chainId);
    };

    this.unsubscribers.push(
      this.workflowEvents.on('WORKFLOW_CHAIN_CREATED',         timestamped),
      this.workflowEvents.on('WORKFLOW_STATE_CHANGED',         timestamped),
      this.workflowEvents.on('WORKFLOW_REVIEW_COMPLETED',      timestamped),
      this.workflowEvents.on('WORKFLOW_FIX_ATTEMPTED',         timestamped),
      this.workflowEvents.on('WORKFLOW_GATE_RESULT',           timestamped),
      this.workflowEvents.on('WORKFLOW_CHAIN_PASSED',          timestamped),
      this.workflowEvents.on('WORKFLOW_CHAIN_FAILED',          timestamped),
      this.workflowEvents.on('WORKFLOW_AUTO_COMMITTED',        timestamped),
      this.workflowEvents.on('WORKFLOW_CASCADE_ABORTED',       timestamped),
      this.workflowEvents.on('WORKFLOW_CONSTRAINTS_ENUMERATED', timestamped),
    );
  }

  private syncFromController(): void {
    // Distinguish two failure modes:
    //   1. Controller not yet initialized — chains is empty Map, listChains
    //      returns [] with no error.  This is the normal pre-ready path.
    //   2. Controller throws after initialization — an actual error we surface.
    // We detect (2) by checking whether we previously had chains: if chains
    // were present and listChains now throws, that is a post-init error.
    const hadChains = this.chains.length > 0;
    try {
      const all = this.deps.controller.listChains();
      this.controllerError = null;

      // Sort: active first (by createdAt desc), then completed
      const active = all.filter(c => !TERMINAL_STATES.includes(c.state));
      const done   = all.filter(c =>  TERMINAL_STATES.includes(c.state));
      active.sort((a, b) => b.createdAt - a.createdAt);
      done.sort(  (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
      this.chains = [...active, ...done];

      // Clamp selection
      if (this.chains.length > 0) {
        this.selectedIndex = Math.min(this.selectedIndex, this.chains.length - 1);
      }
    } catch (err) {
      if (hadChains) {
        // Post-init error: the controller was working and now throws.  Surface
        // a faint diagnostic rather than silently preserving stale state.
        const msg = summarizeError(err);
        this.controllerError = msg;
        console.debug('[WrfcPanel] controller.listChains() error post-init:', msg);
      }
      // Pre-init: controller not ready yet, leave chain list empty (no error).
    }
  }

  // -------------------------------------------------------------------------
  // Cancel / resume actions
  // -------------------------------------------------------------------------

  /** Initiate cancel-confirm flow for the selected chain (noop if terminal). */
  private beginCancelConfirm(): void {
    const chain = this.chains[this.selectedIndex];
    if (!chain || TERMINAL_STATES.includes(chain.state)) return;
    this.confirmCancel = {
      subject: chain.id,
      label: truncate(chain.task, 40),
    };
    this.markDirty();
  }

  /**
   * Resume the selected chain via the controller.
   * Only permitted when the chain state is in RESUMABLE_STATES.
   * Emits a visible noop reason when the chain is not resumable.
   */
  private doResume(): void {
    const chain = this.chains[this.selectedIndex];
    if (!chain) return;
    if (!RESUMABLE_STATES.includes(chain.state)) return;
    this.deps.controller.resumeChain(chain.id);
    // Re-sync so the rows/footer reflect the state resumeChain transitioned to.
    this.syncFromController();
    this.markDirty();
  }

  /** Returns a human-readable reason why resume is disabled for a chain, or null if it is allowed. */
  private resumeDisabledReason(chain: WrfcChain): string | null {
    if (TERMINAL_STATES.includes(chain.state)) return 'chain is complete';
    if (!RESUMABLE_STATES.includes(chain.state)) return `active (${stateLabel(chain.state)})`;
    return null;
  }

  /** Returns whether a chain is considered stalled (non-terminal, no recent event). */
  private isStalled(chain: WrfcChain, now: number): boolean {
    if (TERMINAL_STATES.includes(chain.state)) return false;
    const last = this.lastEventAt.get(chain.id) ?? chain.createdAt;
    return (now - last) >= STALL_THRESHOLD_MS;
  }
}
