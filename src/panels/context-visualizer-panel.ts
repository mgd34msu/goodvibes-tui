// ---------------------------------------------------------------------------
// ContextVisualizerPanel — stacked bar showing context window composition.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { evaluateSessionMaintenance } from './session-maintenance.ts';
import type { TurnEvent } from '../runtime/events/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
import type { UiReadModel, UiSessionSnapshot } from '../runtime/ui-read-models.ts';
import type { SessionMemoryQuery } from '../runtime/ui-service-queries.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildMeterLine,
  buildPanelLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

const C = {
  convFg: '#cc99ff',
  overFg: '#ff6666',
  barEmpty: '#333344',
  labelFg: '#8888bb',
} as const;



interface ContextSnapshot {
  input: number;
  limit: number;
}

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export class ContextVisualizerPanel extends BasePanel {
  private snapshot: ContextSnapshot = { input: 0, limit: 0 };
  private unsubs: Array<() => void> = [];
  private readonly sessionMemoryStore: SessionMemoryQuery;

  constructor(
    private readonly turnEvents: UiEventFeed<TurnEvent>,
    sessionMemoryStore: SessionMemoryQuery,
    private getUsage?: () => { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string },
    private contextLimit?: number,
    private sessionReadModel?: UiReadModel<UiSessionSnapshot>,
  ) {
    super('context', 'Context', 'C', 'ai');
    this.sessionMemoryStore = sessionMemoryStore;
    this._attachBus();
    this._refresh();
  }

  override onActivate(): void {
    this.needsRender = true;
    this._refresh();
  }

  override onDeactivate(): void {
    super.onDeactivate();
  }

  override onDestroy(): void {
    this._detachBus();
  }

  render(width: number, height: number): Line[] {
    if (height <= 0 || width <= 0) return [];

    const input = this.snapshot.input;
    const limit = this.snapshot.limit;
    const pct = limit > 0 ? Math.min(100, Math.round((input / limit) * 100)) : 0;
    const barWidth = Math.max(1, width - 2);
    const overLimit = limit > 0 && input > limit;
    const fg = overLimit ? C.overFg : C.convFg;
    if (limit <= 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Context Usage',
        intro: 'Visualize current input-token pressure against the active model context window.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' Context limit unavailable',
              'Select a model with a known context window and submit or complete a turn to populate live context usage.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    return buildPanelWorkspace(width, height, {
      title: ' Context Usage',
      intro: 'Visualize current input-token pressure against the active model context window.',
      sections: [
        {
          title: 'Summary',
          lines: [
            buildPanelLine(width, [
              [' Input ', DEFAULT_PANEL_PALETTE.label],
              [formatK(input), DEFAULT_PANEL_PALETTE.value],
              ['   Limit ', DEFAULT_PANEL_PALETTE.label],
              [formatK(limit), DEFAULT_PANEL_PALETTE.info],
              ['   Fill ', DEFAULT_PANEL_PALETTE.label],
              [`${pct}%`, overLimit ? DEFAULT_PANEL_PALETTE.bad : DEFAULT_PANEL_PALETTE.good],
            ]),
          ],
        },
        {
          title: 'Usage',
          lines: [
            this._renderBar(width, barWidth, input, limit),
            this._renderSegLine(width, 'Input tokens', input, pct, fg),
            buildPanelLine(width, [[` ${formatK(input)} / ${formatK(limit)} tokens  (${pct}%)  Refreshes each LLM call`, DEFAULT_PANEL_PALETTE.dim]]),
          ],
        },
        {
          title: 'Maintenance',
          lines: this._renderMaintenance(width),
        },
      ],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  private _renderBar(width: number, barWidth: number, input: number, limit: number): Line {
    const filled = limit > 0 ? Math.min(barWidth, Math.round((input / limit) * barWidth)) : 0;
    const overLimit = limit > 0 && input > limit;
    const barFg = overLimit ? C.overFg : C.convFg;
    return buildMeterLine(width, filled, barWidth, {
      filled: barFg,
      empty: C.barEmpty,
      label: DEFAULT_PANEL_PALETTE.dim,
    });
  }

  private _renderSegLine(width: number, label: string, val: number, pct: number, fg: string): Line {
    const labelPadded = `  ${label}`.padEnd(22);
    const valStr = formatK(val).padStart(7);
    const pctStr = `${pct}%`.padStart(5);
    return buildStyledPanelLine(width, [
      { text: labelPadded, fg: C.labelFg },
      { text: valStr, fg },
      { text: '  ', fg: DEFAULT_PANEL_PALETTE.dim },
      { text: pctStr, fg },
    ]);
  }

  private _refresh(): void {
    const usage = this.getUsage?.();
    if (usage) {
      this.snapshot.input = usage.input;
      this.snapshot.limit = this.contextLimit ?? 0;
    }
    this.markDirty();
  }

  private _renderMaintenance(width: number): Line[] {
    const status = evaluateSessionMaintenance({
      currentTokens: this.snapshot.input,
      contextWindow: this.snapshot.limit,
      sessionMemoryCount: this.sessionMemoryStore.list().length,
      session: this.sessionReadModel?.getSnapshot().session,
    });
    const lines: Line[] = [
      buildPanelLine(width, [[` ${status.summary}`, DEFAULT_PANEL_PALETTE.label]]),
    ];
    if (status.reasons[0]) {
      lines.push(buildPanelLine(width, [[` ${status.reasons[0]}`, DEFAULT_PANEL_PALETTE.dim]]));
    }
    if (status.guidanceMode !== 'off' && status.nextSteps[0]) {
      lines.push(buildGuidanceLine(width, status.nextSteps[0], 'open the suggested maintenance action', DEFAULT_PANEL_PALETTE));
    }
    return lines;
  }

  private _attachBus(): void {
    if (this.unsubs.length > 0) return;
    this.unsubs.push(this.turnEvents.on('TURN_COMPLETED', () => {
      this._refresh();
    }));
    this.unsubs.push(this.turnEvents.on('TURN_SUBMITTED', () => {
      this._refresh();
    }));
  }

  private _detachBus(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }
}
