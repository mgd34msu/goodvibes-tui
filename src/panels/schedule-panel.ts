import { BasePanel } from './base-panel.ts';
import { type Line } from '../types/grid.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import type { AutomationManager } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationScheduleDefinition } from '@pellux/goodvibes-sdk/platform/automation';
import {
  buildEmptyState,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  extendPalette,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  enabled: '#5fd700',
  disabled: '#6c6c6c',
  selectedFg: '#ffffff',
  id: '238',
  cron: '#af87ff',
  prompt: '250',
  nextRun: '#87afff',
  lastRun: '244',
  runCount: '#ffaf00',
  statusRunning: '#5fd700',
  statusFailed: '#ff5f5f',
});

// ---------------------------------------------------------------------------
// View items
// ---------------------------------------------------------------------------

type ViewItem =
  | { kind: 'header' }
  | { kind: 'task'; task: AutomationJob; history: AutomationRun[] }
  | { kind: 'empty' };

type ScheduleAutomationManager = Pick<
  AutomationManager,
  'start' | 'listJobs' | 'listRuns' | 'setEnabled' | 'runNow'
>;

function formatSchedule(schedule: AutomationScheduleDefinition): string {
  switch (schedule.kind) {
    case 'cron':
      return schedule.timezone ? `${schedule.expression} [${schedule.timezone}]` : schedule.expression;
    case 'every':
      return formatEveryInterval(schedule.intervalMs);
    case 'at':
      return new Date(schedule.at).toLocaleString();
  }
}

