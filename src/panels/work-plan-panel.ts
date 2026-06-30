import type { Line } from '../types/grid.ts';
import { UIFactory } from '../renderer/ui-factory.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { WorkPlanItem, WorkPlanItemStatus, WorkPlanStore } from '../work-plans/work-plan-store.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

const STATUS_LABEL: Record<WorkPlanItemStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  blocked: '[!]',
  done: '[x]',
  failed: '[x]',
  cancelled: '[-]',
};

const STATUS_COLOR: Record<WorkPlanItemStatus, string> = {
  pending: '#94a3b8',
  in_progress: '#38bdf8',
  blocked: '#f59e0b',
  done: '#22c55e',
  failed: '#ef4444',
  cancelled: '#64748b',
};

function line(text: string, width: number, style: Parameters<typeof UIFactory.stringToLine>[2] = {}): Line {
  return UIFactory.stringToLine(text.padEnd(width).slice(0, width), width, style);
}

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

  render(width: number, height: number): Line[] {
    this.refresh();
    return this.renderList(width, height, {
      title: 'Work Plan',
      header: this.renderHeader(width),
      footer: this.renderFooter(width),
      emptyMessage: 'No work plan items yet',
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

  protected getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/work-plan add <title>', summary: 'add a persistent item' },
      { command: '/work-plan list', summary: 'print the current plan' },
    ];
  }

  protected renderItem(item: WorkPlanItem, _index: number, selected: boolean, width: number): Line {
    const status = STATUS_LABEL[item.status];
    const owner = item.owner ? ` @${item.owner}` : '';
    const source = item.source ? ` (${item.source})` : '';
    const text = `${status} ${item.title}${owner}${source}`;
    return line(text, width, {
      fg: selected ? '#e2e8f0' : STATUS_COLOR[item.status],
      bg: selected ? '#1e293b' : undefined,
      bold: selected || item.status === 'in_progress',
    });
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
    for (const status of Object.keys(STATUS_LABEL) as WorkPlanItemStatus[]) counts.set(status, 0);
    for (const item of plan.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    const active = this.items[this.selectedIndex];
    const header = [
      line(`Persistent Work Plan`, width, { fg: '#22d3ee', bold: true }),
      line(`Project: ${plan.projectRoot}`, width, { fg: '#cbd5e1' }),
      line(
        `Items: ${plan.items.length}  pending ${counts.get('pending') ?? 0}  active ${counts.get('in_progress') ?? 0}  blocked ${counts.get('blocked') ?? 0}  done ${counts.get('done') ?? 0}`,
        width,
        { fg: '#94a3b8' },
      ),
      line(`Saved: ${this.store.filePath}`, width, { fg: '#64748b' }),
    ];
    if (active) {
      header.push(line('', width));
      header.push(line(`Selected: ${active.id}  ${statusName(active.status)}  updated ${compactDate(active.updatedAt)}`, width, { fg: '#a5b4fc' }));
      if (active.notes) header.push(line(`Notes: ${active.notes}`, width, { fg: '#cbd5e1' }));
    }
    return header;
  }

  private renderFooter(width: number): Line[] {
    return [
      line('Enter/Space cycle  1 pending  2 active  3 blocked  4 done  5 failed  6 cancelled  d delete  c clear done  r refresh', width, { fg: '#94a3b8' }),
    ];
  }
}
