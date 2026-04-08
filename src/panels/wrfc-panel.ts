import type { Line } from '../types/grid.ts';
import type { WrfcChain, WrfcState, QualityGateResult } from '../agents/wrfc-types.ts';
import { WrfcController } from '../agents/wrfc-controller.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeEventBus, WorkflowEvent } from '../runtime/events/index.ts';
import {
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
  buildSelectablePanelLine,
  buildStyledPanelLine,
  buildEmptyState,
} from './polish.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';

// ---------------------------------------------------------------------------
// Colour palette
// ---------------------------------------------------------------------------
const C = {
  // states
  passed:     '#22c55e', // green
  failed:     '#ef4444', // red
  reviewing:  '#eab308', // yellow
  engineering:'#22d3ee', // cyan
  fixing:     '#f97316', // orange
  pending:    '#6b7280', // grey
  gating:     '#a78bfa', // violet
  committing: '#38bdf8', // sky

  // UI chrome
  header:     '#94a3b8',
  headerBold: '#e2e8f0',
  dim:        '#4b5563',
  label:      '#64748b',
  value:      '#cbd5e1',
  selected:   '#1e40af', // selection bg
  selectedFg: '#f8fafc',
  border:     '#334155',
  spark:      '#38bdf8',
  sparkLow:   '#ef4444',
  sparkHigh:  '#22c55e',
  issueCrit:  '#ef4444',
  issueMaj:   '#f97316',
  issueMin:   '#eab308',
  issueSug:   '#6b7280',
  gatePass:   '#22c55e',
  gateFail:   '#ef4444',
} as const;

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
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
export class WrfcPanel extends BasePanel {
  private chains: WrfcChain[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private expandedChainIds = new Set<string>();
  private unsubscribers: Array<() => void> = [];
  private controller: WrfcController | null = null;

  constructor(private readonly runtimeBus: RuntimeEventBus) {
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
    switch (key) {
      case 'up':    this.moveSelection(-1); return true;
      case 'down':  this.moveSelection(1);  return true;
      case 'return':
      case 'enter': this.toggleExpanded();  return true;
      default:      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  render(width: number, height: number): Line[] {
    const activeCount  = this.chains.filter(c => !['passed', 'failed'].includes(c.state)).length;
    const passedCount  = this.chains.filter(c => c.state === 'passed').length;
    const failedCount  = this.chains.filter(c => c.state === 'failed').length;

    if (this.chains.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' WRFC Chain Monitor',
        intro: 'Track WRFC engineering, review, fixing, gating, and final chain outcomes.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' No WRFC chains yet',
              'WRFC chains appear here as review/fix cycles execute. Expanded rows show scores, gates, issues, and failure detail.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const chainLines: Line[] = [];
    for (let i = 0; i < this.chains.length; i++) {
      const chain      = this.chains[i];
      const isSelected = i === this.selectedIndex;
      const isExpanded = this.expandedChainIds.has(chain.id);
      const rowBg      = isSelected ? C.selected : '';
      const rowFg      = isSelected ? C.selectedFg : '';

      chainLines.push(...this.renderChainRow(chain, width, isSelected, isExpanded, rowBg, rowFg));

      if (isExpanded) {
        chainLines.push(...this.renderChainDetail(chain, width, 12));
      }
    }

    const window = getTrackedVisibleWindow(chainLines.length, this.selectedIndex, Math.max(8, height - 8), this.scrollOffset, 1);
    this.scrollOffset = window.start;
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
        ]
      : [];

    const sections: PanelWorkspaceSection[] = [
      {
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
      },
      {
        title: 'Chains',
        lines: chainLines.slice(window.start, window.end),
      },
      {
        title: 'Selected',
        lines: selectedLines,
      },
    ];

    return buildPanelWorkspace(width, height, {
      title: ' WRFC Chain Monitor',
      intro: 'Track WRFC engineering, review, fixing, gating, and final chain outcomes.',
      sections,
      footerLines: [
        buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim], ['   Enter', DEFAULT_PANEL_PALETTE.info], [' expand', DEFAULT_PANEL_PALETTE.dim]]),
      ],
      palette: DEFAULT_PANEL_PALETTE,
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
  ): Line[] {
    const stateCol   = stateColor(chain.state);
    const stateTag   = ` ${stateLabel(chain.state).padEnd(6)}`;
    const arrow      = isExpanded ? '▾' : '▸';
    const chainIdShort = chain.id.slice(-6);
    const prefix     = ` ${arrow} [${chainIdShort}] `;
    const fixes      = chain.fixAttempts > 0 ? ` fix:${chain.fixAttempts}` : '';
    const cycles     = chain.reviewCycles > 0 ? ` rev:${chain.reviewCycles}` : '';
    const latestScore = chain.reviewScores.length > 0
      ? ` ${chain.reviewScores[chain.reviewScores.length - 1].toFixed(1)}/10`
      : '';
    const rightInfo  = `${latestScore}${fixes}${cycles} `;

    // Compute how much space the task text can use, then check if rightInfo fits.
    // If the terminal is narrow and rightInfo would overflow, omit it entirely
    // rather than producing corrupted layout.
    const usedWithoutTask = getDisplayWidth(prefix) + getDisplayWidth(stateTag) + 1; // prefix + stateTag + space
    const taskMax    = width - usedWithoutTask - getDisplayWidth(rightInfo);
    const taskText   = truncate(chain.task, Math.max(8, taskMax));
    const usedWidth  = usedWithoutTask + getDisplayWidth(taskText);
    const remaining  = width - usedWidth;

    const segments = [
      { text: prefix,   fg: isSelected ? fg : C.header },
      { text: stateTag, fg: stateCol, bold: true },
      { text: ' ',      fg: '' },
      { text: taskText, fg: isSelected ? fg : C.value },
    ];
    if (remaining >= rightInfo.length + 1) {
      // Right-align rightInfo in the remaining space
      segments.push({ text: rightInfo.padStart(remaining), fg: isSelected ? fg : C.label });
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
      const sparkColor  = latestScore >= 8 ? C.sparkHigh : latestScore >= 5 ? C.spark : C.sparkLow;
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
    const iconFg = gate.passed ? C.gatePass : C.gateFail;
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
    const refresh = () => { this.syncFromController(); this.markDirty(); };

    this.unsubscribers.push(
      this.runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_CREATED' }>>('WORKFLOW_CHAIN_CREATED', refresh),
      this.runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_STATE_CHANGED' }>>('WORKFLOW_STATE_CHANGED', refresh),
      this.runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_REVIEW_COMPLETED' }>>('WORKFLOW_REVIEW_COMPLETED', refresh),
      this.runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_FIX_ATTEMPTED' }>>('WORKFLOW_FIX_ATTEMPTED', refresh),
      this.runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_GATE_RESULT' }>>('WORKFLOW_GATE_RESULT', refresh),
      this.runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_PASSED' }>>('WORKFLOW_CHAIN_PASSED', refresh),
      this.runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CHAIN_FAILED' }>>('WORKFLOW_CHAIN_FAILED', refresh),
      this.runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_AUTO_COMMITTED' }>>('WORKFLOW_AUTO_COMMITTED', refresh),
      this.runtimeBus.on<Extract<WorkflowEvent, { type: 'WORKFLOW_CASCADE_ABORTED' }>>('WORKFLOW_CASCADE_ABORTED', refresh),
    );
  }

  private syncFromController(): void {
    try {
      if (!this.controller) {
        this.controller = WrfcController.getInstance();
      }
      // Sort: active first (by createdAt desc), then completed
      const all = this.controller.listChains();
      const active   = all.filter(c => !['passed', 'failed'].includes(c.state));
      const done     = all.filter(c =>  ['passed', 'failed'].includes(c.state));
      active.sort((a, b) => b.createdAt - a.createdAt);
      done.sort(  (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
      this.chains = [...active, ...done];

      // Clamp selection
      if (this.chains.length > 0) {
        this.selectedIndex = Math.min(this.selectedIndex, this.chains.length - 1);
      }
    } catch {
      // WrfcController not yet initialized — leave chain list empty
    }
  }
}
