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
import type { PlannerDecision, ExecutionStrategy } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
import type { PlannerEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import type { OpsStrategyQuery } from '../runtime/ui-service-queries.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

const STRATEGY_FG: Record<ExecutionStrategy, string> = {
  auto:       '#00cccc',
  single:     '#00cc66',
  cohort:     '#cccc00',
  background: '#cc66cc',
  remote:     '#cccccc',
};

const STRATEGY_ICON: Record<ExecutionStrategy, string> = {
  auto:       '~',
  single:     '▸',
  cohort:     '◆',
  background: '.',
  remote:     '▸',
};

// ---------------------------------------------------------------------------
// OpsStrategyPanel
// ---------------------------------------------------------------------------

export class OpsStrategyPanel extends BasePanel {
  private unsubscribers: Array<() => void> = [];
  private scrollOffset = 0;
  private history: PlannerDecision[] = [];
  private readonly adaptivePlanner: OpsStrategyQuery;

  constructor(
    private readonly plannerEvents: UiEventFeed<PlannerEvent>,
    adaptivePlanner: OpsStrategyQuery,
  ) {
    super('ops', 'Ops', 'O', 'agent');
    this.adaptivePlanner = adaptivePlanner;
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
    return false;
  }

  render(width: number, height: number): Line[] {
    const latest   = this.adaptivePlanner.getLatest();
    const mode     = this.adaptivePlanner.getMode();
    const override = this.adaptivePlanner.getOverride();
    const statusLines: Line[] = [
      buildPanelLine(width, [
        [' Mode ', DEFAULT_PANEL_PALETTE.label],
        [mode.toUpperCase(), DEFAULT_PANEL_PALETTE.value],
        ['   Override ', DEFAULT_PANEL_PALETTE.label],
        [override ? `${override.toUpperCase()} [ACTIVE]` : 'none', override ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
      ]),
    ];

    if (latest) {
      statusLines.push(buildPanelLine(width, [
        [' Last ', DEFAULT_PANEL_PALETTE.label],
        [`${STRATEGY_ICON[latest.selected]} ${latest.selected.toUpperCase()}`, STRATEGY_FG[latest.selected]],
        ['   Reason ', DEFAULT_PANEL_PALETTE.label],
        [latest.reasonCode, DEFAULT_PANEL_PALETTE.dim],
      ]));
    }

    if (this.history.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Ops Strategy',
        intro: 'Review adaptive execution planner decisions, overrides, and recent strategy history.',
        sections: [
          { title: 'Status', lines: statusLines },
          {
            lines: buildEmptyState(
              width,
              ' No decisions recorded yet',
              'Adaptive planner decisions appear here once the planner begins selecting strategies.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        footerLines: [
          buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' scroll history', DEFAULT_PANEL_PALETTE.dim], ['   g/G', DEFAULT_PANEL_PALETTE.info], [' top/bottom', DEFAULT_PANEL_PALETTE.dim]]),
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const historyLines = this._renderHistory(width);
    const statusSection = { title: 'Status', lines: statusLines } as const;
    const historySection = resolveScrollablePanelSection(width, height, {
      intro: 'Review adaptive execution planner decisions, overrides, and recent strategy history.',
      footerLines: [
        buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' scroll history', DEFAULT_PANEL_PALETTE.dim], ['   g/G', DEFAULT_PANEL_PALETTE.info], [' top/bottom', DEFAULT_PANEL_PALETTE.dim]]),
      ],
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [statusSection],
      section: {
        title: 'Decision History',
        scrollableLines: historyLines,
        scrollOffset: Math.min(this.scrollOffset, Math.max(0, historyLines.length - 1)),
        minRows: 8,
      },
    });
    this.scrollOffset = historySection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ' Ops Strategy',
      intro: 'Review adaptive execution planner decisions, overrides, and recent strategy history.',
      sections: [
        statusSection,
        historySection.section,
      ],
      footerLines: [
        buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' scroll history', DEFAULT_PANEL_PALETTE.dim], ['   g/G', DEFAULT_PANEL_PALETTE.info], [' top/bottom', DEFAULT_PANEL_PALETTE.dim]]),
      ],
      palette: DEFAULT_PANEL_PALETTE,
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
      return [buildStyledPanelLine(width, [{ text: '  No history yet.', fg: DEFAULT_PANEL_PALETTE.dim, dim: true }])];
    }

    const lines: Line[] = [];
    lines.push(buildStyledPanelLine(width, [{ text: ' Decision History', fg: DEFAULT_PANEL_PALETTE.value, bold: true }]));

    const reversed = [...this.history].reverse();
    for (let i = 0; i < reversed.length; i++) {
      const d    = reversed[i]!;
      const ts   = new Date(d.timestamp).toLocaleTimeString();
      const fg   = STRATEGY_FG[d.selected];
      const icon = STRATEGY_ICON[d.selected];
      const num  = String(i + 1).padStart(3);
      const overrideMark = d.overrideActive ? ' [O]' : '';

      // Row 1: index + icon + strategy + timestamp (right-aligned)
      const leftBase  = ` ${num}. ${icon} ${d.selected.toUpperCase()}${overrideMark}`;
      const rightText = `  ${ts}`;
      const pad       = Math.max(1, width - leftBase.length - rightText.length);
      lines.push(buildStyledPanelLine(width, [
        { text: ` ${num}. `, fg: DEFAULT_PANEL_PALETTE.dim, dim: true },
        { text: `${icon} ${d.selected.toUpperCase()}`, fg, bold: true },
        { text: overrideMark, fg: DEFAULT_PANEL_PALETTE.warn },
        { text: ' '.repeat(pad), fg: DEFAULT_PANEL_PALETTE.dim },
        { text: rightText, fg: DEFAULT_PANEL_PALETTE.dim, dim: true },
      ]));

      // Row 2: reason code
      lines.push(buildStyledPanelLine(width, [{ text: `       ${d.reasonCode}`, fg: DEFAULT_PANEL_PALETTE.dim, dim: true }]));

      // Row 3+: top-2 scored candidates (auto mode only)
      if (!d.overrideActive && d.candidates.length > 1) {
        const top2 = d.candidates.slice(0, 2);
        for (const c of top2) {
          lines.push(buildStyledPanelLine(width, [
            { text: '         ', fg: DEFAULT_PANEL_PALETTE.dim, dim: true },
            { text: c.strategy.padEnd(12), fg: STRATEGY_FG[c.strategy] },
            { text: ` score ${c.score}`, fg: DEFAULT_PANEL_PALETTE.dim, dim: true },
          ]));
        }
      }
    }

    return lines;
  }
}
