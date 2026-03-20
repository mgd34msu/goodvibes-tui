import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';
import { TaskScheduler, type ScheduledTask, type TaskRunRecord } from '../scheduler/scheduler.ts';

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
  header: '#00d7ff',
  sectionHeader: '244',
  enabled: '#5fd700',
  disabled: '#6c6c6c',
  selected: '#1c1c1c',
  selectedFg: '#ffffff',
  id: '238',
  cron: '#af87ff',
  prompt: '250',
  nextRun: '#87afff',
  lastRun: '244',
  runCount: '#ffaf00',
  statusRunning: '#5fd700',
  statusFailed: '#ff5f5f',
  hint: '240',
} as const;

// ---------------------------------------------------------------------------
// View items
// ---------------------------------------------------------------------------

type ViewItem =
  | { kind: 'header' }
  | { kind: 'task'; task: ScheduledTask; history: TaskRunRecord[] }
  | { kind: 'empty' };

// ---------------------------------------------------------------------------
// SchedulePanel
// ---------------------------------------------------------------------------

/**
 * SchedulePanel — displays all scheduled tasks with next run time,
 * enable/disable toggle, and run history.
 */
export class SchedulePanel extends BasePanel {
  private items: ViewItem[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super('schedule', 'Schedule', 'Z', 'agent');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    this.rebuild();
    this.refreshTimer = setInterval(() => {
      this.rebuild();
      this.markDirty();
    }, 5_000);
  }

