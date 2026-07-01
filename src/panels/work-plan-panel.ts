import type { Line } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildDetailBlock,
  buildGuidanceLine,
  buildKeyboardHints,
  buildKeyValueLine,
  buildMeterLine,
  buildPanelLine,
  buildPanelListRow,
  buildSummaryBlock,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelPalette,
} from './polish.ts';
import type { WorkPlanItem, WorkPlanItemStatus, WorkPlanStore } from '../work-plans/work-plan-store.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  pending: '#94a3b8',
  inProgress: '#38bdf8',
  blocked: '#f59e0b',
  done: '#22c55e',
  failed: '#ef4444',
  cancelled: '#64748b',
  accent: '#a5b4fc',
  selectBg: '#1e293b',
});

const STATUS_LABEL: Record<WorkPlanItemStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  blocked: '[!]',
  done: '[x]',
  failed: '[x]',
  cancelled: '[-]',
};

const STATUS_COLOR: Record<WorkPlanItemStatus, string> = {
  pending: C.pending,
  in_progress: C.inProgress,
  blocked: C.blocked,
  done: C.done,
  failed: C.failed,
  cancelled: C.cancelled,
};

const STATUS_ORDER: WorkPlanItemStatus[] = ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'];

function compactDate(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}

function statusName(status: WorkPlanItemStatus): string {
  return status.replace(/_/g, ' ');
}

export class WorkPlanPanel extends ScrollableListPanel<WorkPlanItem> {
  private items: readonly WorkPlanItem[] = [];
  private lastPlanUpdatedAt = 0;

  constructor(private readonly store: WorkPlanStore) {
    super('work-plan', 'Work Plan', 'L', 'agent');
    this.showSelectionGutter = true;
  }

  onActivate(): void {
    super.onActivate();
    this.refresh();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  render(width: number, height: number): Line[] {
    this.refresh();
    return this.renderList(width, height, {
      title: 'Work Plan',
      header: this.renderHeader(width),
      footer: this.renderFooter(width),
    });
  }

  handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();
    const item = this.items[this.selectedIndex];
    try {
      switch (key) {
        case ' ':
        case 'return':
        case 'enter':
          if (!item) return false;
          this.store.cycleItemStatus(item.id);
          this.refresh();
          return true;
        case '1':
          return this.setSelectedStatus('pending');
        case '2':
          return this.setSelectedStatus('in_progress');
        case '3':
          return this.setSelectedStatus('blocked');
        case '4':
          return this.setSelectedStatus('done');
        case '5':
          return this.setSelectedStatus('failed');
        case '6':
          return this.setSelectedStatus('cancelled');
        case 'd':
        case 'delete':
          if (!item) return false;
          this.store.removeItem(item.id);
          this.refresh();
          return true;
        case 'c':
          this.store.clearCompleted();
          this.refresh();
          return true;
        case 'r':
          this.refresh(true);
          return true;
        default:
          return super.handleInput(key);
      }
    } catch (error) {
      this.setError(summarizeError(error));
      return true;
    }
  }

  protected getItems(): readonly WorkPlanItem[] {
    return this.items;
  }

  protected override getEmptyStateMessage(): string {
    return ' No work plan items yet';
  }

