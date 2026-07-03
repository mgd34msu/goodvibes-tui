import type { Line } from '../types/grid.ts';
import type { ExecutionPlan, ExecutionPlanManager, PlanItem, PlanItemStatus } from '@pellux/goodvibes-sdk/platform/core';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { BasePanel } from './base-panel.ts';
import { AgentInspectorPanel } from './agent-inspector-panel.ts';
import type { PanelIntegrationContext } from './types.ts';
import type { WorkflowEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '../runtime/ui-events.ts';
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
// Deps
// ---------------------------------------------------------------------------

/**
 * The subset of ExecutionPlanManager the dashboard needs: the live active
 * plan (getActive) plus history/switching support (list/getSummary/
 * toMarkdown — the same trio /plan list|show consume, planning-runtime.ts:
 * 140-165) so the panel can browse and view any plan on disk, not just the
 * currently active one.
 */
export interface PlanDashboardPanelDeps {
  readonly planManager: Pick<ExecutionPlanManager, 'getActive' | 'list' | 'getSummary' | 'toMarkdown'>;
}

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

  /**
   * The plan item under the cursor. This panel owns its own selection state
   * (`selectedIndex` navigates the `this.navItems` flat list directly), so
   * every selected-row read routes through this one accessor — indexing
   * `this.navItems` by the cursor directly is banned by the
   * no-raw-selectedindex-read architecture rule.
   */
  private selectedNavItem(): PlanItem | undefined {
    return this.navItems.at(this.selectedIndex);
  }

  // Plan history / switching (planManager.list()/getSummary()/toMarkdown()).
  // `viewingPlanId` is null while following the live active plan; once set,
  // the dashboard renders that specific plan from disk instead.
  private viewingPlanId: string | null = null;
  private historyMode = false;
  private historyPlans: ExecutionPlan[] = [];
  private historySelectedIndex = 0;
  private historyScrollOffset = 0;

  // Live-refresh subscriptions (WrfcPanel pattern: subscribe ui.events.workflows
  // so the dashboard updates during a run without requiring a keypress).
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly workflowEvents: UiEventFeed<WorkflowEvent>,
    private readonly deps: PlanDashboardPanelDeps,
  ) {
    super('plan', 'Plan', '▤', 'agent');
    this.subscribeToEvents();
  }

  override onActivate(): void {
    super.onActivate();
    // Re-read plan from disk each time the panel is activated
    this.markDirty();
  }

  override onDestroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    super.onDestroy();
  }

  // --------------------------------------------------------------------------
  // Live refresh — mirrors WrfcPanel: any workflow event may have changed the
  // active plan's item statuses (WRFC updates plan items via
  // wrfcController.setPlanManager, main.ts:120), so re-render without
  // requiring a keypress.
  // --------------------------------------------------------------------------

  private subscribeToEvents(): void {
    const refresh = () => this.markDirty();
    this.unsubscribers.push(
      this.workflowEvents.on('WORKFLOW_CHAIN_CREATED', refresh),
      this.workflowEvents.on('WORKFLOW_STATE_CHANGED', refresh),
      this.workflowEvents.on('WORKFLOW_REVIEW_COMPLETED', refresh),
      this.workflowEvents.on('WORKFLOW_FIX_ATTEMPTED', refresh),
      this.workflowEvents.on('WORKFLOW_GATE_RESULT', refresh),
      this.workflowEvents.on('WORKFLOW_CHAIN_PASSED', refresh),
      this.workflowEvents.on('WORKFLOW_CHAIN_FAILED', refresh),
      this.workflowEvents.on('WORKFLOW_AUTO_COMMITTED', refresh),
      this.workflowEvents.on('WORKFLOW_CASCADE_ABORTED', refresh),
    );
  }

  // --------------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------------

  handleInput(key: string): boolean {
    if (this.historyMode) {
      return this.handleHistoryInput(key);
    }
    if (key === 'h') {
      this.enterHistoryMode();
      return true;
    }
    if (key === 'a' && this.viewingPlanId !== null) {
      this.viewingPlanId = null;
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
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
    } else if (key === 'enter' || key === 'return') {
      // Consumed here (so the integration router fires next) only when the
      // selected item actually has an agent to jump to; see
      // handlePanelIntegrationAction below.
      const item = this.selectedNavItem();
      if (item?.agentId) return true;
    }
    return false;
  }

  /**
   * Cross-panel jump: Enter on a plan item with an assigned agent opens the
   * Inspector focused on that agent (inspectAgent, WO-110). The inspector
   * already renders a WRFC badge for the inspected agent, so this also
   * cross-links the owning WRFC chain without the dashboard needing to know
   * about WrfcController directly.
   */
  handlePanelIntegrationAction(key: string, ctx: PanelIntegrationContext): boolean {
    if (this.historyMode) return false;
    if (key !== 'enter' && key !== 'return') return false;
    const item = this.selectedNavItem();
    if (!item?.agentId) return false;
    const inspector = ctx.panelManager.open('inspector');
    if (inspector instanceof AgentInspectorPanel) {
      inspector.inspectAgent(item.agentId);
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // Plan history / switching
  // --------------------------------------------------------------------------

  private enterHistoryMode(): void {
    this.historyPlans = [...this.deps.planManager.list()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    this.historySelectedIndex = 0;
    this.historyScrollOffset = 0;
    this.historyMode = true;
    this.markDirty();
  }

  private handleHistoryInput(key: string): boolean {
    if (key === 'up' || key === 'k') {
      if (this.historySelectedIndex > 0) {
        this.historySelectedIndex--;
        this.markDirty();
      }
      return true;
    }
    if (key === 'down' || key === 'j') {
      if (this.historySelectedIndex < this.historyPlans.length - 1) {
        this.historySelectedIndex++;
        this.markDirty();
      }
      return true;
    }
    if (key === 'enter' || key === 'return') {
      const plan = this.historyPlans[this.historySelectedIndex];
      if (plan) {
        this.viewingPlanId = plan.id;
        this.selectedIndex = 0;
      }
      this.historyMode = false;
      this.markDirty();
      return true;
    }
    if (key === 'escape' || key === 'h') {
      this.historyMode = false;
      this.markDirty();
      return true;
    }
    // Modal browsing: absorb everything else (mirrors ConfirmState's "others
    // absorbed" contract) so stray keys cannot leak into item navigation.
    return true;
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
    if (this.historyMode) {
      return this.renderHistory(width, height);
    }
    const plan = this.resolveViewedPlan();
    if (!plan) {
      return buildPanelWorkspace(width, height, {
        title: ' Plan Dashboard',
        intro: 'Track the active execution plan, item status, phase grouping, and overall completion.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' No active execution plan',
              'Execution plans are produced by WRFC-reviewed tasks (gather-plan-apply execution). Start one from Teamwork and its phases, progress, blocked steps, and next action will surface here.',
              [
                { command: '/teamwork create-mode local-engineer <title>', summary: 'start a WRFC-reviewed engineer task — the only producer of a real execution plan' },
                { command: '/teamwork modes', summary: 'see every reviewMode: wrfc mode that can seed a plan' },
              ],
              C,
            ),
          },
        ],
        footerLines: this.historyFooterHintLines(width),
        palette: C,
      });
    }
    return this.renderPlan(plan, width, height);
    });
  }

  /** Resolve which plan to render: the pinned history selection, or the live active plan. */
  private resolveViewedPlan(): ExecutionPlan | null {
    if (this.viewingPlanId !== null) {
      const found = this.deps.planManager.list().find((p) => p.id === this.viewingPlanId);
      if (found) return found;
      // The pinned plan is gone (e.g. deleted from disk) — fall back to live.
      this.viewingPlanId = null;
    }
    return this.deps.planManager.getActive();
  }

  /** Keyboard hint shown even on the empty state so 'h' (history) stays discoverable. */
  private historyFooterHintLines(width: number): Line[] {
    return [
      buildKeyboardHints(width, [
        { keys: 'h', label: 'plan history' },
      ], C),
    ];
  }

  // --------------------------------------------------------------------------
  // Plan history browser
  // --------------------------------------------------------------------------

  private renderHistory(width: number, height: number): Line[] {
    if (this.historyPlans.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Plan History',
        intro: 'Every execution plan ever created for this project.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' No plans on disk',
              'Plans appear here once a WRFC-reviewed task (gather-plan-apply execution) creates one.',
              [],
              C,
            ),
          },
        ],
        footerLines: [buildKeyboardHints(width, [{ keys: 'Esc / h', label: 'back' }], C)],
        palette: C,
      });
    }

    const activePlan = this.deps.planManager.getActive();
    const rows: Line[] = [];
    let selectedLineIndex = 0;
    for (let i = 0; i < this.historyPlans.length; i++) {
      const plan = this.historyPlans[i]!;
      const isSelected = i === this.historySelectedIndex;
      if (isSelected) selectedLineIndex = rows.length;
      rows.push(this.renderHistoryRow(plan, activePlan?.id === plan.id, isSelected, width));
    }

    const highlighted = this.historyPlans[this.historySelectedIndex];
    const detailSection: PanelWorkspaceSection | null = highlighted ? {
      title: 'Plan Detail',
      lines: this.buildHistoryDetailLines(highlighted, width),
    } : null;

    const footerLines: Line[] = [
      buildKeyboardHints(width, [
        { keys: '↑/↓', label: 'browse' },
        { keys: 'Enter', label: 'view plan' },
        { keys: 'Esc / h', label: 'back' },
      ], C),
    ];

    const intro = `${this.historyPlans.length} plan${this.historyPlans.length === 1 ? '' : 's'} on disk`;
    const historySection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines,
      palette: C,
      afterSections: detailSection ? [detailSection] : [],
      section: {
        title: 'Plan History',
        scrollableLines: rows,
        selectedIndex: selectedLineIndex,
        scrollOffset: this.historyScrollOffset,
        minRows: 6,
      },
    });
    this.historyScrollOffset = historySection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ' Plan History',
      intro,
      sections: [
        historySection.section,
        ...(detailSection ? [detailSection] : []),
      ],
      footerLines,
      palette: C,
    });
  }

  private renderHistoryRow(plan: ExecutionPlan, isActive: boolean, isSelected: boolean, width: number): Line {
    const marker = isActive ? '▶' : ' ';
    const idShort = plan.id.slice(0, 8);
    const statusTag = `[${plan.status.padEnd(8)}]`;
    const prefix = ` ${marker} ${idShort}  ${statusTag} `;
    const label = truncateDisplay(plan.title, Math.max(6, width - prefix.length - 2));
    return buildSelectablePanelLine(width, [
      { text: ` ${marker} `, fg: isActive ? C.good : C.dim, bold: isActive },
      { text: `${idShort}  `, fg: C.dim },
      { text: `${statusTag} `, fg: this.statusColor(plan.status) },
      { text: label, fg: C.value },
    ], {
      selected: isSelected,
      selectedBg: C.selectBg,
      leadingMarker: '▸',
    });
  }

  private buildHistoryDetailLines(plan: ExecutionPlan, width: number): Line[] {
    const lines: Line[] = [
      buildPanelLine(width, [
        [' Summary ', C.label],
        [truncateDisplay(this.deps.planManager.getSummary(plan), Math.max(8, width - 12)), C.value],
      ]),
    ];
    const markdown = this.deps.planManager.toMarkdown(plan)
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(0, 4);
    for (const line of markdown) {
      lines.push(buildPanelLine(width, [
        [' ', C.label],
        [truncateDisplay(line, Math.max(8, width - 3)), C.dim],
      ]));
    }
    return lines;
  }

  // --------------------------------------------------------------------------
  // Plan render
  // --------------------------------------------------------------------------

  private renderPlan(plan: ExecutionPlan, width: number, height: number): Line[] {
    const activePlan = this.deps.planManager.getActive();
    const isHistorical = activePlan?.id !== plan.id;

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

    const historyBanner: PanelWorkspaceSection | null = isHistorical ? {
      lines: [
        buildPanelLine(width, [
          [' Viewing history ', C.warn],
          [plan.status.toUpperCase(), this.statusColor(plan.status)],
          ['  —  press a to return to the live plan', C.dim],
        ]),
      ],
    } : null;

    const detailSection = this.buildDetailSection(width);
    const footerLines = this.footerLines(width);

    const planSection = resolveScrollablePanelSection(width, height, {
      intro: plan.title,
      footerLines,
      palette: C,
      beforeSections: historyBanner ? [historyBanner, summary] : [summary],
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
        ...(historyBanner ? [historyBanner] : []),
        summary,
        planSection.section,
        ...(detailSection ? [detailSection] : []),
      ],
      footerLines,
      palette: C,
    });
  }

  private buildDetailSection(width: number): PanelWorkspaceSection | null {
    const item = this.selectedNavItem();
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
    const hints: Array<{ keys: string; label: string }> = [
      { keys: this.totalRows > 0 ? `${this.selectedIndex + 1}/${this.totalRows}` : '0/0', label: 'step' },
      { keys: '↑/↓', label: 'navigate' },
      { keys: 'Home/End', label: 'jump' },
      { keys: 'h', label: 'history' },
    ];
    const item = this.selectedNavItem();
    if (item?.agentId) hints.push({ keys: 'Enter', label: 'inspect agent' });
    if (this.viewingPlanId !== null) hints.push({ keys: 'a', label: 'back to active' });
    return [buildKeyboardHints(width, hints, C)];
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
