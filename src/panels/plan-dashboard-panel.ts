import type { Line } from '../types/grid.ts';
import type { ExecutionPlan, PlanItem, PlanItemStatus } from '../core/execution-plan.ts';
import { BasePanel } from './base-panel.ts';
import { planManager } from '../core/plan-manager-instance.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';

// ---------------------------------------------------------------------------
// Status display maps
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<PlanItemStatus, string> = {
  complete: '✓',
  in_progress: '▸',
  pending: '•',
  failed: '✗',
  skipped: '–',
};

const STATUS_FG: Record<PlanItemStatus, string> = {
  complete: '#22c55e',
  in_progress: '#00ffff',
  pending: '244',
  failed: '#ef4444',
  skipped: '238',
};

// ---------------------------------------------------------------------------
// PlanDashboardPanel
// ---------------------------------------------------------------------------

export class PlanDashboardPanel extends BasePanel {
  private scrollOffset = 0;
  private selectedIndex = 0;

  // Flat list of navigable row indices (set during render)
  private totalRows = 0;

  constructor() {
    super('plan', 'Plan', 'P', 'agent');
  }

  override onActivate(): void {
    super.onActivate();
    // Re-read plan from disk each time the panel is activated
    this.markDirty();
  }

  // --------------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------------

  handleInput(key: string): boolean {
    if (key === 'up' || key === 'k') {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.markDirty();
        return true;
      }
    } else if (key === 'down' || key === 'j') {
      if (this.selectedIndex < this.totalRows - 1) {
        this.selectedIndex++;
        this.markDirty();
        return true;
      }
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    const plan = planManager.getActive();
    if (!plan) {
      return buildPanelWorkspace(width, height, {
        title: ' Plan Dashboard',
        intro: 'Track the active execution plan, item status, phase grouping, and overall completion.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' No active execution plan',
              'Use /plan to create a plan and the execution dashboard will populate here.',
              [],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }
    return this.renderPlan(plan, width, height);
  }

  // --------------------------------------------------------------------------
  // Empty state
  // --------------------------------------------------------------------------

  private renderPlan(plan: ExecutionPlan, width: number, height: number): Line[] {
    const phaseOrder: string[] = [];
    const byPhase = new Map<string, PlanItem[]>();
    for (const item of plan.items) {
      if (!byPhase.has(item.phase)) {
        byPhase.set(item.phase, []);
        phaseOrder.push(item.phase);
      }
      byPhase.get(item.phase)!.push(item);
    }

    // Build a set of complete item IDs for dependency blocking detection
    const completeIds = new Set(
      plan.items
        .filter((i) => i.status === 'complete' || i.status === 'skipped')
        .map((i) => i.id),
    );

    let rowCount = 0;
    const planLines: Line[] = [];

    for (const phase of phaseOrder) {
      const items = byPhase.get(phase)!;
      planLines.push(this.renderPhaseHeaderLine(phase, items, width));
      for (const item of items) {
        const isSelected = rowCount === this.selectedIndex;
        const isBlocked =
          item.status === 'pending' &&
          item.dependencies !== undefined &&
          item.dependencies.length > 0 &&
          !item.dependencies.every((depId) => completeIds.has(depId));

        planLines.push(this.renderItem(item, isSelected, isBlocked, width));
        rowCount++;
      }
    }

    this.totalRows = rowCount;
    if (this.selectedIndex >= this.totalRows) {
      this.selectedIndex = Math.max(0, this.totalRows - 1);
    }
    const window = getTrackedVisibleWindow(planLines.length, this.selectedIndex, Math.max(8, height - 8), this.scrollOffset, 1);
    this.scrollOffset = window.start;

    const total = plan.items.length;
    const done = plan.items.filter((i) => i.status === 'complete' || i.status === 'skipped').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const summary: PanelWorkspaceSection = {
      title: 'Summary',
      lines: [
        buildPanelLine(width, [
          [' Status ', DEFAULT_PANEL_PALETTE.label],
          [plan.status, this.statusColor(plan.status)],
          ['   Progress ', DEFAULT_PANEL_PALETTE.label],
          [`${pct}%`, pct === 100 ? DEFAULT_PANEL_PALETTE.good : DEFAULT_PANEL_PALETTE.info],
          ['   Items ', DEFAULT_PANEL_PALETTE.label],
          [`${done}/${total}`, DEFAULT_PANEL_PALETTE.value],
        ]),
      ],
    };

    return buildPanelWorkspace(width, height, {
      title: ` Plan Dashboard`,
      intro: plan.title,
      sections: [
        summary,
        { title: 'Execution Plan', lines: planLines.slice(window.start, window.end) },
      ],
      footerLines: [
        buildPanelLine(width, [[' Up/Down', DEFAULT_PANEL_PALETTE.info], [' navigate', DEFAULT_PANEL_PALETTE.dim]]),
      ],
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  // --------------------------------------------------------------------------
  // Header — title + overall completion percentage
  // --------------------------------------------------------------------------

  private renderPhaseHeaderLine(phase: string, items: PlanItem[], width: number): Line {
    const done = items.filter(
      (i) => i.status === 'complete' || i.status === 'skipped',
    ).length;
    const total = items.length;
    const active = items.some((i) => i.status === 'in_progress');
    const failed = items.some((i) => i.status === 'failed');

    const phaseFg = failed ? '#ef4444' : active ? '#00ffff' : done === total ? '#22c55e' : '250';

    const barW = 8;
    const filledB = total > 0 ? Math.round((done / total) * barW) : 0;
    const bar = '#'.repeat(filledB) + '-'.repeat(barW - filledB);

    const progressText = `[${bar}] ${done}/${total}`;
    const phaseText = ` > ${phase}`;
    const spacer = Math.max(1, width - phaseText.length - progressText.length - 1);
    return buildPanelLine(width, [
      [phaseText, phaseFg],
      [' '.repeat(spacer), phaseFg],
      [progressText, phaseFg],
      [' ', phaseFg],
    ]);
  }

  // --------------------------------------------------------------------------
  // Individual item
  // --------------------------------------------------------------------------

  private renderItem(
    item: PlanItem,
    isSelected: boolean,
    isBlocked: boolean,
    width: number,
  ): Line {
    const icon = STATUS_ICON[item.status];
    const fg = isBlocked ? '238' : STATUS_FG[item.status];
    const dim = item.status === 'skipped' || isBlocked;

    // Indent blocked items to visually signal they depend on others
    const indent = isBlocked ? '      ' : '   ';
    const selectedMark = isSelected ? '▸' : ' ';

    let text = `${selectedMark}${indent}${icon} ${item.description}`;

    // Append agent ID for in-progress and complete items
    if (item.agentId && (item.status === 'in_progress' || item.status === 'complete')) {
      text += ` [${item.agentId}]`;
    }

    // Append dependency note for blocked items (first unmet dep description)
    if (isBlocked && item.dependencies && item.dependencies.length > 0) {
      text += ' (blocked)';
    }

    return buildPanelLine(width, [[text, fg, isSelected ? '#1e293b' : undefined]]);
  }

  private statusColor(status: ExecutionPlan['status']): string {
    return status === 'complete'
      ? DEFAULT_PANEL_PALETTE.good
      : status === 'failed'
      ? DEFAULT_PANEL_PALETTE.bad
      : status === 'active'
      ? DEFAULT_PANEL_PALETTE.info
      : DEFAULT_PANEL_PALETTE.dim;
  }
}
