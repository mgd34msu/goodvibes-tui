import type { Line } from '../types/grid.ts';
import type { ExecutionPlan, PlanItem, PlanItemStatus } from '@pellux/goodvibes-sdk/platform/core';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { BasePanel } from './base-panel.ts';
import type { PlanDashboardQuery } from '../runtime/ui-service-queries.ts';
import {
  buildEmptyState,
  buildKeyboardHints,
  buildKeyValueLine,
  buildMeterLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildSelectablePanelLine,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelWorkspaceSection,
} from './polish.ts';

// ---------------------------------------------------------------------------
// Palette (no inline hex in render bodies)
// ---------------------------------------------------------------------------

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  complete: '#22c55e',
  active: '#00ffff',
  pending: '#94a3b8',
  failed: '#ef4444',
  skipped: '#64748b',
  blocked: '#f97316',
  selectBg: '#1e293b',
  phase: '#cbd5e1',
});

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
  complete: C.complete,
  in_progress: C.active,
  pending: C.pending,
  failed: C.failed,
  skipped: C.skipped,
};

// ---------------------------------------------------------------------------
// PlanDashboardPanel
// ---------------------------------------------------------------------------

export class PlanDashboardPanel extends BasePanel {
  private scrollOffset = 0;
  private selectedIndex = 0;

  // Flat list of navigable row indices (set during render)
  private totalRows = 0;
  // Item flat-list parallel to navigable rows (set during render) for detail.
  private navItems: PlanItem[] = [];
  private blockedItemIds = new Set<string>();
  private readonly planManager: PlanDashboardQuery;

