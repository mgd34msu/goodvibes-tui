import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import type { Orchestrator } from '../core/orchestrator.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import { SessionMemoryStore } from '../core/session-memory.ts';
import { evaluateSessionMaintenance } from './session-maintenance.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Timestamp of the turn completion. */
  ts: number;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
  title: '#00ffff',
  input: '#00ffff',
  output: '#d000ff',
  cacheRead: '#00d700',
  cacheWrite: '#ffaf00',
  barBg: '236',
  label: '244',
  value: '252',
  sectionHeader: '238',
  warnYellow: '#ffaf00',
  warnRed: '#ff5f5f',
  dim: '240',
  good: '#5fd700',
  turnHeader: '242',
} as const;

// Warning thresholds for context window usage
const WARN_YELLOW = 0.70;
const WARN_RED = 0.90;

// Maximum turns to keep in per-turn history
const MAX_TURN_HISTORY = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a token count: up to 9999 shown as-is, then 10.0k, 1.2M, etc. */
function fmtTok(n: number): string {
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

// ---------------------------------------------------------------------------
// TokenBudgetPanel
// ---------------------------------------------------------------------------

/**
 * Real-time token usage breakdown panel.
 *
 * Displays:
 *  - Stacked bar: input / output / cache-read / cache-write
 *  - Context window fill percentage with progress bar
 *  - Per-turn token usage (last 10 turns)
 *  - Cumulative session totals
 *  - Warning threshold indicators (yellow at 70%, red at 90%)
 */
export class TokenBudgetPanel extends BasePanel {
  /** Snapshot of cumulative usage from the Orchestrator after each turn. */
  private sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** lastInputTokens from the Orchestrator — current context window occupancy. */
  private lastInputTokens = 0;
  /** Context window size from the model config (0 = unknown). */
  private contextWindow = 0;
  /** Per-turn snapshots — at most MAX_TURN_HISTORY entries. */
  private turnHistory: TurnUsage[] = [];
  /** Previous cumulative snapshot to compute per-turn delta. */
  private prevCumulative = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private orchestrator: Orchestrator | null = null;
  private getContextWindow: (() => number) | null = null;
  private runtimeStore: RuntimeStore | null = null;
  private readonly sessionMemoryStore: SessionMemoryStore;

  constructor(sessionMemoryStore: SessionMemoryStore) {
    super('tokens', 'Tokens', 'T', 'monitoring');
    this.sessionMemoryStore = sessionMemoryStore;
  }

  // ---------------------------------------------------------------------------
  // External wiring
  // ---------------------------------------------------------------------------

  /**
   * Wire the panel to live data sources. Call once after construction.
   *
   * @param orchestrator  The main Orchestrator instance (for usage + lastInputTokens).
   * @param getCtxWindow  Callback returning the current model's contextWindow value.
   */
  wire(orchestrator: Orchestrator, getCtxWindow: () => number, runtimeStore?: RuntimeStore): void {
    this.orchestrator = orchestrator;
    this.getContextWindow = getCtxWindow;
    this.runtimeStore = runtimeStore ?? null;
  }

  /**
   * Snapshot a completed turn into per-turn history.
   * Should be called from a `turn:complete` event listener.
   */
  recordTurn(): void {
    if (!this.orchestrator) return;

    const cu = this.orchestrator.usage;
    const delta: TurnUsage = {
      input:      cu.input      - this.prevCumulative.input,
      output:     cu.output     - this.prevCumulative.output,
      cacheRead:  cu.cacheRead  - this.prevCumulative.cacheRead,
      cacheWrite: cu.cacheWrite - this.prevCumulative.cacheWrite,
      ts: Date.now(),
    };

    this.prevCumulative = { ...cu };

    this.turnHistory.push(delta);
    if (this.turnHistory.length > MAX_TURN_HISTORY) {
      this.turnHistory.shift();
    }

    this.refresh();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    this.refresh();
    // Poll every 2 s while active so the context bar stays current during streaming
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => this.refresh(), 2_000);
  }

  override onDeactivate(): void {
    super.onDeactivate();
  }

  override onDestroy(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Data refresh
  // ---------------------------------------------------------------------------

  private refresh(): void {
    if (this.orchestrator) {
      const u = this.orchestrator.usage;
      this.sessionUsage.input      = u.input      ?? 0;
      this.sessionUsage.output     = u.output     ?? 0;
      this.sessionUsage.cacheRead  = u.cacheRead  ?? 0;
      this.sessionUsage.cacheWrite = u.cacheWrite ?? 0;
      this.lastInputTokens = this.orchestrator.lastInputTokens;
    }
    if (this.getContextWindow) {
      this.contextWindow = this.getContextWindow();
    }
    this.markDirty();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    const sections: PanelWorkspaceSection[] = [];

    if (this.contextWindow > 0) {
      sections.push({
        title: 'Context',
        lines: this.renderContextBar(width),
      });
    }

    sections.push({
      title: 'Session',
      lines: [
        ...this.renderStackedBar(width, this.sessionUsage, 'Session'),
        ...this.renderTotals(width),
      ],
    });

    if (this.turnHistory.length > 0) {
      const priorSections = [...sections];
      const turnsSection = resolveScrollablePanelSection(width, height, {
        intro: 'Live context pressure, session token composition, cache usage, and recent turn deltas.',
        palette: DEFAULT_PANEL_PALETTE,
        beforeSections: priorSections,
        section: {
          title: 'Recent Turns',
          scrollableLines: this.renderTurnHistory(width, this.turnHistory.length + 1),
          scrollOffset: Math.max(0, this.turnHistory.length),
          minRows: 6,
        },
        afterSections: [{
          title: 'Maintenance',
          lines: this.renderMaintenance(width),
        }],
      });
      sections.push(turnsSection.section);
    } else {
      sections.push({
        title: 'Recent Turns',
        lines: buildEmptyState(
          width,
          ' No turns recorded yet',
          'Token deltas appear here after completed turns so you can see context growth and cache usage.',
          [],
          DEFAULT_PANEL_PALETTE,
        ),
      });
    }

    sections.push({
      title: 'Maintenance',
      lines: this.renderMaintenance(width),
    });

    return buildPanelWorkspace(width, height, {
      title: ' Token Budget',
      intro: 'Live context pressure, session token composition, cache usage, and recent turn deltas.',
      sections,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  private renderMaintenance(width: number): Line[] {
    const status = evaluateSessionMaintenance({
      currentTokens: this.lastInputTokens,
      contextWindow: this.contextWindow,
      messageCount: this.runtimeStore?.getState().conversation.totalTurns,
      sessionMemoryCount: this.sessionMemoryStore.list().length,
      session: this.runtimeStore?.getState().session,
    });

    const lines: Line[] = [
      this.paintTextLine(` ${status.summary}`, width, C.label),
    ];

    if (status.reasons[0]) {
      lines.push(this.paintTextLine(` ${status.reasons[0]}`, width, C.dim, { dim: true }));
    }

    if (status.guidanceMode !== 'off' && status.nextSteps.length > 0) {
      lines.push(buildGuidanceLine(width, status.nextSteps[0]!, 'open the next maintenance action directly', DEFAULT_PANEL_PALETTE));
    }

    return lines;
  }

  /**
   * Renders a compact stacked proportion bar:
   *   [########............] (input=cyan, output=purple, cacheR=green, cacheW=yellow)
   */
  private renderStackedBar(
    width: number,
    u: { input: number; output: number; cacheRead: number; cacheWrite: number },
    label: string,
  ): Line[] {
    const lines: Line[] = [];

    const labelLine = this.paintTextLine(` ${label}:`, width, C.label);
    lines.push(labelLine);

    const total = u.input + u.output + u.cacheRead + u.cacheWrite;
    if (total === 0) {
      lines.push(this.paintTextLine('  (no data)', width, C.dim, { dim: true }));
      return lines;
    }

    const BAR_W = Math.max(10, Math.min(40, width - 4));
    const segments: Array<{ color: string; label: string; count: number; cells: number }> = [
      { color: C.input,      label: 'In',  count: u.input,      cells: 0 },
      { color: C.output,     label: 'Out', count: u.output,     cells: 0 },
      { color: C.cacheRead,  label: 'CR',  count: u.cacheRead,  cells: 0 },
      { color: C.cacheWrite, label: 'CW',  count: u.cacheWrite, cells: 0 },
    ].filter(s => s.count > 0);

    // Distribute cells proportionally, ensuring they sum to BAR_W
    let assigned = 0;
    for (const seg of segments) {
      seg.cells = Math.floor((seg.count / total) * BAR_W);
      assigned += seg.cells;
    }
    // Give remainder to the largest segment
    const remainder = BAR_W - assigned;
    if (remainder > 0 && segments.length > 0) {
      const largest = segments.reduce((a, b) => (b.count > a.count ? b : a));
      largest.cells += remainder;
    }

    // Build bar line
    const usedCells = segments.reduce((sum, seg) => sum + seg.cells, 0);
    lines.push(buildStyledPanelLine(width, [
      { text: ' [', fg: C.label },
      ...segments.map((seg) => ({ text: '#'.repeat(seg.cells), fg: seg.color })),
      { text: '.'.repeat(Math.max(0, BAR_W - usedCells)), fg: C.barBg },
      { text: ']', fg: C.label },
    ]));

    // Legend line: In:12.3k  Out:4.5k  CR:6.7k  CW:1.2k  Total:24.7k
    const allSegs = [
      { color: C.input,      label: 'In',    count: u.input },
      { color: C.output,     label: 'Out',   count: u.output },
      { color: C.cacheRead,  label: 'CR',    count: u.cacheRead },
      { color: C.cacheWrite, label: 'CW',    count: u.cacheWrite },
    ];
    lines.push(buildStyledPanelLine(width, [
      { text: ' ', fg: C.dim },
      ...allSegs.flatMap((seg) => ([
        { text: `${seg.label}:`, fg: seg.color },
        { text: `${fmtTok(seg.count)} `, fg: C.value },
      ])),
      { text: ` Total:${fmtTok(total)}`, fg: C.value, bold: true },
    ]));

    return lines;
  }

  /** Renders a full-width progress bar for context window fill. */
  private renderContextBar(width: number): Line[] {
    const lines: Line[] = [];
    const pct = this.contextWindow > 0
      ? Math.min(1, this.lastInputTokens / this.contextWindow)
      : 0;
    const pctInt = Math.round(pct * 100);

    // Choose color based on thresholds
    let barColor: string;
    let warnSuffix = '';
    if (pct >= WARN_RED) {
      barColor = C.warnRed;
      warnSuffix = ' ! CRITICAL';
    } else if (pct >= WARN_YELLOW) {
      barColor = C.warnYellow;
      warnSuffix = ' ! HIGH';
    } else {
      barColor = C.good;
    }

    const label = ' Context: ';
    const suffix = ` ${fmtTok(this.lastInputTokens)}/${fmtTok(this.contextWindow)} (${pctInt}%)${warnSuffix}`;
    const BAR_W = Math.max(8, width - label.length - suffix.length - 2);
    const filled = Math.round(pct * BAR_W);
    lines.push(buildStyledPanelLine(width, [
      { text: label, fg: C.label },
      { text: '#'.repeat(filled), fg: barColor, dim: pct < WARN_YELLOW },
      { text: '.'.repeat(Math.max(0, BAR_W - filled)), fg: C.barBg, dim: pct < WARN_YELLOW },
      { text: suffix, fg: barColor, dim: pct < WARN_YELLOW },
    ]));
    return lines;
  }

  /** Session cumulative totals with color-coded labels. */
  private renderTotals(width: number): Line[] {
    const lines: Line[] = [];
    lines.push(this.paintTextLine(' Session Totals:', width, C.label));

    const u = this.sessionUsage;
    const total = u.input + u.output + u.cacheRead + u.cacheWrite;

    const rows: Array<[string, number, string]> = [
      ['  Input:      ', u.input,      C.input],
      ['  Output:     ', u.output,     C.output],
      ['  Cache Read: ', u.cacheRead,  C.cacheRead],
      ['  Cache Write:', u.cacheWrite, C.cacheWrite],
      ['  Total:      ', total,         C.value],
    ];

    for (const [lbl, val, color] of rows) {
      if (lines.length >= 8) break; // guard — don't overflow the section
      lines.push(buildStyledPanelLine(width, [
        { text: lbl, fg: C.label },
        { text: fmtTok(val), fg: color, bold: lbl.includes('Total') },
      ]));
    }

    return lines;
  }

  /** Last N turns table: turn#, in, out, CR, CW, total. */
  private renderTurnHistory(width: number, maxRows: number): Line[] {
    const lines: Line[] = [];

    // Column headers
    const colLine = createEmptyLine(width);
    const headers = ['  #', '    Input', '   Output', '  CR', '  CW', '   Total'];
    const cols = [3, 9, 9, 6, 6, 9];
    let hx = 0;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i]!;
      for (const ch of h.slice(0, cols[i]!)) {
        if (hx >= width) break;
        colLine[hx++] = createStyledCell(ch, { fg: C.turnHeader, dim: true });
      }
    }
    lines.push(colLine);

    const available = Math.max(0, maxRows - 1); // minus col header
    const toShow = this.turnHistory.slice(-Math.max(0, available));

    toShow.forEach((t, i) => {
      if (lines.length >= maxRows) return;
      const turnNum = this.turnHistory.length - toShow.length + i + 1;
      const total = t.input + t.output + t.cacheRead + t.cacheWrite;
      const cells: Array<[string, string]> = [
        [String(turnNum).padStart(3), C.dim],
        [fmtTok(t.input).padStart(9),      C.input],
        [fmtTok(t.output).padStart(9),     C.output],
        [fmtTok(t.cacheRead).padStart(6),  C.cacheRead],
        [fmtTok(t.cacheWrite).padStart(6), C.cacheWrite],
        [fmtTok(total).padStart(9),        C.value],
      ];
      lines.push(buildStyledPanelLine(width, cells.map(([val, color]) => ({ text: val, fg: color }))));
    });

    return lines;
  }

  /** Paint a plain text string into a new Line. */
  private paintTextLine(
    text: string,
    width: number,
    fg: string,
    opts: { bold?: boolean; dim?: boolean } = {},
  ): Line {
    const line = createEmptyLine(width);
    let x = 0;
    for (const ch of text) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg, bold: opts.bold, dim: opts.dim });
    }
    return line;
  }
}
