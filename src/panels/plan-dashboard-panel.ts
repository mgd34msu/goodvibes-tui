import type { Line } from '../types/grid.ts';
import type { ExecutionPlan, PlanItem, PlanItemStatus } from '../core/execution-plan.ts';
import { BasePanel } from './base-panel.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { planManager } from '../core/plan-manager-instance.ts';

// ---------------------------------------------------------------------------
// Status display maps
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<PlanItemStatus, string> = {
  complete: '✓',
  in_progress: '◆',
  pending: '○',
  failed: '✗',
  skipped: '⊘',
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
    // Always read fresh plan state from disk
    const plan = planManager.getActive();

    const lines: Line[] = [];

    if (!plan) {
      lines.push(...this.renderEmptyState(width));
    } else {
      lines.push(...this.renderPlan(plan, width, height));
    }

    // Pad to fill height
    while (lines.length < height) {
      lines.push(UIFactory.stringToLine('', width));
    }

    // Slice to viewport height
    return lines.slice(0, height);
  }

  // --------------------------------------------------------------------------
  // Empty state
  // --------------------------------------------------------------------------

  private renderEmptyState(width: number): Line[] {
    const lines: Line[] = [];
    lines.push(UIFactory.stringToLine('', width));
    lines.push(
      UIFactory.stringToLine(
        ' No active execution plan.',
        width,
        { fg: '244', dim: true },
      ),
    );
    lines.push(UIFactory.stringToLine('', width));
    lines.push(
      UIFactory.stringToLine(
        ' Use /plan to create a plan.',
        width,
        { fg: '238', dim: true },
      ),
    );
    return lines;
  }

  // --------------------------------------------------------------------------
  // Plan rendering
  // --------------------------------------------------------------------------

  private renderPlan(plan: ExecutionPlan, width: number, height: number): Line[] {
    const allLines: Line[] = [];

    // --- Overall header ---
    allLines.push(...this.renderHeader(plan, width));
    allLines.push(UIFactory.stringToLine('', width));

    // --- Group items by phase ---
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

    // Track navigable row count for cursor clamping
    let rowCount = 0;

    for (const phase of phaseOrder) {
      const items = byPhase.get(phase)!;

      // Phase header
      allLines.push(...this.renderPhaseHeader(phase, items, width));

      // Phase items
      for (const item of items) {
        const isSelected = rowCount === this.selectedIndex;
        const isBlocked =
          item.status === 'pending' &&
          item.dependencies !== undefined &&
          item.dependencies.length > 0 &&
          !item.dependencies.every((depId) => completeIds.has(depId));

        allLines.push(...this.renderItem(item, isSelected, isBlocked, width));
        rowCount++;
      }

      allLines.push(UIFactory.stringToLine('', width));
    }

    // Store total navigable rows for key handling
    this.totalRows = rowCount;

    // Clamp selectedIndex
    if (this.selectedIndex >= this.totalRows) {
      this.selectedIndex = Math.max(0, this.totalRows - 1);
    }

    // Scroll so selected row stays visible.
    // Header is 2 lines (header + blank), each phase adds 1 header line + items + 1 blank.
    // Approximate: find selected item's output line index.
    this.adjustScroll(allLines.length, height);

    return allLines.slice(this.scrollOffset);
  }

  // --------------------------------------------------------------------------
  // Header — title + overall completion percentage
  // --------------------------------------------------------------------------

  private renderHeader(plan: ExecutionPlan, width: number): Line[] {
    const total = plan.items.length;
    const done = plan.items.filter(
      (i) => i.status === 'complete' || i.status === 'skipped',
    ).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const statusFg =
      plan.status === 'complete'
        ? '#22c55e'
        : plan.status === 'failed'
        ? '#ef4444'
        : plan.status === 'active'
        ? '#00ffff'
        : '244';

    const titleText = ` ${plan.title}`;
    const pctText = `${pct}% `;
    const pad = Math.max(1, width - titleText.length - pctText.length);
    const headerText = titleText + ' '.repeat(pad) + pctText;

    const headerLine = UIFactory.stringToLine(headerText.slice(0, width), width, {
      fg: statusFg,
      bold: true,
    });

    // Render completion bar below title
    const barWidth = Math.min(width - 4, 40);
    const filled = Math.round((pct / 100) * barWidth);
    const empty = barWidth - filled;
    const barStr = '  ' + '█'.repeat(filled) + '░'.repeat(empty) + `  ${done}/${total} items`;
    const barLine = UIFactory.stringToLine(barStr.slice(0, width), width, {
      fg: pct === 100 ? '#22c55e' : pct > 50 ? '#00ffff' : '244',
    });

    // Separator
    const sepLine = UIFactory.stringToLine('─'.repeat(width), width, { fg: '238' });

    return [headerLine, barLine, sepLine];
  }

  // --------------------------------------------------------------------------
  // Phase header with progress bar
  // --------------------------------------------------------------------------

  private renderPhaseHeader(phase: string, items: PlanItem[], width: number): Line[] {
    const done = items.filter(
      (i) => i.status === 'complete' || i.status === 'skipped',
    ).length;
    const total = items.length;
    const active = items.some((i) => i.status === 'in_progress');
    const failed = items.some((i) => i.status === 'failed');

    const phaseFg = failed ? '#ef4444' : active ? '#00ffff' : done === total ? '#22c55e' : '250';

    const barW = 8;
    const filledB = total > 0 ? Math.round((done / total) * barW) : 0;
    const bar = '█'.repeat(filledB) + '░'.repeat(barW - filledB);

    const progressText = `[${bar}] ${done}/${total}`;
    const phaseText = ` ▸ ${phase}`;
    const pad = Math.max(1, width - phaseText.length - progressText.length - 1);
    const full = phaseText + ' '.repeat(pad) + progressText + ' ';

    return [
      UIFactory.stringToLine(full.slice(0, width), width, { fg: phaseFg, bold: true }),
    ];
  }

  // --------------------------------------------------------------------------
  // Individual item
  // --------------------------------------------------------------------------

  private renderItem(
    item: PlanItem,
    isSelected: boolean,
    isBlocked: boolean,
    width: number,
  ): Line[] {
    const icon = STATUS_ICON[item.status];
    const fg = isBlocked ? '238' : STATUS_FG[item.status];
    const dim = item.status === 'skipped' || isBlocked;

    // Indent blocked items to visually signal they depend on others
    const indent = isBlocked ? '      ' : '   ';
    const selectedMark = isSelected ? '▶' : ' ';

    let text = `${selectedMark}${indent}${icon} ${item.description}`;

    // Append agent ID for in-progress and complete items
    if (item.agentId && (item.status === 'in_progress' || item.status === 'complete')) {
      text += ` [${item.agentId}]`;
    }

    // Append dependency note for blocked items (first unmet dep description)
    if (isBlocked && item.dependencies && item.dependencies.length > 0) {
      text += ' (blocked)';
    }

    // Truncate to width
    if (text.length > width) {
      text = text.slice(0, width - 1) + '…';
    }

    const line = UIFactory.stringToLine(text.padEnd(width).slice(0, width), width, {
      fg,
      dim,
      bg: isSelected ? '#1e293b' : '',
    });

    return [line];
  }

  // --------------------------------------------------------------------------
  // Scroll adjustment
  // --------------------------------------------------------------------------

  private adjustScroll(totalLineCount: number, height: number): void {
    // Approximate line position of selected item:
    // header (3) + blank (1) = 4 fixed lines at top before phase groups.
    // Each phase group: 1 header + N items + 1 blank. We don't track exact
    // offsets here, so we use a simple heuristic: scroll to keep selected
    // near the vertical center of the viewport.
    const visibleRows = height - 4; // leave header visible
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visibleRows) {
      this.scrollOffset = this.selectedIndex - visibleRows + 1;
    }
    // Clamp
    const maxOffset = Math.max(0, totalLineCount - height);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
    if (this.scrollOffset < 0) this.scrollOffset = 0;
  }
}