  constructor(planManager: PlanDashboardQuery) {
    super('plan', 'Plan', 'P', 'agent');
    this.planManager = planManager;
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
    } else if (key === 'home' || key === 'g') {
      if (this.selectedIndex !== 0) {
        this.selectedIndex = 0;
        this.markDirty();
      }
      return true;
    } else if (key === 'end' || key === 'G') {
      const last = Math.max(0, this.totalRows - 1);
      if (this.selectedIndex !== last) {
        this.selectedIndex = last;
        this.markDirty();
      }
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
    const plan = this.planManager.getActive();
    if (!plan) {
      return buildPanelWorkspace(width, height, {
        title: ' Plan Dashboard',
        intro: 'Track the active execution plan, item status, phase grouping, and overall completion.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' No active execution plan',
              'No plan is being executed yet. Create one and its phases, progress, blocked steps, and next action surface here.',
              [
                { command: '/plan', summary: 'create an execution plan to populate this dashboard' },
              ],
              C,
            ),
          },
        ],
        palette: C,
      });
    }
    return this.renderPlan(plan, width, height);
    });
  }

  // --------------------------------------------------------------------------
  // Plan render
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

    const isBlocked = (item: PlanItem): boolean =>
      item.status === 'pending' &&
      item.dependencies !== undefined &&
      item.dependencies.length > 0 &&
      !item.dependencies.every((depId) => completeIds.has(depId));

    let rowCount = 0;
    let selectedLineIndex = 0;
    const planLines: Line[] = [];
    const navItems: PlanItem[] = [];
    const blockedItemIds = new Set<string>();

    for (const phase of phaseOrder) {
      const items = byPhase.get(phase)!;
      planLines.push(this.renderPhaseHeaderLine(phase, items, width));
      for (const item of items) {
        const isSelected = rowCount === this.selectedIndex;
        if (isSelected) selectedLineIndex = planLines.length;
        const blocked = isBlocked(item);
        if (blocked) blockedItemIds.add(item.id);
        navItems.push(item);
        planLines.push(this.renderItem(item, isSelected, blocked, width));
        rowCount++;
      }
    }

    this.totalRows = rowCount;
    this.navItems = navItems;
    this.blockedItemIds = blockedItemIds;
    if (this.selectedIndex >= this.totalRows) {
      this.selectedIndex = Math.max(0, this.totalRows - 1);
    }

    const total = plan.items.length;
    const done = plan.items.filter((i) => i.status === 'complete' || i.status === 'skipped').length;
    const inProgress = plan.items.filter((i) => i.status === 'in_progress').length;
    const failed = plan.items.filter((i) => i.status === 'failed').length;
    const blockedCount = blockedItemIds.size;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    // The single most useful pointer: what should happen next. Prefer the first
    // in-progress item, else the first actionable (unblocked) pending item.
    const nextItem = plan.items.find((i) => i.status === 'in_progress')
      ?? plan.items.find((i) => i.status === 'pending' && !isBlocked(i));

    const meterWidth = Math.max(10, Math.min(28, width - 30));
    const summary: PanelWorkspaceSection = {
      title: 'Summary',
      lines: [
        buildPanelLine(width, [
          [' Status ', C.label],
          [plan.status, this.statusColor(plan.status)],
          ['   ', C.label],
          [`${done}/${total} items`, C.value],
          ['  ', C.label],
          [`${pct}%`, pct === 100 ? C.good : C.info],
        ]),
        buildMeterLine(width, Math.round((pct / 100) * meterWidth), meterWidth, {
          filled: pct === 100 ? C.good : C.info,
          empty: C.empty,
          label: C.label,
        }, { prefix: ' Progress ', suffix: ` ${pct}% ` }),
        buildKeyValueLine(width, [
          { label: 'in progress', value: String(inProgress), valueColor: inProgress > 0 ? C.active : C.dim },
          { label: 'blocked', value: String(blockedCount), valueColor: blockedCount > 0 ? C.blocked : C.dim },
          { label: 'failed', value: String(failed), valueColor: failed > 0 ? C.bad : C.dim },
        ], C),
        nextItem
          ? buildPanelLine(width, [
              [' Next ', C.label],
              [STATUS_ICON[nextItem.status], STATUS_FG[nextItem.status]],
              [' ', C.label],
              [truncateDisplay(nextItem.description, Math.max(8, width - 9)), C.value],
            ])
          : buildPanelLine(width, [
              [' Next ', C.label],
              [failed > 0 ? 'review failed steps' : blockedCount > 0 ? 'unblock dependencies' : 'plan complete',
                failed > 0 ? C.bad : blockedCount > 0 ? C.blocked : C.good],
            ]),
      ],
    };

    const detailSection = this.buildDetailSection(width);
    const footerLines = this.footerLines(width);

    const planSection = resolveScrollablePanelSection(width, height, {
      intro: plan.title,
      footerLines,
      palette: C,
      beforeSections: [summary],
      afterSections: detailSection ? [detailSection] : [],
      section: {
        title: 'Execution Plan',
        scrollableLines: planLines,
        selectedIndex: selectedLineIndex,
        scrollOffset: this.scrollOffset,
        minRows: 6,
        appendWindowSummary: { dimColor: C.dim },
      },
    });
    this.scrollOffset = planSection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ` Plan Dashboard`,
      intro: plan.title,
      sections: [
        summary,
        planSection.section,
        ...(detailSection ? [detailSection] : []),
      ],
      footerLines,
      palette: C,
    });
  }

  private buildDetailSection(width: number): PanelWorkspaceSection | null {
    const item = this.navItems[this.selectedIndex];
    if (!item) return null;
    const blocked = this.blockedItemIds.has(item.id);
    const lines: Line[] = [
      buildPanelLine(width, [
        [' ', C.label],
        [STATUS_ICON[item.status], STATUS_FG[item.status]],
        [' ', C.label],
        [truncateDisplay(item.description, Math.max(8, width - 4)), C.value],
      ]),
      buildKeyValueLine(width, [
        { label: 'phase', value: item.phase, valueColor: C.phase },
        { label: 'status', value: blocked ? 'blocked' : item.status.replace(/_/g, ' '), valueColor: blocked ? C.blocked : STATUS_FG[item.status] },
        ...(item.agentId ? [{ label: 'agent', value: item.agentId, valueColor: C.info }] : []),
      ], C),
    ];
    if (item.dependencies && item.dependencies.length > 0) {
      lines.push(buildPanelLine(width, [
        [' depends on ', C.label],
        [truncateDisplay(item.dependencies.join(', '), Math.max(8, width - 13)), blocked ? C.blocked : C.dim],
      ]));
    }
    return { title: 'Selected Step', lines };
  }

  private footerLines(width: number): Line[] {
    return [
      buildKeyboardHints(width, [
        { keys: this.totalRows > 0 ? `${this.selectedIndex + 1}/${this.totalRows}` : '0/0', label: 'step' },
        { keys: '↑/↓', label: 'navigate' },
        { keys: 'Home/End', label: 'jump' },
      ], C),
    ];
  }

  // --------------------------------------------------------------------------
  // Phase header — title + progress meter
  // --------------------------------------------------------------------------

  private renderPhaseHeaderLine(phase: string, items: PlanItem[], width: number): Line {
    const done = items.filter(
      (i) => i.status === 'complete' || i.status === 'skipped',
    ).length;
    const total = items.length;
    const active = items.some((i) => i.status === 'in_progress');
    const failed = items.some((i) => i.status === 'failed');

    const phaseFg = failed ? C.failed : active ? C.active : done === total ? C.complete : C.phase;

    const barW = 8;
    const filledB = total > 0 ? Math.round((done / total) * barW) : 0;
    const progressText = ` ${done}/${total}`;
    const label = truncateDisplay(phase, Math.max(4, width - barW - progressText.length - 6));

    return buildSelectablePanelLine(width, [
      { text: ` ${active ? '▸' : '▪'} `, fg: phaseFg, bold: true },
      { text: label, fg: phaseFg, bold: true },
      { text: '  ', fg: C.dim },
      { text: '▰'.repeat(filledB) + '▱'.repeat(barW - filledB), fg: phaseFg },
      { text: progressText, fg: C.dim },
    ], { fillBg: C.sectionBg });
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
    const fg = isBlocked ? C.blocked : STATUS_FG[item.status];
    const dim = item.status === 'skipped';

    // Indent blocked items to visually signal they depend on others
    const indent = isBlocked ? '     ' : '  ';
    const agentTag = item.agentId && (item.status === 'in_progress' || item.status === 'complete')
      ? ` [${item.agentId}]`
      : '';
    const blockedTag = isBlocked ? '  ⊘ blocked' : '';
    const reserve = indent.length + 2 + agentTag.length + blockedTag.length;
    const desc = truncateDisplay(item.description, Math.max(6, width - reserve - 2));

    return buildSelectablePanelLine(width, [
      { text: `${indent}${icon} `, fg, dim, bold: item.status === 'in_progress' },
      { text: desc, fg, dim },
      { text: agentTag, fg: C.info },
      { text: blockedTag, fg: C.blocked },
    ], {
      selected: isSelected,
      selectedBg: C.selectBg,
      leadingMarker: '▸',
    });
  }

  private statusColor(status: ExecutionPlan['status']): string {
    return status === 'complete'
      ? C.good
      : status === 'failed'
      ? C.bad
      : status === 'active'
      ? C.info
      : C.dim;
  }
}
