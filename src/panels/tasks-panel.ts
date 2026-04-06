import type { Cell, Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeTask, TaskLifecycleState } from '../runtime/store/domains/tasks.ts';
import { selectTasks } from '../runtime/store/selectors/index.ts';

const C = {
  header: '#94a3b8',
  headerBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#475569',
  queued: '#38bdf8',
  running: '#22c55e',
  blocked: '#f59e0b',
  failed: '#ef4444',
  completed: '#a78bfa',
  selectedBg: '#0f172a',
  empty: '#334155',
  hint: '#475569',
} as const;

const STATUS_ORDER: TaskLifecycleState[] = ['queued', 'running', 'blocked', 'failed', 'completed'];

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  for (const [text, fg, bg] of segments) {
    const style = { fg, bg: bg ?? '' };
    for (const ch of text) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, style));
    }
  }
  while (cells.length < width) {
    cells.push(createStyledCell(' ', { fg: '' }));
  }
  return cells.slice(0, width);
}

function formatWhen(value?: number): string {
  return value ? new Date(value).toLocaleString() : 'n/a';
}

function formatDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return 'n/a';
  const end = endedAt ?? Date.now();
  const ms = Math.max(0, end - startedAt);
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1_000);
  return `${mins}m ${secs}s`;
}

function kindLabel(kind: RuntimeTask['kind']): string {
  switch (kind) {
    case 'exec': return 'exec';
    case 'agent': return 'agent';
    case 'acp': return 'acp';
    case 'scheduler': return 'scheduler';
    case 'daemon': return 'daemon';
    case 'mcp': return 'mcp';
    case 'plugin': return 'plugin';
    case 'integration': return 'integration';
  }
}

function statusColor(status: TaskLifecycleState): string {
  switch (status) {
    case 'queued':
      return C.queued;
    case 'running':
      return C.running;
    case 'blocked':
      return C.blocked;
    case 'failed':
      return C.failed;
    case 'completed':
      return C.completed;
    case 'cancelled':
      return C.dim;
  }
}

