/**
 * Ops Strategy Timeline Panel.
 *
 * Renders the Adaptive Execution Planner state: current strategy, reason
 * code, mode, override status, and a scrollable history of past decisions.
 *
 * Registered as panel id 'ops' in builtin-panels.
 */

import { BasePanel } from './base-panel.ts';
import type { Line } from '../types/grid.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { PlannerDecision, ExecutionStrategy } from '@pellux/goodvibes-sdk/platform/core';
import type { PlannerEvent, PlanRuntimeService } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import type { OpsStrategyQuery } from '../runtime/ui-service-queries.ts';
import {
  buildAlignedRow,
  buildEmptyState,
  buildKeyboardHints,
  buildPanelLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  extendPalette,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  auto:       '#00cccc',
  single:     '#00cc66',
  cohort:     '#cccc00',
  background: '#cc66cc',
  remote:     '#cccccc',
});

const STRATEGY_FG: Record<ExecutionStrategy, string> = {
  auto:       C.auto,
  single:     C.single,
  cohort:     C.cohort,
  background: C.background,
  remote:     C.remote,
};

const STRATEGY_ICON: Record<ExecutionStrategy, string> = {
  auto:       '~',
  single:     '▸',
  cohort:     '◆',
  background: '.',
  remote:     '▸',
};

// Cycle order for the o (override) and m (mode) keys — mirrors /plan's
// documented strategy list (planner-command-handler.ts VALID_STRATEGIES).
const STRATEGY_CYCLE: readonly ExecutionStrategy[] = ['auto', 'single', 'cohort', 'background', 'remote'];

function nextStrategy(current: ExecutionStrategy): ExecutionStrategy {
  const idx = STRATEGY_CYCLE.indexOf(current);
  return STRATEGY_CYCLE[(idx + 1) % STRATEGY_CYCLE.length]!;
}

// ---------------------------------------------------------------------------
// OpsStrategyPanel
// ---------------------------------------------------------------------------

export class OpsStrategyPanel extends BasePanel {
  private unsubscribers: Array<() => void> = [];
  private scrollOffset = 0;
  private history: PlannerDecision[] = [];
  private readonly adaptivePlanner: OpsStrategyQuery;
  private readonly planRuntime: PlanRuntimeService | undefined;

  constructor(
    private readonly plannerEvents: UiEventFeed<PlannerEvent>,
    adaptivePlanner: OpsStrategyQuery,
    planRuntime?: PlanRuntimeService,
  ) {
    super('ops', 'Ops', 'O', 'agent');
    this.adaptivePlanner = adaptivePlanner;
    this.planRuntime = planRuntime;
  }

  override onActivate(): void {
    super.onActivate();
    this._syncHistory();
    this.unsubscribers.push(
      this.plannerEvents.on('PLAN_STRATEGY_SELECTED', () => {
        this._syncHistory();
        this.markDirty();
      }),
      this.plannerEvents.on('PLAN_STRATEGY_OVERRIDDEN', () => {
        this._syncHistory();
        this.markDirty();
      }),
    );
  }

