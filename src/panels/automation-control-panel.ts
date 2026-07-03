import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { UiAutomationSnapshot, UiReadModel, UiWatchersSnapshot } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import type { AutomationManager } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationScheduleDefinition } from '@pellux/goodvibes-sdk/platform/automation';
import type { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers';
import {
  type ConfirmState,
  handleConfirmInput,
  renderConfirmLines,
} from './confirm-state.ts';
import {
  buildDetailBlock,
  buildEmptyState,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';

// Base chrome only — title band, state colors, and text tokens all come
// straight from DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

function formatTime(value?: number): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}

function runStatusColor(status: string): string {
  if (status === 'completed') return C.good;
  if (status === 'failed' || status === 'dead_lettered') return C.bad;
  if (status === 'cancelled') return C.warn;
  return C.info;
}

function stateColor(state: string): string {
  if (state === 'running') return C.good;
  if (state === 'degraded' || state === 'starting') return C.warn;
  if (state === 'failed') return C.bad;
  return C.dim;
}

function sourceStatusColor(state?: string): string {
  if (state === 'healthy') return C.good;
  if (state === 'lagging' || state === 'stale' || state === 'degraded') return C.warn;
  if (state === 'failed') return C.bad;
  return C.dim;
}

function formatLag(value?: number): string {
  if (!value || value <= 0) return 'n/a';
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60_000)}m`;
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

function isWatcherActive(state: string): boolean {
  return state === 'running' || state === 'degraded' || state === 'starting';
}

type AutomationRun = UiAutomationSnapshot['runs'][number];
type AutomationJob = UiAutomationSnapshot['jobs'][number];
type WatcherEntry = UiWatchersSnapshot['watchers'][number];

type FocusSection = 'runs' | 'jobs' | 'sources';

type AutomationItem =
  | { readonly kind: 'run'; readonly run: AutomationRun }
  | { readonly kind: 'job'; readonly job: AutomationJob }
  | { readonly kind: 'source'; readonly watcher: WatcherEntry };

type ConfirmSubject = { readonly kind: 'job' | 'watcher'; readonly id: string };

type AutomationActions = Pick<AutomationManager, 'setEnabled' | 'runNow'>;
type WatcherLifecycle = Pick<WatcherRegistry, 'startWatcher' | 'stopWatcher'>;

export interface AutomationControlPanelDeps {
  /** Drives real job actions (enable/disable, run now). Absent = jobs render read-only. */
  readonly automationManager?: AutomationActions;
  /** Drives real watcher lifecycle actions (start/stop). Absent = sources render read-only. */
  readonly watcherRegistry?: WatcherLifecycle;
}

const FOCUS_SECTIONS: readonly FocusSection[] = ['runs', 'jobs', 'sources'];

/**
 * AutomationControlPanel — merged automation console (WO-111).
 *
 * Absorbs the former SchedulePanel (jobs, enable/disable, run-now) and
 * WatchersPanel (watcher health as a "Sources" section) into one dense,
 * actionable view: jobs + runs + deliveries + sources, with Tab cycling
 * between the three list sections.
 */
export class AutomationControlPanel extends ScrollableListPanel<AutomationItem> {
  private readonly readModel?: UiReadModel<UiAutomationSnapshot>;
  private readonly watchersReadModel?: UiReadModel<UiWatchersSnapshot>;
  private readonly automationManager?: AutomationActions;
  private readonly watcherRegistry?: WatcherLifecycle;
  private readonly unsub: (() => void) | null;
  private focusSection: FocusSection = 'runs';
  private confirmAction: ConfirmState<ConfirmSubject> | null = null;

  public constructor(
    readModel?: UiReadModel<UiAutomationSnapshot>,
    watchersReadModel?: UiReadModel<UiWatchersSnapshot>,
    deps: AutomationControlPanelDeps = {},
  ) {
    super('automation', 'Automation', '◨', 'automation-control');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter';
    this.readModel = readModel;
    this.watchersReadModel = watchersReadModel;
    this.automationManager = deps.automationManager;
    this.watcherRegistry = deps.watcherRegistry;
    const unsubAutomation = readModel?.subscribe(() => this.markDirty());
    const unsubWatchers = watchersReadModel?.subscribe(() => this.markDirty());
    this.unsub = (unsubAutomation || unsubWatchers)
      ? () => { unsubAutomation?.(); unsubWatchers?.(); }
      : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private getJobs(): readonly AutomationJob[] {
    return this.readModel?.getSnapshot().jobs ?? [];
  }

  private getRuns(): readonly AutomationRun[] {
    return this.readModel?.getSnapshot().runs ?? [];
  }

  private getWatchers(): readonly WatcherEntry[] {
    return this.watchersReadModel?.getSnapshot().watchers ?? [];
  }

  protected getItems(): readonly AutomationItem[] {
    if (this.focusSection === 'jobs') return this.getJobs().map((job): AutomationItem => ({ kind: 'job', job }));
    if (this.focusSection === 'sources') return this.getWatchers().map((watcher): AutomationItem => ({ kind: 'source', watcher }));
    return this.getRuns().map((run): AutomationItem => ({ kind: 'run', run }));
  }

  protected override filterMatches(item: AutomationItem, q: string): boolean {
    if (item.kind === 'run') {
      return item.run.jobId.toLowerCase().includes(q)
        || item.run.status.toLowerCase().includes(q)
        || item.run.target.kind.toLowerCase().includes(q);
    }
    if (item.kind === 'job') {
      return item.job.name.toLowerCase().includes(q) || item.job.id.toLowerCase().includes(q);
    }
    return item.watcher.label.toLowerCase().includes(q)
      || item.watcher.state.toLowerCase().includes(q)
      || String(item.watcher.sourceStatus ?? '').toLowerCase().includes(q);
  }

  protected override getEmptyStateMessage(): string {
    if (this.focusSection === 'jobs') return ' No automation jobs configured.';
    if (this.focusSection === 'sources') return ' No watchers registered.';
    return ' No automation activity recorded.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    if (this.focusSection === 'sources') {
      return [{ command: '/services auth-review', summary: 'validate integration credentials before enabling remote watchers' }];
    }
    return [{ command: '/schedule add cron 0 * * * * repo sweep', summary: 'create a recurring automation job' }];
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (this.confirmAction) {
      const result = handleConfirmInput(this.confirmAction, key);
      if (result === 'confirmed') {
        this._executeConfirmed(this.confirmAction.subject);
        this.confirmAction = null;
        this.markDirty();
        return true;
      }
      if (result === 'cancelled') {
        this.confirmAction = null;
        this.markDirty();
      }
      return true;
    }

    if (!this.filterActive) {
      switch (key) {
        case 'tab':
          this._cycleFocus();
          return true;
        case 'e':
          this._toggleSelected();
          return true;
        case 'r':
          this._runSelected();
          return true;
        case 'R':
          this.markDirty();
          return true;
        default:
          break;
      }
    }

    return super.handleInput(key);
  }

  private _cycleFocus(): void {
    const idx = FOCUS_SECTIONS.indexOf(this.focusSection);
    this.focusSection = FOCUS_SECTIONS[(idx + 1) % FOCUS_SECTIONS.length]!;
    this.selectedIndex = 0;
    this.markDirty();
  }

  private _toggleSelected(): void {
    const item = this.getSelectedItem();
    if (!item) return;
    if (item.kind === 'job') {
      if (item.job.enabled) {
        this.confirmAction = { subject: { kind: 'job', id: item.job.id }, label: item.job.name, verb: 'Disable' };
      } else if (this.automationManager) {
        void this.automationManager.setEnabled(item.job.id, true).catch(() => {});
      }
      this.markDirty();
      return;
    }
    if (item.kind === 'source' && this.watcherRegistry) {
      if (isWatcherActive(item.watcher.state)) {
        this.confirmAction = { subject: { kind: 'watcher', id: item.watcher.id }, label: item.watcher.label, verb: 'Stop' };
      } else {
        this.watcherRegistry.startWatcher(item.watcher.id);
      }
      this.markDirty();
    }
  }

  private _runSelected(): void {
    const item = this.getSelectedItem();
    if (item?.kind === 'job' && this.automationManager) {
      void this.automationManager.runNow(item.job.id).catch(() => {});
      this.markDirty();
    }
  }

  private _executeConfirmed(subject: ConfirmSubject): void {
    if (subject.kind === 'job') {
      void this.automationManager?.setEnabled(subject.id, false).catch(() => {});
    } else {
      this.watcherRegistry?.stopWatcher(subject.id, 'user requested');
    }
  }

  // -------------------------------------------------------------------------
  // Rendering — item rows
  // -------------------------------------------------------------------------

  protected renderItem(item: AutomationItem, _index: number, selected: boolean, width: number): Line {
    if (item.kind === 'run') return this._renderRunRow(item.run, selected, width);
    if (item.kind === 'job') return this._renderJobRow(item.job, selected, width);
    return this._renderSourceRow(item.watcher, selected, width);
  }

  private _renderRunRow(run: AutomationRun, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    const jobs = this.getJobs();
    const name = jobs.find((job) => job.id === run.jobId)?.name ?? run.jobId;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [run.status.padEnd(11), runStatusColor(run.status), bg],
      [` ${truncateDisplay(name, 22).padEnd(22)}`, C.value, bg],
      [` ${truncateDisplay(run.target.kind, 12).padEnd(12)}`, C.info, bg],
      [` ${truncateDisplay(formatTime(run.queuedAt), Math.max(0, width - 49))}`, C.dim, bg],
    ]);
  }

  private _renderJobRow(job: AutomationJob, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    const bullet = job.enabled ? '● ' : '○ ';
    const bulletFg = job.enabled ? C.good : C.warn;
    return buildPanelLine(width, [
      [bullet, bulletFg, bg],
      [truncateDisplay(job.name, 24).padEnd(24), C.value, bg],
      [` ${truncateDisplay(formatSchedule(job.schedule), 18).padEnd(18)}`, C.info, bg],
      [` next ${truncateDisplay(formatTime(job.nextRunAt), Math.max(0, width - 51))}`, C.dim, bg],
    ]);
  }

  private _renderSourceRow(watcher: WatcherEntry, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [watcher.state.padEnd(10), stateColor(watcher.state), bg],
      [` ${truncateDisplay(watcher.label, 18).padEnd(18)}`, C.value, bg],
      [` ${String(watcher.sourceStatus ?? 'unknown').padEnd(10)}`, sourceStatusColor(watcher.sourceStatus), bg],
      [` ${truncateDisplay(formatLag(watcher.sourceLagMs), Math.max(0, width - 43))}`, C.dim, bg],
    ]);
  }

  // -------------------------------------------------------------------------
  // Rendering — workspace
  // -------------------------------------------------------------------------

  public render(width: number, height: number): Line[] {
    const intro = 'Automation jobs, active runs, deliveries, and watcher-fed sources across the shared control plane.';

    if (!this.readModel) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Automation Control',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime store not wired.',
            'This panel needs the shared runtime store to inspect automation jobs, runs, and deliveries.',
            [],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const snapshot = this.readModel.getSnapshot();

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'jobs', value: String(snapshot.totalJobs), valueColor: snapshot.totalJobs > 0 ? C.info : C.dim },
        { label: 'runs', value: String(snapshot.totalRuns), valueColor: snapshot.totalRuns > 0 ? C.value : C.dim },
        { label: 'active', value: String(snapshot.activeRunIds.length), valueColor: snapshot.activeRunIds.length > 0 ? C.warn : C.dim },
        { label: 'failed', value: String(snapshot.totalFailed), valueColor: snapshot.totalFailed > 0 ? C.bad : C.dim },
      ], C),
      buildKeyValueLine(width, [
        { label: 'deliveries ok', value: String(snapshot.deliveryTotals.succeeded), valueColor: snapshot.deliveryTotals.succeeded > 0 ? C.good : C.dim },
        { label: 'delivery fail', value: String(snapshot.deliveryTotals.failed), valueColor: snapshot.deliveryTotals.failed > 0 ? C.bad : C.dim },
        { label: 'dead letters', value: String(snapshot.deliveryTotals.deadLettered), valueColor: snapshot.deliveryTotals.deadLettered > 0 ? C.warn : C.dim },
        { label: 'sources', value: String(snapshot.sourceCount), valueColor: snapshot.sourceCount > 0 ? C.info : C.dim },
      ], C),
      this._buildFocusTabsLine(width),
    ];

    const items = this.getVisibleItems();
    this.clampSelection();
    const selected = this.getSelectedItem();

    const footerLines: Line[] = [];
    if (items.length > 0 && selected) {
      footerLines.push(...this._buildDetailLines(width, selected, snapshot));
      if (this.confirmAction) footerLines.push(...renderConfirmLines(width, this.confirmAction));
    }

    return this.renderList(width, height, {
      title: 'Automation Control',
      header: headerLines,
      footer: footerLines,
      hints: this._buildHints(selected),
    });
  }

  private _buildFocusTabsLine(width: number): Line {
    const seg = (label: string, section: FocusSection): [string, string] => [
      ` ${label} `,
      this.focusSection === section ? C.value : C.dim,
    ];
    return buildPanelLine(width, [
      seg('Runs', 'runs'),
      seg('Jobs', 'jobs'),
      seg('Sources', 'sources'),
      [' (Tab to switch)', C.dim],
    ]);
  }

  private _buildHints(selected: AutomationItem | undefined): ReadonlyArray<{ keys: string; label: string }> {
    if (this.filterActive) {
      return [{ keys: 'type', label: 'filter' }, { keys: 'Enter', label: 'apply' }, { keys: 'Esc', label: 'clear' }];
    }
    const hints: Array<{ keys: string; label: string }> = [
      { keys: 'Up/Down', label: `select ${this.focusSection === 'jobs' ? 'job' : this.focusSection === 'sources' ? 'source' : 'run'}` },
      { keys: 'Tab', label: 'section' },
    ];
    if (this.focusSection === 'jobs' && selected?.kind === 'job' && this.automationManager) {
      hints.push({ keys: 'e', label: selected.job.enabled ? 'disable' : 'enable' });
      hints.push({ keys: 'r', label: 'run now' });
    }
    if (this.focusSection === 'sources' && this.watcherRegistry && selected?.kind === 'source') {
      hints.push({ keys: 'e', label: isWatcherActive(selected.watcher.state) ? 'stop' : 'start' });
    }
    hints.push({ keys: 'R', label: 'refresh' }, { keys: '/', label: 'filter' });
    return hints;
  }

  private _buildDetailLines(width: number, item: AutomationItem, snapshot: UiAutomationSnapshot): Line[] {
    if (item.kind === 'run') {
      const jobName = this.getJobs().find((job) => job.id === item.run.jobId)?.name ?? item.run.jobId;
      const rows: Line[] = [
        buildPanelLine(width, [['  Run: ', C.label], [item.run.id, C.value], ['  Status: ', C.label], [item.run.status, runStatusColor(item.run.status)]]),
        buildPanelLine(width, [['  Job: ', C.label], [jobName, C.value], ['  Agent: ', C.label], [item.run.agentId ?? 'n/a', C.info]]),
        buildPanelLine(width, [['  Queue: ', C.label], [formatTime(item.run.queuedAt), C.dim], ['  End: ', C.label], [formatTime(item.run.endedAt), C.dim]]),
        buildPanelLine(width, [['  Trigger: ', C.label], [item.run.triggeredBy.kind, C.info], ['  Target: ', C.label], [item.run.target.kind, C.value]]),
        buildPanelLine(width, [['  Deliveries: ', C.label], [String(item.run.deliveryIds.length), item.run.deliveryIds.length > 0 ? C.info : C.dim], ['  Route: ', C.label], [item.run.routeId ?? 'n/a', C.dim]]),
      ];
      if (item.run.error) {
        rows.push(buildPanelLine(width, [['  Error: ', C.label], [truncateDisplay(item.run.error, Math.max(0, width - 10)), C.bad]]));
      }
      return buildDetailBlock(width, `Run · ${item.run.id}`, rows, C);
    }
    if (item.kind === 'job') {
      const recent = snapshot.runs.filter((run) => run.jobId === item.job.id).slice(0, 3).reverse();
      const dots = recent.length > 0
        ? recent.map((run) => (run.status === 'failed' ? '✗' : run.status === 'completed' ? '✓' : '●')).join(' ')
        : 'none';
      const rows: Line[] = [
        buildPanelLine(width, [['  Job: ', C.label], [item.job.name, C.value], ['  State: ', C.label], [item.job.enabled ? 'enabled' : 'paused', item.job.enabled ? C.good : C.warn]]),
        buildPanelLine(width, [['  Schedule: ', C.label], [formatSchedule(item.job.schedule), C.info]]),
        buildPanelLine(width, [['  Next: ', C.label], [formatTime(item.job.nextRunAt), C.dim], ['  Last: ', C.label], [formatTime(item.job.lastRunAt), C.dim]]),
        buildPanelLine(width, [['  Runs: ', C.label], [String(item.job.runCount), C.value], ['  Recent: ', C.label], [dots, C.dim]]),
        buildPanelLine(width, [['  Prompt: ', C.label], [truncateDisplay(item.job.execution.prompt ?? item.job.description ?? '', Math.max(0, width - 12)), C.dim]]),
      ];
      return buildDetailBlock(width, `Job · ${item.job.name}`, rows, C);
    }
    const w = item.watcher;
    const rows: Line[] = [
      buildPanelLine(width, [['  Watcher: ', C.label], [w.label, C.value], ['  Kind: ', C.label], [w.kind, C.info]]),
      buildPanelLine(width, [['  State: ', C.label], [w.state, stateColor(w.state)], ['  Source: ', C.label], [w.source.kind, C.value]]),
      buildPanelLine(width, [['  Source status: ', C.label], [w.sourceStatus ?? 'unknown', sourceStatusColor(w.sourceStatus)], ['  Lag: ', C.label], [formatLag(w.sourceLagMs), w.sourceLagMs ? C.warn : C.dim]]),
      buildPanelLine(width, [['  Heartbeat: ', C.label], [formatTime(w.lastHeartbeatAt), C.dim], ['  Checkpoint: ', C.label], [truncateDisplay(w.lastCheckpoint ?? 'n/a', Math.max(0, width - 38)), C.dim]]),
    ];
    if (w.degradedReason) rows.push(buildPanelLine(width, [['  Reason: ', C.label], [truncateDisplay(w.degradedReason, Math.max(0, width - 11)), C.warn]]));
    if (w.lastError) rows.push(buildPanelLine(width, [['  Error: ', C.label], [truncateDisplay(w.lastError, Math.max(0, width - 10)), C.bad]]));
    return buildDetailBlock(width, `Source · ${w.label}`, rows, C);
  }
}