function sortTasks(tasks: RuntimeTask[]): RuntimeTask[] {
  const order = new Map(STATUS_ORDER.map((status, index) => [status, index] as const));
  return [...tasks].sort((a, b) => {
    const statusDelta = (order.get(a.status) ?? 99) - (order.get(b.status) ?? 99);
    if (statusDelta !== 0) return statusDelta;
    const aTime = a.startedAt ?? a.queuedAt;
    const bTime = b.startedAt ?? b.queuedAt;
    return bTime - aTime || a.title.localeCompare(b.title);
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class TasksPanel extends BasePanel {
  private readonly store?: RuntimeStore;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(store?: RuntimeStore) {
    super('tasks', 'Tasks', 'J', 'monitoring');
    this.store = store;
    this.unsub = store ? store.subscribe(() => this.markDirty()) : null;
  }

  public override onActivate(): void {
    super.onActivate();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const tasks = this._tasks();
    if (tasks.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(tasks.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedIndex = tasks.length - 1;
      this.markDirty();
      return true;
    }
    return false;
  }

  private _tasks(): RuntimeTask[] {
    if (!this.store) return [];
    const tasksState = selectTasks(this.store.getState());
    return sortTasks([...tasksState.tasks.values()]);
  }

  private _selected(tasks: RuntimeTask[]): RuntimeTask | undefined {
    if (tasks.length === 0) return undefined;
    this.selectedIndex = Math.min(this.selectedIndex, tasks.length - 1);
    return tasks[this.selectedIndex];
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' Task Control Room', C.header, C.headerBg]]));

    if (!this.store) {
      lines.push(buildLine(width, [[' Runtime store not wired into this panel yet.', C.empty]]));
      lines.push(buildLine(width, [[' Use the Tasks panel with a runtime store to see live task state.', C.hint]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const tasks = this._tasks();
    if (tasks.length === 0) {
      lines.push(buildLine(width, [[' No tasks recorded yet.', C.empty]]));
      lines.push(buildLine(width, [[' Tasks will appear here as exec, agent, ACP, scheduler, daemon, MCP, plugin, and integration work starts.', C.hint]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const counts = STATUS_ORDER.map((status) => ({
      status,
      count: tasks.filter((task) => task.status === status).length,
    }));
    lines.push(buildLine(width, [[
      counts.map(({ status, count }) => `${status}:${count}`).join('  '),
      C.dim,
    ]]));

    const bodyHeight = Math.max(1, height - 3);
    const visibleRows = Math.max(1, bodyHeight - 7);
    if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
    if (this.selectedIndex >= this.scrollOffset + visibleRows) {
      this.scrollOffset = this.selectedIndex - visibleRows + 1;
    }
    const visible = tasks.slice(this.scrollOffset, this.scrollOffset + visibleRows);

    for (let index = 0; index < visible.length; index++) {
      const task = visible[index]!;
      const absoluteIndex = this.scrollOffset + index;
      const bg = absoluteIndex === this.selectedIndex ? C.selectedBg : undefined;
      lines.push(buildLine(width, [
        [' ', C.label, bg],
        [task.status.padEnd(10), statusColor(task.status), bg],
        [` ${kindLabel(task.kind).padEnd(12)}`, C.value, bg],
        [` ${task.id.slice(0, 8)} `, C.dim, bg],
        [task.title.slice(0, Math.max(0, width - 35)), C.value, bg],
      ]));
    }

    const selected = this._selected(tasks);
    if (selected) {
      lines.push(buildLine(width, [[' Details', C.label]]));
      lines.push(buildLine(width, [
        ['  Title: ', C.label],
        [selected.title, C.value],
        ['  Status: ', C.label],
        [selected.status, statusColor(selected.status)],
        ['  Kind: ', C.label],
        [selected.kind, C.value],
      ]));
      lines.push(buildLine(width, [
        ['  Owner: ', C.label],
        [selected.owner, C.value],
        ['  Cancellable: ', C.label],
        [selected.cancellable ? 'yes' : 'no', selected.cancellable ? C.running : C.failed],
        ['  Queue: ', C.label],
        [formatWhen(selected.queuedAt), C.dim],
      ]));
      if (selected.correlationId || selected.turnId) {
        lines.push(buildLine(width, [
          ['  Correlation: ', C.label],
          [selected.correlationId ?? 'n/a', C.dim],
          ['  Turn: ', C.label],
          [selected.turnId ?? 'n/a', C.dim],
        ]));
      }
      lines.push(buildLine(width, [
        ['  Started: ', C.label],
        [formatWhen(selected.startedAt), C.dim],
        ['  Ended: ', C.label],
        [formatWhen(selected.endedAt), C.dim],
        ['  Duration: ', C.label],
        [formatDuration(selected.startedAt, selected.endedAt), C.dim],
      ]));
      if (selected.parentTaskId || selected.childTaskIds.length > 0) {
        lines.push(buildLine(width, [
          ['  Parent: ', C.label],
          [selected.parentTaskId ?? 'none', C.dim],
          ['  Children: ', C.label],
          [selected.childTaskIds.length > 0 ? selected.childTaskIds.join(', ') : 'none', C.dim],
        ]));
      }
      if (selected.retryPolicy) {
        lines.push(buildLine(width, [
          ['  Retry: ', C.label],
          [`${selected.retryPolicy.currentAttempt}/${selected.retryPolicy.maxAttempts} ${selected.retryPolicy.backoff}`, C.value],
        ]));
      }
      if (selected.error) {
        lines.push(buildLine(width, [
          ['  Error: ', C.label],
          [selected.error.slice(0, Math.max(0, width - 10)), C.failed],
        ]));
      }
      if (selected.result !== undefined) {
        const resultText = safeJson(selected.result);
        lines.push(buildLine(width, [
          ['  Result: ', C.label],
          [resultText.slice(0, Math.max(0, width - 11)), C.dim],
        ]));
      }
    }

    lines.push(buildLine(width, [['  Use ↑/↓ to move, Home/End to jump.', C.hint]]));

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