  override onDestroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (key === 'up' || key === 'k') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.scrollOffset++;
      this.markDirty();
      return true;
    }
    if (key === 'g') {
      this.scrollOffset = 0;
      this.markDirty();
      return true;
    }
    if (key === 'G') {
      this.scrollOffset = Math.max(0, this.history.length - 1);
      this.markDirty();
      return true;
    }
    if (key === 'o') {
      this._cycleOverride();
      return true;
    }
    if (key === 'c') {
      this._clearOverride();
      return true;
    }
    if (key === 'm') {
      this._cycleMode();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Override verbs — o=cycle override, c=clear, m=cycle mode, all dispatched
  // through the same /plan subcommand bridge the slash command uses
  // (planning-runtime.ts), so panel and slash-command behavior stay identical.
  // -------------------------------------------------------------------------

  private _cycleOverride(): void {
    if (!this.planRuntime) {
      this.setError('Plan runtime is not wired for this runtime.');
      return;
    }
    const current = this.adaptivePlanner.getOverride() ?? this.adaptivePlanner.getMode();
    const result = this.planRuntime('override', [nextStrategy(current)]);
    if (!result.ok) this.setError(result.output);
    this.markDirty();
  }

  private _clearOverride(): void {
    if (!this.planRuntime) {
      this.setError('Plan runtime is not wired for this runtime.');
      return;
    }
    const result = this.planRuntime('clear', []);
    if (!result.ok) this.setError(result.output);
    this.markDirty();
  }

  private _cycleMode(): void {
    if (!this.planRuntime) {
      this.setError('Plan runtime is not wired for this runtime.');
      return;
    }
    const result = this.planRuntime('mode', [nextStrategy(this.adaptivePlanner.getMode())]);
    if (!result.ok) this.setError(result.output);
    this.markDirty();
  }

  render(width: number, height: number): Line[] {
    const latest   = this.adaptivePlanner.getLatest();
    const mode     = this.adaptivePlanner.getMode();
    const override = this.adaptivePlanner.getOverride();
    const intro = 'Review adaptive execution planner decisions, overrides, and recent strategy history.';
    const errorLine = this.renderErrorLine(width);
    const footerLines = [
      ...(errorLine ? [errorLine] : []),
      buildKeyboardHints(width, [
        { keys: 'Up/Down', label: 'scroll history' },
        { keys: 'g/G', label: 'top/bottom' },
        { keys: 'o', label: 'cycle override' },
        { keys: 'c', label: 'clear override' },
        { keys: 'm', label: 'cycle mode' },
      ], C),
    ];
    const statusLines: Line[] = [
      buildPanelLine(width, [
        [' Mode ', C.label],
        [mode.toUpperCase(), C.value],
        ['   Override ', C.label],
        [override ? `${override.toUpperCase()} [ACTIVE]` : 'none', override ? C.warn : C.dim],
        ['   Decisions ', C.label],
        [String(this.history.length), this.history.length > 0 ? C.info : C.dim],
      ]),
    ];

    if (latest) {
      statusLines.push(buildPanelLine(width, [
        [' Last ', C.label],
        [`${STRATEGY_ICON[latest.selected]} ${latest.selected.toUpperCase()}`, STRATEGY_FG[latest.selected]],
        ['   Reason ', C.label],
        [latest.reasonCode, C.dim],
      ]));
    }

    if (this.history.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Ops Strategy',
        intro,
        sections: [
          { title: 'Status', lines: statusLines },
          {
            lines: buildEmptyState(
              width,
              ' No decisions recorded yet',
              'Adaptive planner decisions appear here once the planner begins selecting strategies. Seed or inspect an execution plan to drive runtime activity.',
              [{ command: '/plan', summary: 'seed or inspect an execution plan; strategy decisions start appearing here once it runs' }],
              C,
            ),
          },
        ],
        footerLines,
        palette: C,
      });
    }

    const historyLines = this._renderHistory(width);
    const statusSection = { title: 'Status', lines: statusLines } as const;
    const historySection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines,
      palette: C,
      beforeSections: [statusSection],
      section: {
        title: `Decision History (${this.history.length})`,
        scrollableLines: historyLines,
        scrollOffset: Math.min(this.scrollOffset, Math.max(0, historyLines.length - 1)),
        minRows: 8,
      },
    });
    this.scrollOffset = historySection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ' Ops Strategy',
      intro,
      sections: [
        statusSection,
        historySection.section,
      ],
      footerLines,
      palette: C,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _syncHistory(): void {
    this.history = this.adaptivePlanner.getHistory(50);
  }

  private _renderHistory(width: number): Line[] {
    if (this.history.length === 0) {
      return [buildStyledPanelLine(width, [{ text: '  No history yet.', fg: C.dim, dim: true }])];
    }

    const lines: Line[] = [];

    const reversed = [...this.history].reverse();
    for (let i = 0; i < reversed.length; i++) {
      const d    = reversed[i]!;
      const ts   = new Date(d.timestamp).toLocaleTimeString();
      const fg   = STRATEGY_FG[d.selected];
      const icon = STRATEGY_ICON[d.selected];
      const num  = String(i + 1).padStart(3);
      const overrideMark = d.overrideActive ? ' [O]' : '';

      // Row 1: index + icon + strategy on the left, timestamp right-aligned.
      // buildAlignedRow keeps the timestamp flush-right even with wide glyphs.
      const tsCol = getDisplayWidth(`${ts}  `);
      lines.push(buildAlignedRow(
        width,
        [
          { text: ` ${num}. ${icon} ${d.selected.toUpperCase()}${overrideMark}`, fg, bold: true },
          { text: `${ts}  `, fg: C.dim, dim: true },
        ],
        [
          { width: Math.max(0, width - tsCol - 1) },
          { width: tsCol, align: 'right' },
        ],
        { gap: 1 },
      ));

      // Row 2: reason code
      lines.push(buildStyledPanelLine(width, [{ text: `       ${d.reasonCode}`, fg: C.dim, dim: true }]));

      // Row 3+: top-2 scored candidates (auto mode only)
      if (!d.overrideActive && d.candidates.length > 1) {
        const top2 = d.candidates.slice(0, 2);
        for (const c of top2) {
          lines.push(buildStyledPanelLine(width, [
            { text: '         ', fg: C.dim, dim: true },
            { text: c.strategy.padEnd(12), fg: STRATEGY_FG[c.strategy] },
            { text: ` score ${c.score}`, fg: C.dim, dim: true },
          ]));
        }
      }
    }

    return lines;
  }
}
