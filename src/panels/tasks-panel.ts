import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { RuntimeTask, TaskLifecycleState } from '@/runtime/index.ts';
import type { ManagedWorktreeMeta } from '@/runtime/index.ts';
import type { UiReadModel, UiTasksSnapshot, UiWorktreeSnapshot } from '../runtime/ui-read-models.ts';
import {
  buildDetailBlock,
  buildEmptyState,
  buildGuidanceLine,
  buildPanelListRow,
  buildPanelLine,
  buildSummaryBlock,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  queued: '#38bdf8',
  running: '#22c55e',
  blocked: '#f59e0b',
  failed: '#ef4444',
  completed: '#a78bfa',
  selectBg: '#0f172a',
} as const;

const STATUS_ORDER: TaskLifecycleState[] = ['queued', 'running', 'blocked', 'failed', 'completed'];

function formatWhen(value?: number): string {
  return value ? new Date(value).toLocaleString() : 'n/a';
}

function formatDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return 'n/a';
  return formatElapsed(Math.max(0, (endedAt ?? Date.now()) - startedAt));
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

interface TaskDescriptorMeta {
  readonly mode?: string;
  readonly template?: string;
  readonly reviewMode?: string;
  readonly executionProtocol?: string;
  readonly source?: string;
  readonly family?: string;
}

