import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeTask, TaskLifecycleState } from '../runtime/store/domains/tasks.ts';
import type { ManagedWorktreeMeta } from '../runtime/worktree/registry.ts';
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
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';

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
  readonly cleanupPending: number;
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
    cleanupPending: summary.cleanupPending + (record.state === 'cleanup-pending' ? 1 : 0),
    records: [...summary.records, record],
  }), {
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    cleanupPending: 0,
    records: [],
  });
}

export class TasksPanel extends BasePanel {
  private readonly readModel?: UiReadModel<UiTasksSnapshot>;
  private readonly worktrees?: UiReadModel<UiWorktreeSnapshot>;
  private readonly unsubscribers: readonly (() => void)[];
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(
    readModel: UiReadModel<UiTasksSnapshot> | undefined,
    worktrees?: UiReadModel<UiWorktreeSnapshot>,
  ) {
    super('tasks', 'Tasks', 'J', 'monitoring');
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
    if (!this.readModel) return [];
    return sortTasks([...this.readModel.getSnapshot().tasks]);
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
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

    const tasks = this._tasks();
    if (tasks.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Task Control Room',
        intro,
        sections: [{
          title: 'Overview',
          lines: [
            buildPanelLine(width, [[' queued:0  running:0  blocked:0  failed:0  completed:0', C.dim]]),
            ...buildEmptyState(
              width,
              ' No tasks recorded yet.',
              'Tasks will appear here as exec, agent, ACP, scheduler, daemon, MCP, plugin, and integration work starts.',
              [
                { command: '/tasks create', summary: 'create a tracked task from the shell' },
                { command: '/orchestration', summary: 'review graph-native task execution and WRFC flows' },
              ],
              C,
            ),
          ],
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this.selectedIndex = Math.min(this.selectedIndex, tasks.length - 1);
    const counts = STATUS_ORDER.map((status) => ({
      status,
      count: tasks.filter((task) => task.status === status).length,
    }));
    const blockedCount = counts.find((entry) => entry.status === 'blocked')?.count ?? 0;
    const failedCount = counts.find((entry) => entry.status === 'failed')?.count ?? 0;
    const runningCount = counts.find((entry) => entry.status === 'running')?.count ?? 0;
    const queuedCount = counts.find((entry) => entry.status === 'queued')?.count ?? 0;
    const completedCount = counts.find((entry) => entry.status === 'completed')?.count ?? 0;

    const selected = tasks[this.selectedIndex]!;
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
      buildPanelLine(width, [
        [' selected ', C.label],
        [selected.id, C.info],
        ['  status ', C.label],
        [selected.status, statusColor(selected.status)],
        ['  kind ', C.label],
        [selected.kind, C.value],
        ['  owner ', C.label],
        [selected.owner.slice(0, Math.max(0, width - 46)), C.dim],
      ]),
      buildGuidanceLine(width, '/teamwork review', 'inspect task-family posture, archetype metadata, and recovery options for active work', C),
      buildGuidanceLine(width, '/worktree task <task-id>', 'review worktree ownership, restore, and merge posture for the selected task', C),
    ];
    const descriptor = selected.description ? parseTaskDescriptor(selected.description) : null;
    const detailRows: Line[] = [
      buildPanelLine(width, [
        ['  Title: ', C.label],
        [selected.title, C.value],
        ['  Status: ', C.label],
        [selected.status, statusColor(selected.status)],
        ['  Kind: ', C.label],
        [selected.kind, C.value],
      ]),
      buildPanelLine(width, [
        ['  Owner: ', C.label],
        [selected.owner, C.value],
        ['  Cancellable: ', C.label],
        [selected.cancellable ? 'yes' : 'no', selected.cancellable ? C.running : C.failed],
        ['  Queue: ', C.label],
        [formatWhen(selected.queuedAt), C.dim],
      ]),
      buildPanelLine(width, [
        ['  Started: ', C.label],
        [formatWhen(selected.startedAt), C.dim],
        ['  Ended: ', C.label],
        [formatWhen(selected.endedAt), C.dim],
        ['  Duration: ', C.label],
        [formatDuration(selected.startedAt, selected.endedAt), C.dim],
      ]),
    ];
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
    const postureSection: PanelWorkspaceSection = { lines: buildSummaryBlock(width, 'Task posture', postureLines, C) };
    const selectedSection: PanelWorkspaceSection = { lines: buildDetailBlock(width, 'Selected task', detailRows, C) };
    const rawTaskLines: Line[] = [];
    for (let absolute = 0; absolute < tasks.length; absolute++) {
      const task = tasks[absolute]!;
      rawTaskLines.push(buildPanelListRow(width, [
        { text: task.status.padEnd(10), fg: statusColor(task.status) },
        { text: ` ${kindLabel(task.kind).padEnd(12)}`, fg: C.value },
        { text: ` ${task.id.slice(0, 8)} `, fg: C.dim },
        { text: task.title.slice(0, Math.max(0, width - 37)), fg: C.value },
      ], C, { selected: absolute === this.selectedIndex }));
    }
    const resolvedTasksSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines,
      palette: C,
      beforeSections: [postureSection],
      section: {
        title: 'Tasks',
        scrollableLines: rawTaskLines,
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [selectedSection],
    });
    this.scrollOffset = resolvedTasksSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      resolvedTasksSection.section,
      selectedSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Task Control Room',
      intro,
      sections,
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