  override onDeactivate(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  override onDestroy(): void {
    this.onDeactivate();
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private rebuild(): void {
    const scheduler = TaskScheduler.getInstance();
    const tasks = scheduler.list();

    const items: ViewItem[] = [{ kind: 'header' }];
    if (tasks.length === 0) {
      items.push({ kind: 'empty' });
    } else {
      for (const task of tasks) {
        items.push({
          kind: 'task',
          task,
          history: scheduler.getHistory(task.id),
        });
      }
    }
    this.items = items;

    if (this.selectedIndex >= this.items.length) {
      this.selectedIndex = Math.max(0, this.items.length - 1);
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    switch (key) {
      case 'up':
      case 'k': {
        if (this.selectedIndex > 0) {
          this.selectedIndex--;
          this.markDirty();
        }
        return true;
      }
      case 'down':
      case 'j': {
        if (this.selectedIndex < this.items.length - 1) {
          this.selectedIndex++;
          this.markDirty();
        }
        return true;
      }
      case 'return':
      case ' ': {
        // Toggle enabled/disabled on selected task
        const item = this.items[this.selectedIndex];
        if (item?.kind === 'task') {
          TaskScheduler.getInstance().setEnabled(item.task.id, !item.task.enabled);
          this.rebuild();
          this.markDirty();
        }
        return true;
      }
      case 'r': {
        // Trigger immediate run of selected task
        const item = this.items[this.selectedIndex];
        if (item?.kind === 'task') {
          TaskScheduler.getInstance().runNow(item.task.id).catch(() => {
            // Non-fatal — error logged by scheduler
          });
          this.rebuild();
          this.markDirty();
        }
        return true;
      }
      case 'R': {
        // Refresh the view
        this.rebuild();
        this.markDirty();
        return true;
      }
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    const rows: Line[] = [];

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (!item) continue;
      const selected = i === this.selectedIndex;

      switch (item.kind) {
        case 'header':
          rows.push(this.renderHeader(width));
          rows.push(createEmptyLine(width)); // spacer
          break;
        case 'task':
          rows.push(...this.renderTask(item.task, item.history, selected, width));
          break;
        case 'empty': {
          const line = createEmptyLine(width);
          this.paintText(line, '  (no scheduled tasks)  use /schedule add to create one', 0, width, C.sectionHeader, { dim: true });
          rows.push(line);
          break;
        }
      }
    }

    // Auto-scroll to keep selected row visible
    if (this.selectedIndex >= 0) {
      const selRow = this.getRowForItem(this.selectedIndex);
      if (selRow >= 0) {
        if (selRow < this.scrollOffset) {
          this.scrollOffset = selRow;
        } else if (selRow >= this.scrollOffset + height - 1) {
          this.scrollOffset = selRow - height + 2;
        }
      }
    }
    if (this.scrollOffset < 0) this.scrollOffset = 0;

    const visible = rows.slice(this.scrollOffset, this.scrollOffset + height);
    const lines: Line[] = [...visible];

    // Hint footer
    while (lines.length < height - 1) lines.push(createEmptyLine(width));
    if (lines.length < height) {
      const hint = createEmptyLine(width);
      this.paintText(hint, ' \u2191\u2193 navigate  Space toggle  r run now  R refresh', 0, width, C.hint, { dim: true });
      lines.push(hint);
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines;
  }

  // -- Row helpers ------------------------------------------------------------

  private renderHeader(width: number): Line {
    const line = createEmptyLine(width);
    const scheduler = TaskScheduler.getInstance();
    const tasks = scheduler.list();
    const enabled = tasks.filter((t) => t.enabled).length;
    const text = ` Scheduled Tasks  (${enabled}/${tasks.length} enabled)`;
    this.paintText(line, text, 0, width, C.header, { bold: true });
    return line;
  }

  /**
   * Render a task as 3 rows:
   *   Row 1: [status] id  name  cron
   *   Row 2:          next: <date>  last: <date>  runs: N
   *   Row 3:          prompt preview  [history]
   */
  private renderTask(task: ScheduledTask, history: TaskRunRecord[], selected: boolean, width: number): Line[] {
    const bg = selected ? C.selected : undefined;
    const fgBase = selected ? C.selectedFg : undefined;

    // --- Row 1: status bullet + id + name + cron ---
    const row1 = createEmptyLine(width);
    if (selected) {
      for (let i = 0; i < width; i++) row1[i] = createStyledCell(' ', { bg: C.selected, fg: C.selectedFg });
    }
    let x = 0;
    const bullet = task.enabled ? '\u25cf ' : '\u25cb ';
    const bulletFg = task.enabled ? C.enabled : C.disabled;
    x = this.paintText(row1, bullet, x, width, bulletFg, { bg });
    x = this.paintText(row1, task.id.slice(0, 12), x, width, fgBase ?? C.id, { bg });
    x = this.paintText(row1, '  ', x, width, fgBase ?? C.prompt, { bg });
    const nameStr = task.name.length > 28 ? task.name.slice(0, 26) + '\u2026' : task.name.padEnd(28);
    x = this.paintText(row1, nameStr, x, width, fgBase ?? C.prompt, { bg, bold: selected });
    x = this.paintText(row1, '  ', x, width, fgBase ?? C.prompt, { bg });
    this.paintText(row1, task.cron, x, width, fgBase ?? C.cron, { bg });

    // --- Row 2: next/last run times ---
    const row2 = createEmptyLine(width);
    if (selected) {
      for (let i = 0; i < width; i++) row2[i] = createStyledCell(' ', { bg: C.selected, fg: C.selectedFg });
    }
    const indent = '    ';
    let x2 = 0;
    x2 = this.paintText(row2, indent, x2, width, fgBase ?? C.prompt, { bg });
    const nextStr = task.nextRun
      ? `next: ${new Date(task.nextRun).toLocaleString()}`
      : 'next: unknown';
    x2 = this.paintText(row2, nextStr.padEnd(36), x2, width, fgBase ?? C.nextRun, { bg });
    const lastStr = task.lastRun
      ? `last: ${new Date(task.lastRun).toLocaleString()}`
      : 'last: never';
    x2 = this.paintText(row2, lastStr.padEnd(32), x2, width, fgBase ?? C.lastRun, { bg });
    this.paintText(row2, `runs: ${task.runCount}`, x2, width, fgBase ?? C.runCount, { bg });

    // --- Row 3: prompt preview + run history ---
    const row3 = createEmptyLine(width);
    if (selected) {
      for (let i = 0; i < width; i++) row3[i] = createStyledCell(' ', { bg: C.selected, fg: C.selectedFg });
    }
    let x3 = 0;
    x3 = this.paintText(row3, indent, x3, width, fgBase ?? C.prompt, { bg });
    const maxPromptLen = Math.max(20, width - indent.length - 30);
    const promptPreview = task.prompt.length > maxPromptLen
      ? task.prompt.slice(0, maxPromptLen - 1) + '\u2026'
      : task.prompt;
    x3 = this.paintText(row3, promptPreview, x3, width, fgBase ?? C.prompt, { bg, dim: !selected });

    // Show last 3 run statuses as colored dots
    const recentRuns = history.slice(-3);
    if (recentRuns.length > 0) {
      x3 = this.paintText(row3, '  ', x3, width, fgBase ?? C.prompt, { bg });
      for (const run of recentRuns) {
        const dot = run.status === 'failed' ? '\u25cf' : '\u25cf';
        const dotFg = run.status === 'failed' ? C.statusFailed : C.statusRunning;
        x3 = this.paintText(row3, dot, x3, width, dotFg, { bg });
      }
    }

    // spacer row between tasks
    const spacer = createEmptyLine(width);

    return [row1, row2, row3, spacer];
  }

  // -- Text painting ----------------------------------------------------------

  private paintText(
    line: Line,
    text: string,
    startX: number,
    width: number,
    fg?: string,
    opts: { bold?: boolean; dim?: boolean; bg?: string } = {},
  ): number {
    let x = startX;
    for (const ch of text) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg, bg: opts.bg, bold: opts.bold, dim: opts.dim });
    }
    return x;
  }

  /**
   * Map an item index to its rendered row start position,
   * accounting for multi-row tasks (4 rows each) and the header (2 rows).
   */
  private getRowForItem(itemIndex: number): number {
    let row = 0;
    for (let i = 0; i < itemIndex && i < this.items.length; i++) {
      const it = this.items[i];
      if (it?.kind === 'header') {
        row += 2; // header + spacer
      } else if (it?.kind === 'task') {
        row += 4; // 3 content rows + spacer
      } else {
        row += 1;
      }
    }
    return row;
  }
}