function parseTaskDescriptor(description: string): TaskDescriptorMeta | null {
  try {
    const parsed = JSON.parse(description) as TaskDescriptorMeta;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

interface TaskWorktreeAttachmentReview {
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly kept: number;
  readonly discard: number;
  readonly pendingCleanup: number;
  readonly records: readonly ManagedWorktreeMeta[];
}

function reviewTaskWorktreeAttachments(
  taskId: string,
  worktrees?: UiReadModel<UiWorktreeSnapshot>,
): TaskWorktreeAttachmentReview {
  const records = (worktrees?.getSnapshot().records ?? []).filter((record) => record.taskId === taskId);
  return records.reduce<TaskWorktreeAttachmentReview>((summary, record) => ({
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
    discard: summary.discard + (record.state === 'discard' ? 1 : 0),
    pendingCleanup: summary.pendingCleanup + (record.state === 'pending-cleanup' ? 1 : 0),
    records: [...summary.records, record],
  }), {
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    pendingCleanup: 0,
    records: [],
  });
}

export class TasksPanel extends ScrollableListPanel<RuntimeTask> {
  private readonly readModel?: UiReadModel<UiTasksSnapshot>;
  private readonly worktrees?: UiReadModel<UiWorktreeSnapshot>;
  private readonly unsubscribers: readonly (() => void)[];

  public constructor(
    readModel: UiReadModel<UiTasksSnapshot> | undefined,
    worktrees?: UiReadModel<UiWorktreeSnapshot>,
  ) {
    super('tasks', 'Tasks', 'J', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.readModel = readModel;
    this.worktrees = worktrees;
    this.unsubscribers = [
      readModel?.subscribe(() => this.markDirty()),
      worktrees?.subscribe(() => this.markDirty()),
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
  }

  public override onActivate(): void {
    super.onActivate();
    this.selectedIndex = 0;
  }

  public override onDestroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No tasks recorded yet.'; }
  protected override getEmptyStateActions() {
    return [
      { command: '/tasks create', summary: 'create a tracked task from the shell' },
      { command: '/orchestration', summary: 'review graph-native task execution and WRFC flows' },
    ];
  }

  protected getItems(): readonly RuntimeTask[] {
    if (!this.readModel) return [];
    return sortTasks([...this.readModel.getSnapshot().tasks]);
  }

  protected renderItem(task: RuntimeTask, index: number, selected: boolean, width: number): Line {
    return buildPanelListRow(width, [
      { text: task.status.padEnd(10), fg: statusColor(task.status) },
      { text: ` ${kindLabel(task.kind).padEnd(12)}`, fg: C.value },
      { text: ` ${task.id.slice(0, 8)} `, fg: C.dim },
      { text: task.title.slice(0, Math.max(0, width - 37)), fg: C.value },
    ], C, { selected });
  }

  public handleInput(key: string): boolean {
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      const tasks = this.getItems();
      this.selectedIndex = Math.max(0, tasks.length - 1);
      this.markDirty();
      return true;
    }
    return super.handleInput(key);
  }

  public render(width: number, height: number): Line[] {
    this.clampSelection();
    const intro = 'Live task lifecycle, ownership, retries, and result/error details across runtime execution domains.';
    const footerLines = [buildPanelLine(width, [['  Up/Down move  Home/End jump', C.dim]])];

    if (!this.readModel) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Task Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime store not wired into this panel yet.',
            'Use the Tasks panel with a live runtime store to review active execution, cancellations, retries, and completion results.',
            [{ command: '/tasks', summary: 'open or operate the task surface from a shell-owned runtime' }],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const tasks = this.getItems();
    const counts = STATUS_ORDER.map((status) => ({
      status,
      count: tasks.filter((task) => task.status === status).length,
    }));
    const blockedCount = counts.find((entry) => entry.status === 'blocked')?.count ?? 0;
    const failedCount = counts.find((entry) => entry.status === 'failed')?.count ?? 0;
    const runningCount = counts.find((entry) => entry.status === 'running')?.count ?? 0;
    const queuedCount = counts.find((entry) => entry.status === 'queued')?.count ?? 0;
    const completedCount = counts.find((entry) => entry.status === 'completed')?.count ?? 0;

    const postureLines: Line[] = [
      buildPanelLine(width, [
        [' queued ', C.label],
        [String(queuedCount), queuedCount > 0 ? C.queued : C.dim],
        ['  running ', C.label],
        [String(runningCount), runningCount > 0 ? C.running : C.dim],
        ['  blocked ', C.label],
        [String(blockedCount), blockedCount > 0 ? C.blocked : C.dim],
        ['  failed ', C.label],
        [String(failedCount), failedCount > 0 ? C.failed : C.dim],
        ['  completed ', C.label],
        [String(completedCount), completedCount > 0 ? C.completed : C.dim],
      ]),
    ];

    const selected = tasks[this.selectedIndex];
    if (selected) {
      postureLines.push(buildPanelLine(width, [
        [' selected ', C.label],
        [selected.id, C.info],
        ['  status ', C.label],
        [selected.status, statusColor(selected.status)],
        ['  kind ', C.label],
        [selected.kind, C.value],
        ['  owner ', C.label],
        [selected.owner.slice(0, Math.max(0, width - 46)), C.dim],
      ]));
    }
    postureLines.push(
      buildGuidanceLine(width, '/teamwork review', 'inspect task-family posture, archetype metadata, and recovery options for active work', C),
      buildGuidanceLine(width, '/worktree task <task-id>', 'review worktree ownership, restore, and merge posture for the selected task', C),
    );

    const detailRows: Line[] = [];
    if (selected) {
      const descriptor = selected.description ? parseTaskDescriptor(selected.description) : null;
      detailRows.push(buildPanelLine(width, [
        ['  Title: ', C.label],
        [selected.title, C.value],
        ['  Status: ', C.label],
        [selected.status, statusColor(selected.status)],
        ['  Kind: ', C.label],
        [selected.kind, C.value],
      ]));
      detailRows.push(buildPanelLine(width, [
        ['  Owner: ', C.label],
        [selected.owner, C.value],
        ['  Cancellable: ', C.label],
        [selected.cancellable ? 'yes' : 'no', selected.cancellable ? C.running : C.failed],
        ['  Queue: ', C.label],
        [formatWhen(selected.queuedAt), C.dim],
      ]));
      detailRows.push(buildPanelLine(width, [
        ['  Started: ', C.label],
        [formatWhen(selected.startedAt), C.dim],
        ['  Ended: ', C.label],
        [formatWhen(selected.endedAt), C.dim],
        ['  Duration: ', C.label],
        [formatDuration(selected.startedAt, selected.endedAt), C.dim],
      ]));
      if (descriptor?.mode || descriptor?.family || descriptor?.source) {
        detailRows.push(buildPanelLine(width, [
          ['  Mode: ', C.label],
          [descriptor?.mode ?? 'n/a', C.value],
          ['  Family: ', C.label],
          [descriptor?.family ?? 'n/a', C.info],
          ['  Source: ', C.label],
          [descriptor?.source ?? 'builtin/runtime', C.dim],
        ]));
      }
      if (descriptor?.reviewMode || descriptor?.executionProtocol || descriptor?.template) {
        detailRows.push(buildPanelLine(width, [
          ['  Review: ', C.label],
          [descriptor?.reviewMode ?? 'n/a', C.value],
          ['  Protocol: ', C.label],
          [descriptor?.executionProtocol ?? 'n/a', C.value],
          ['  Template: ', C.label],
          [descriptor?.template ?? 'n/a', C.dim],
        ]));
      }
      if (selected.correlationId || selected.turnId) {
        detailRows.push(buildPanelLine(width, [
          ['  Correlation: ', C.label],
          [selected.correlationId ?? 'n/a', C.dim],
          ['  Turn: ', C.label],
          [selected.turnId ?? 'n/a', C.dim],
        ]));
      }
      if (selected.parentTaskId || selected.childTaskIds.length > 0) {
        detailRows.push(buildPanelLine(width, [
          ['  Parent: ', C.label],
          [selected.parentTaskId ?? 'none', C.dim],
          ['  Children: ', C.label],
          [selected.childTaskIds.length > 0 ? selected.childTaskIds.join(', ') : 'none', C.dim],
        ]));
      }
      const attachedWorktrees = reviewTaskWorktreeAttachments(selected.id, this.worktrees);
      if (attachedWorktrees.total > 0) {
        detailRows.push(buildPanelLine(width, [
          ['  Worktrees: ', C.label],
          [`${attachedWorktrees.total} tracked`, C.info],
          ['  Active: ', C.label],
          [String(attachedWorktrees.active), attachedWorktrees.active > 0 ? C.running : C.dim],
          ['  Paused: ', C.label],
          [String(attachedWorktrees.paused), attachedWorktrees.paused > 0 ? C.blocked : C.dim],
        ]));
        detailRows.push(buildPanelLine(width, [[
          `  Next: /worktree task ${selected.id}  /worktree recover task ${selected.id}`,
          C.dim,
        ]]));
        for (const record of attachedWorktrees.records.slice(0, 2)) {
          detailRows.push(buildPanelLine(width, [[
            `  ${record.state.padEnd(15)} ${record.path}`.slice(0, Math.max(0, width - 2)),
            record.state === 'active' ? C.running : record.state === 'paused' ? C.blocked : C.dim,
          ]]));
        }
      }
      if (selected.retryPolicy) {
        detailRows.push(buildPanelLine(width, [
          ['  Retry: ', C.label],
          [`${selected.retryPolicy.currentAttempt}/${selected.retryPolicy.maxAttempts} ${selected.retryPolicy.backoff}`, C.value],
        ]));
      }
      if (selected.error) {
        detailRows.push(buildPanelLine(width, [
          ['  Error: ', C.label],
          [selected.error.slice(0, Math.max(0, width - 10)), C.failed],
        ]));
      }
      if (selected.result !== undefined) {
        const resultText = safeJson(selected.result);
        detailRows.push(buildPanelLine(width, [
          ['  Result: ', C.label],
          [resultText.slice(0, Math.max(0, width - 11)), C.dim],
        ]));
      }
    }

    const headerLines: Line[] = buildSummaryBlock(width, 'Task posture', postureLines, C);

    return this.renderList(width, height, {
      title: 'Task Control Room',
      header: headerLines,
      footer: [
        ...buildDetailBlock(width, 'Selected task', detailRows, C),
        ...footerLines,
      ],
    });
  }
}