function formatEveryInterval(intervalMs: number): string {
  const units: ReadonlyArray<readonly [number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  for (const [size, unit] of units) {
    if (intervalMs >= size && intervalMs % size === 0) {
      return `${intervalMs / size}${unit}`;
    }
  }
  return `${intervalMs}ms`;
}

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
  private refreshTimerId: ReturnType<typeof setInterval> | null = null;
  private readonly automationManager: ScheduleAutomationManager;

  constructor(automationManager: ScheduleAutomationManager, private readonly requestRender: () => void = () => {}) {
    super('schedule', 'Schedule', 'Z', 'agent');
    this.automationManager = automationManager;
  }

  private _markDirtyAndRender(): void {
    this.markDirty();
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override onActivate(): void {
    super.onActivate();
    void this.automationManager.start().then(() => {
      this.rebuild();
      this._markDirtyAndRender();
    });
    this.rebuild();
    this.refreshTimerId = this.registerTimer(setInterval(() => {
      this.rebuild();
      this._markDirtyAndRender();
    }, 5_000));
  }

  override onDeactivate(): void {
    if (this.refreshTimerId !== null) {
      this.clearTimer(this.refreshTimerId);
      this.refreshTimerId = null;
    }
  }

  override onDestroy(): void {
    this.onDeactivate();
    super.onDestroy();
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private rebuild(): void {
    const manager = this.automationManager;
    const tasks = manager.listJobs();

    const items: ViewItem[] = [{ kind: 'header' }];
    if (tasks.length === 0) {
      items.push({ kind: 'empty' });
    } else {
      for (const task of tasks) {
        items.push({
          kind: 'task',
          task,
          history: manager.listRuns(task.id),
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
          void this.automationManager.setEnabled(item.task.id, !item.task.enabled).then(() => {
            this.rebuild();
            this.markDirty();
          });
        }
        return true;
      }
      case 'r': {
        // Trigger immediate run of selected task
        const item = this.items[this.selectedIndex];
        if (item?.kind === 'task') {
          this.automationManager.runNow(item.task.id).catch(() => {
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
    const tasks = this.automationManager.listJobs();
    const enabled = tasks.filter((task: AutomationJob) => task.enabled).length;
    if (tasks.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: ' Schedule',
        intro: 'Review recurring scheduled tasks, next run timing, recent history, and enablement state.',
        sections: [
          {
            lines: buildEmptyState(
              width,
              ' No scheduled tasks',
              'Create a recurring task and its next-run timing, run history, and enablement state will appear here.',
              [
                { command: '/schedule add cron 0 * * * * repo sweep', summary: 'create a recurring cron task' },
                { command: '/schedule list', summary: 'inspect scheduled tasks from the shell' },
              ],
              DEFAULT_PANEL_PALETTE,
            ),
          },
        ],
        footerLines: [
          buildKeyboardHints(width, [
            { keys: '/schedule add', label: 'create a task' },
          ], DEFAULT_PANEL_PALETTE),
        ],
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    const taskItems = this.items.filter((item): item is Extract<ViewItem, { kind: 'task' }> => item.kind === 'task');
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, taskItems.length - 1));
    const dueSoon = tasks.filter((task: AutomationJob) => typeof task.nextRunAt === 'number').length;
    const summarySection: PanelWorkspaceSection = {
      title: 'Summary',
      lines: [
        buildPanelLine(width, [
          [' Tasks ', DEFAULT_PANEL_PALETTE.label],
          [String(tasks.length), DEFAULT_PANEL_PALETTE.value],
          ['   Enabled ', DEFAULT_PANEL_PALETTE.label],
          [String(enabled), enabled > 0 ? DEFAULT_PANEL_PALETTE.good : DEFAULT_PANEL_PALETTE.dim],
          ['   Paused ', DEFAULT_PANEL_PALETTE.label],
          [String(tasks.length - enabled), tasks.length - enabled > 0 ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
          ['   Scheduled ', DEFAULT_PANEL_PALETTE.label],
          [String(dueSoon), dueSoon > 0 ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim],
        ]),
      ],
    };
    const selectedTask = taskItems[this.selectedIndex]?.task;
    const toggleLabel = selectedTask
      ? (selectedTask.enabled ? 'pause task' : 'enable task')
      : 'toggle';
    const footerLines = [
      buildKeyboardHints(width, [
        { keys: 'Up/Down', label: 'navigate' },
        { keys: 'Space', label: toggleLabel },
        { keys: 'r', label: 'run now' },
        { keys: 'R', label: 'refresh' },
      ], DEFAULT_PANEL_PALETTE),
    ];
    const scheduledTasksSection = resolveScrollablePanelSection(width, height, {
      intro: 'Review recurring scheduled tasks, next run timing, recent history, and enablement state.',
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summarySection],
      section: {
        title: 'Scheduled Tasks',
        scrollableLines: taskItems.flatMap((item, index) => this.renderTask(item.task, item.history, index === this.selectedIndex, width)),
        selectedIndex: this.selectedIndex * 3,
        scrollOffset: this.scrollOffset,
        minRows: 6,
      },
    });
    this.scrollOffset = scheduledTasksSection.scrollOffset;
    const sections: PanelWorkspaceSection[] = [
      summarySection,
      scheduledTasksSection.section,
    ];

    return buildPanelWorkspace(width, height, {
      title: ' Schedule',
      intro: 'Review recurring scheduled tasks, next run timing, recent history, and enablement state.',
      sections,
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  /**
   * Render a task as 3 rows:
   *   Row 1: [status] id  name  schedule
   *   Row 2:          next: <date>  last: <date>  runs: N
   *   Row 3:          prompt preview  [history]
   */
  private renderTask(task: AutomationJob, history: AutomationRun[], selected: boolean, width: number): Line[] {
    const bg = selected ? C.selectBg : undefined;
    const fgBase = selected ? C.selectedFg : undefined;

    const bullet = task.enabled ? '* ' : 'o ';
    const bulletFg = task.enabled ? C.enabled : C.disabled;
    const nameStr = fitDisplay(task.name, 28);
    const scheduleText = formatSchedule(task.schedule);
    const row1 = buildPanelLine(width, [
      [bullet, bulletFg, bg],
      [fitDisplay(task.id, 12), fgBase ?? C.id, bg],
      ['  ', fgBase ?? C.prompt, bg],
      [nameStr, fgBase ?? C.prompt, bg],
      ['  ', fgBase ?? C.prompt, bg],
      [scheduleText, fgBase ?? C.cron, bg],
    ]);

    const indent = '    ';
    const nextStr = task.nextRunAt
      ? `next: ${new Date(task.nextRunAt).toLocaleString()}`
      : 'next: unknown';
    const lastStr = task.lastRunAt
      ? `last: ${new Date(task.lastRunAt).toLocaleString()}`
      : 'last: never';
    const row2 = buildPanelLine(width, [
      [indent, fgBase ?? C.prompt, bg],
      [nextStr.padEnd(36), fgBase ?? C.nextRun, bg],
      [lastStr.padEnd(32), fgBase ?? C.lastRun, bg],
      [`runs: ${task.runCount}`, fgBase ?? C.runCount, bg],
    ]);

    const maxPromptLen = Math.max(20, width - indent.length - 30);
    const prompt = task.execution.prompt ?? task.description ?? '';
    const promptPreview = truncateDisplay(prompt, maxPromptLen);

    // Show last 3 run statuses as colored dots
    const recentRuns = history.slice(-3);
    const runSegments = recentRuns.flatMap((run) => {
      const dotFg = run.status === 'failed' ? C.statusFailed : C.statusRunning;
      return [['\u25cf', dotFg, bg] as [string, string, string?]];
    });
    const row3 = buildPanelLine(width, [
      [indent, fgBase ?? C.prompt, bg],
      [promptPreview, fgBase ?? C.prompt, bg],
      ...(runSegments.length > 0 ? [['  ', fgBase ?? C.prompt, bg] as [string, string, string?], ...runSegments] : []),
    ]);

    // spacer row between tasks
    const spacer = buildPanelLine(width, [['', fgBase ?? C.prompt, bg]]);

    return [row1, row2, row3, spacer];
  }
}
