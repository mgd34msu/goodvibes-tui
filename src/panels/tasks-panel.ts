import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { OpsApi, RuntimeTask, TaskLifecycleState } from '@/runtime/index.ts';
import type { ManagedWorktreeMeta } from '@/runtime/index.ts';
import type { UiReadModel, UiTasksSnapshot, UiWorktreeSnapshot } from '../runtime/ui-read-models.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyboardHints,
  buildPanelListRow,
  buildPanelLine,
  buildSummaryBlock,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
} from './polish.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';

// Domain accents only; base chrome (header/headerBg/info/good/warn/bad/
// selectBg) comes from DEFAULT_PANEL_PALETTE.
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  completed: '#a78bfa',   // completed-task badge — distinct from running/good
} as const);

const STATUS_ORDER: TaskLifecycleState[] = ['queued', 'running', 'blocked', 'failed', 'completed'];

/** The follow-up action Enter dispatches once the panel-integration router runs, per WO-131. */
type TaskFollowUp =
  | { readonly kind: 'agent-jump'; readonly agentId: string }
  | { readonly kind: 'worktree-review'; readonly taskId: string }
  | { readonly kind: 'teamwork-review' };

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
      return C.info;
    case 'running':
      return C.good;
    case 'blocked':
      return C.warn;
    case 'failed':
      return C.bad;
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
  private readonly opsApi?: OpsApi;
  private readonly unsubscribers: readonly (() => void)[];

  /** Task id currently expanded into the detail view, or null while browsing the list. */
  private _detailTaskId: string | null = null;
  private _detailScroll = 0;

  /** Pending cancel confirmation — subject is the task id being cancelled. */
  private _confirm: ConfirmState<string> | null = null;

  /** Set by handleInput on Enter; consumed by the panel-integration router immediately after. */
  private _pendingFollowUp: TaskFollowUp | null = null;

  public constructor(
    readModel: UiReadModel<UiTasksSnapshot> | undefined,
    worktrees?: UiReadModel<UiWorktreeSnapshot>,
    opsApi?: OpsApi,
  ) {
    super('tasks', 'Tasks', 'J', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter tasks';
    this.readModel = readModel;
    this.worktrees = worktrees;
    this.opsApi = opsApi;
    this.unsubscribers = [
      readModel?.subscribe(() => this.markDirty()),
      worktrees?.subscribe(() => this.markDirty()),
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
  }

  // WO-131: selection is preserved across onActivate — BasePanel's default
  // (mark dirty, no index reset) is exactly what we want, so no override.

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

  protected override filterMatches(task: RuntimeTask, q: string): boolean {
    return task.title.toLowerCase().includes(q)
      || task.status.toLowerCase().includes(q)
      || task.id.toLowerCase().includes(q)
      || String(task.kind).toLowerCase().includes(q);
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
      { text: truncateDisplay(task.title, Math.max(0, width - 37)), fg: C.value },
    ], C, { selected });
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  public handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (this._confirm) {
      const outcome = handleConfirmInput(this._confirm, key);
      if (outcome === 'confirmed') {
        this._executeCancel(this._confirm.subject);
        this._confirm = null;
        this.markDirty();
        return true;
      }
      if (outcome === 'cancelled') {
        this._confirm = null;
        this.markDirty();
        return true;
      }
      return true; // absorbed — keep the confirm dialog pending
    }

    const tasks = this.getVisibleItems();

    // --- Detail mode: WO-131 moves the deep per-task field dump behind an
    // Enter-toggled view so the list itself keeps full viewport in normal
    // browsing. Esc/Left collapses back to the list; Enter (again, while
    // already expanded) dispatches the task's advertised worktree follow-up.
    if (this._detailTaskId !== null) {
      if (key === 'escape' || key === 'left') {
        this._detailTaskId = null;
        this._detailScroll = 0;
        this.markDirty();
        return true;
      }
      if (key === 'enter' || key === 'return') {
        const task = tasks.find((t) => t.id === this._detailTaskId);
        if (task) this._pendingFollowUp = { kind: 'worktree-review', taskId: task.id };
        return true;
      }
      switch (key) {
        case 'up':
        case 'k':
          this._detailScroll = Math.max(0, this._detailScroll - 1);
          this.markDirty();
          return true;
        case 'down':
        case 'j':
          this._detailScroll += 1;
          this.markDirty();
          return true;
        case 'pageup':
          this._detailScroll = Math.max(0, this._detailScroll - this.getPageSize());
          this.markDirty();
          return true;
        case 'pagedown':
          this._detailScroll += this.getPageSize();
          this.markDirty();
          return true;
        case 'home':
        case 'g':
          this._detailScroll = 0;
          this.markDirty();
          return true;
        default:
          return false;
      }
    }

    // --- List mode ---
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedIndex = Math.max(0, tasks.length - 1);
      this.markDirty();
      return true;
    }

    if (key === 'c' && !this.filterActive) {
      const task = tasks[this.selectedIndex];
      if (!task || !task.cancellable) return false;
      this._confirm = { subject: task.id, label: `task "${task.title}"`, verb: 'Cancel' };
      this.markDirty();
      return true;
    }

    // The task-family posture surface is bound for real: w stages a follow-up
    // the integration router dispatches as '/teamwork review' via executeCommand.
    if (key === 'w' && !this.filterActive) {
      this._pendingFollowUp = { kind: 'teamwork-review' };
      return true;
    }

    // Enter commits the filter query while actively typing (ScrollableListPanel
    // contract) — only treated as detail-mode/agent-jump once filtering isn't active.
    if ((key === 'enter' || key === 'return') && !this.filterActive) {
      const task = tasks[this.selectedIndex];
      if (!task) return false;
      // Agent-kind tasks jump straight to the Agent Inspector — that panel
      // already owns the deep per-agent timeline, so Tasks does not duplicate it.
      if (task.kind === 'agent') {
        this._pendingFollowUp = { kind: 'agent-jump', agentId: task.owner };
        return true;
      }
      this._detailTaskId = task.id;
      this._detailScroll = 0;
      this.markDirty();
      return true;
    }

    return super.handleInput(key);
  }

  /**
   * Consumed by the panel-integration router immediately after handleInput
   * returns true for the same Enter keystroke. Returns and clears whatever
   * follow-up (if any) that keystroke queued.
   */
  public consumePendingFollowUp(): TaskFollowUp | null {
    const pending = this._pendingFollowUp;
    this._pendingFollowUp = null;
    return pending;
  }

  private _executeCancel(taskId: string): void {
    if (!this.opsApi) {
      this.setError('Ops API is not wired for this runtime.');
      return;
    }
    try {
      this.opsApi.tasks.cancel(taskId);
    } catch (err) {
      this.setError(summarizeError(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  public render(width: number, height: number): Line[] {
    this.clampSelection();

    if (this._detailTaskId !== null) {
      const task = this.getVisibleItems().find((t) => t.id === this._detailTaskId);
      if (task) return this._renderDetail(width, height, task);
      this._detailTaskId = null; // task vanished (pruned/completed away) — fall back to list
    }

    return this._renderListView(width, height);
  }

  private _renderListView(width: number, height: number): Line[] {
    const intro = 'Live task lifecycle, ownership, retries, and result/error details across runtime execution domains.';
    const visibleTasks = this.getVisibleItems();
    const selected = visibleTasks[this.selectedIndex];
    // Context-aware footer: position + only the keys that apply in the current
    // (filtering vs browsing) state, and to the selected task's kind/cancellable flag.
    const browseHints: Array<{ keys: string; label: string }> = [
      { keys: visibleTasks.length > 0 ? `${this.selectedIndex + 1}/${visibleTasks.length}` : '0/0', label: 'task' },
      { keys: '↑/↓', label: 'move' },
      { keys: 'Home/End', label: 'jump' },
      { keys: '/', label: 'filter' },
      { keys: 'w', label: 'teamwork review' },
    ];
    if (selected) {
      browseHints.push({ keys: 'Enter', label: selected.kind === 'agent' ? 'agent detail' : 'task detail' });
      if (selected.cancellable) browseHints.push({ keys: 'c', label: 'cancel' });
    }
    const footerLines = [
      this.filterActive
        ? buildKeyboardHints(width, [
            { keys: 'type', label: 'filter tasks' },
            { keys: 'Enter', label: 'apply' },
            { keys: 'Esc', label: 'clear' },
          ], C)
        : buildKeyboardHints(width, browseHints, C),
    ];

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
        [String(queuedCount), queuedCount > 0 ? C.info : C.dim],
        ['  running ', C.label],
        [String(runningCount), runningCount > 0 ? C.good : C.dim],
        ['  blocked ', C.label],
        [String(blockedCount), blockedCount > 0 ? C.warn : C.dim],
        ['  failed ', C.label],
        [String(failedCount), failedCount > 0 ? C.bad : C.dim],
        ['  completed ', C.label],
        [String(completedCount), completedCount > 0 ? C.completed : C.dim],
      ]),
    ];

    if (selected) {
      postureLines.push(buildPanelLine(width, [
        [' selected ', C.label],
        [selected.id, C.info],
        ['  status ', C.label],
        [selected.status, statusColor(selected.status)],
        ['  kind ', C.label],
        [selected.kind, C.value],
        ['  owner ', C.label],
        [truncateDisplay(selected.owner, Math.max(0, width - 46)), C.dim],
      ]));
    }
    postureLines.push(
      buildGuidanceLine(width, '/teamwork review', 'inspect task-family posture, archetype metadata, and recovery options for active work — press w to run it', C),
    );

    const headerLines: Line[] = buildSummaryBlock(width, 'Task posture', postureLines, C);

    const effectiveFooter = this._confirm
      ? [...renderConfirmLines(width, this._confirm), ...footerLines]
      : footerLines;

    return this.renderList(width, height, {
      title: 'Task Control Room',
      header: headerLines,
      footer: effectiveFooter,
    });
  }

  /** Detail-mode body for one task — the deep field dump previously always shown inline. */
  private _renderDetail(width: number, height: number, task: RuntimeTask): Line[] {
    this.needsRender = false;
    const descriptor = task.description ? parseTaskDescriptor(task.description) : null;
    const detailRows: Line[] = [];
    detailRows.push(buildPanelLine(width, [
      ['  Title: ', C.label],
      [task.title, C.value],
      ['  Status: ', C.label],
      [task.status, statusColor(task.status)],
      ['  Kind: ', C.label],
      [task.kind, C.value],
    ]));
    detailRows.push(buildPanelLine(width, [
      ['  Owner: ', C.label],
      [task.owner, C.value],
      ['  Cancellable: ', C.label],
      [task.cancellable ? 'yes' : 'no', task.cancellable ? C.good : C.bad],
      ['  Queue: ', C.label],
      [formatWhen(task.queuedAt), C.dim],
    ]));
    detailRows.push(buildPanelLine(width, [
      ['  Started: ', C.label],
      [formatWhen(task.startedAt), C.dim],
      ['  Ended: ', C.label],
      [formatWhen(task.endedAt), C.dim],
      ['  Duration: ', C.label],
      [formatDuration(task.startedAt, task.endedAt), C.dim],
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
    if (task.correlationId || task.turnId) {
      detailRows.push(buildPanelLine(width, [
        ['  Correlation: ', C.label],
        [task.correlationId ?? 'n/a', C.dim],
        ['  Turn: ', C.label],
        [task.turnId ?? 'n/a', C.dim],
      ]));
    }
    if (task.parentTaskId || task.childTaskIds.length > 0) {
      detailRows.push(buildPanelLine(width, [
        ['  Parent: ', C.label],
        [task.parentTaskId ?? 'none', C.dim],
        ['  Children: ', C.label],
        [task.childTaskIds.length > 0 ? task.childTaskIds.join(', ') : 'none', C.dim],
      ]));
    }
    const attachedWorktrees = reviewTaskWorktreeAttachments(task.id, this.worktrees);
    if (attachedWorktrees.total > 0) {
      detailRows.push(buildPanelLine(width, [
        ['  Worktrees: ', C.label],
        [`${attachedWorktrees.total} tracked`, C.info],
        ['  Active: ', C.label],
        [String(attachedWorktrees.active), attachedWorktrees.active > 0 ? C.good : C.dim],
        ['  Paused: ', C.label],
        [String(attachedWorktrees.paused), attachedWorktrees.paused > 0 ? C.warn : C.dim],
      ]));
      for (const record of attachedWorktrees.records.slice(0, 2)) {
        detailRows.push(buildPanelLine(width, [[
          truncateDisplay(`  ${record.state.padEnd(15)} ${record.path}`, Math.max(0, width - 2)),
          record.state === 'active' ? C.good : record.state === 'paused' ? C.warn : C.dim,
        ]]));
      }
    }
    if (task.retryPolicy) {
      detailRows.push(buildPanelLine(width, [
        ['  Retry: ', C.label],
        [`${task.retryPolicy.currentAttempt}/${task.retryPolicy.maxAttempts} ${task.retryPolicy.backoff}`, C.value],
      ]));
    }
    if (task.error) {
      detailRows.push(buildPanelLine(width, [
        ['  Error: ', C.label],
        [truncateDisplay(task.error, Math.max(0, width - 10)), C.bad],
      ]));
    }
    if (task.result !== undefined) {
      const resultText = safeJson(task.result);
      detailRows.push(buildPanelLine(width, [
        ['  Result: ', C.label],
        [truncateDisplay(resultText, Math.max(0, width - 11)), C.dim],
      ]));
    }

    // The actionable follow-up replaces the old printed "/worktree task <task-id>"
    // signpost — pressing Enter here dispatches it for real via ctx.executeCommand.
    detailRows.push(buildGuidanceLine(width, `/worktree task ${task.id}`, 'review worktree ownership, restore, and merge posture for this task — press Enter to run it', C));

    const footer = buildKeyboardHints(width, [
      { keys: '↑/↓', label: 'scroll' },
      { keys: 'Enter', label: 'review worktree ownership' },
      { keys: 'Esc', label: 'back' },
    ], C);

    const resolved = resolveScrollablePanelSection(width, height, {
      palette: C,
      afterSections: [{ lines: [footer] }],
      section: {
        scrollableLines: detailRows,
        scrollOffset: this._detailScroll,
        appendWindowSummary: detailRows.length > 5 ? { dimColor: C.dim } : undefined,
      },
    });
    this._detailScroll = resolved.scrollOffset;

    const lines = buildPanelWorkspace(width, height, {
      title: `Task · ${task.title}`,
      sections: [resolved.section, { lines: [footer] }],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