  protected getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/work-plan add <title>', summary: 'add a persistent item that survives across sessions' },
      { command: '/work-plan list', summary: 'print the current plan to the shell' },
    ];
  }

  protected renderItem(item: WorkPlanItem, _index: number, selected: boolean, width: number): Line {
    const status = STATUS_LABEL[item.status];
    const owner = item.owner ? ` @${item.owner}` : '';
    const source = item.source ? ` (${item.source})` : '';
    const reserve = status.length + owner.length + source.length + 4;
    const title = truncateDisplay(item.title, Math.max(6, width - reserve));
    return buildPanelListRow(width, [
      { text: `${status} `, fg: STATUS_COLOR[item.status], bold: item.status === 'in_progress' },
      { text: title, fg: selected ? C.value : C.label, bold: selected || item.status === 'in_progress' },
      { text: owner, fg: C.accent },
      { text: source, fg: C.dim },
    ], C, { selected, selectedBg: C.selectBg });
  }

  private setSelectedStatus(status: WorkPlanItemStatus): boolean {
    const item = this.items[this.selectedIndex];
    if (!item) return false;
    this.store.setItemStatus(item.id, status);
    this.refresh();
    return true;
  }

  private refresh(force = false): void {
    const plan = this.store.getActivePlan();
    if (!force && plan.updatedAt === this.lastPlanUpdatedAt && this.items.length === plan.items.length) return;
    this.items = plan.items;
    this.lastPlanUpdatedAt = plan.updatedAt;
    this.clampSelection();
    this.needsRender = true;
  }

  private renderHeader(width: number): Line[] {
    const plan = this.store.getActivePlan();
    const counts = new Map<WorkPlanItemStatus, number>();
    for (const status of STATUS_ORDER) counts.set(status, 0);
    for (const item of plan.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);

    const total = plan.items.length;
    const done = (counts.get('done') ?? 0) + (counts.get('cancelled') ?? 0);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const meterWidth = Math.max(10, Math.min(26, width - 34));

    const postureLines: Line[] = [
      buildPanelLine(width, [
        [' Project ', C.label],
        [truncateDisplay(plan.projectRoot, Math.max(8, width - 11)), C.value],
      ]),
      buildMeterLine(width, Math.round((pct / 100) * meterWidth), meterWidth, {
        filled: pct === 100 ? C.done : C.inProgress,
        empty: C.empty,
        label: C.label,
      }, { prefix: ' Progress ', suffix: ` ${done}/${total} (${pct}%) ` }),
      buildKeyValueLine(width, [
        { label: 'pending', value: String(counts.get('pending') ?? 0), valueColor: (counts.get('pending') ?? 0) > 0 ? C.pending : C.dim },
        { label: 'active', value: String(counts.get('in_progress') ?? 0), valueColor: (counts.get('in_progress') ?? 0) > 0 ? C.inProgress : C.dim },
        { label: 'blocked', value: String(counts.get('blocked') ?? 0), valueColor: (counts.get('blocked') ?? 0) > 0 ? C.blocked : C.dim },
        { label: 'done', value: String(counts.get('done') ?? 0), valueColor: (counts.get('done') ?? 0) > 0 ? C.done : C.dim },
      ], C),
      buildGuidanceLine(width, '/work-plan add <title>', 'append a persistent item to the active plan', C),
    ];

    const header: Line[] = buildSummaryBlock(width, 'Persistent Work Plan', postureLines, C);

    const active = this.items[this.selectedIndex];
    if (active) {
      const detailRows: Line[] = [
        buildPanelLine(width, [
          [' ', C.label],
          [STATUS_LABEL[active.status], STATUS_COLOR[active.status]],
          [' ', C.label],
          [truncateDisplay(active.title, Math.max(8, width - 6)), C.value],
        ]),
        buildKeyValueLine(width, [
          { label: 'status', value: statusName(active.status), valueColor: STATUS_COLOR[active.status] },
          ...(active.owner ? [{ label: 'owner', value: active.owner, valueColor: C.accent }] : []),
          { label: 'updated', value: compactDate(active.updatedAt), valueColor: C.dim },
        ], C),
      ];
      if (active.source) {
        detailRows.push(buildPanelLine(width, [[' source ', C.label], [active.source, C.info]]));
      }
      if (active.notes) {
        detailRows.push(buildPanelLine(width, [
          [' notes ', C.label],
          [truncateDisplay(active.notes, Math.max(8, width - 8)), C.value],
        ]));
      }
      header.push(...buildDetailBlock(width, 'Selected item', detailRows, C));
    }
    return header;
  }

  private renderFooter(width: number): Line[] {
    const hasItem = this.items.length > 0;
    if (!hasItem) {
      return [
        buildKeyboardHints(width, [
          { keys: '↑/↓', label: 'navigate' },
        ], C),
      ];
    }
    return [
      buildKeyboardHints(width, [
        { keys: this.items.length > 0 ? `${this.selectedIndex + 1}/${this.items.length}` : '0/0', label: 'item' },
        { keys: 'Enter', label: 'cycle status' },
        { keys: '1-6', label: 'set status' },
        { keys: 'd', label: 'delete' },
        { keys: 'c', label: 'clear done' },
        { keys: 'r', label: 'refresh' },
      ], C),
      buildPanelLine(width, [
        [' 1', C.info], [' pending  ', C.dim],
        ['2', C.info], [' active  ', C.dim],
        ['3', C.info], [' blocked  ', C.dim],
        ['4', C.info], [' done  ', C.dim],
        ['5', C.info], [' failed  ', C.dim],
        ['6', C.info], [' cancelled', C.dim],
      ]),
    ];
  }
}
