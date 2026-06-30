import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { UiAutomationSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  buildSectionHeader,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  info: '#38bdf8',
  selectBg: '#0f172a',
} as const;

function formatTime(value?: number): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}

function runStatusColor(status: string): string {
  if (status === 'completed') return C.ok;
  if (status === 'failed' || status === 'dead_lettered') return C.error;
  if (status === 'cancelled') return C.warn;
  return C.info;
}

type AutomationRun = UiAutomationSnapshot['runs'][number];
type AutomationJob = UiAutomationSnapshot['jobs'][number];

export class AutomationControlPanel extends ScrollableListPanel<AutomationRun> {
  private readonly readModel?: UiReadModel<UiAutomationSnapshot>;
  private readonly unsub: (() => void) | null;

  public constructor(readModel?: UiReadModel<UiAutomationSnapshot>) {
    super('automation', 'Automation', 'M', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter runs';
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  private getJobs(): readonly AutomationJob[] {
    if (!this.readModel) return [];
    return this.readModel.getSnapshot().jobs;
  }

  protected getItems(): readonly AutomationRun[] {
    if (!this.readModel) return [];
    return this.readModel.getSnapshot().runs;
  }

  protected override filterMatches(run: AutomationRun, q: string): boolean {
    return run.jobId.toLowerCase().includes(q)
      || run.status.toLowerCase().includes(q)
      || run.target.kind.toLowerCase().includes(q);
  }

  protected renderItem(run: AutomationRun, _index: number, selected: boolean, width: number): Line {
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

  protected override getEmptyStateMessage(): string {
    return ' No automation activity recorded.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/schedule add cron 0 * * * * repo sweep', summary: 'create a recurring automation job' },
      { command: '/schedule list', summary: 'inspect jobs and run history from the shell' },
    ];
  }

  public render(width: number, height: number): Line[] {
    const intro = 'Automation jobs, active runs, deliveries, and failure posture across the shared control plane.';

    if (!this.readModel) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Automation Control',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime store not wired.',
            'This panel needs the shared runtime store to inspect automation jobs, runs, and deliveries.',
            [{ command: '/schedule list', summary: 'review automation from the shell while the runtime wiring is restored' }],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const snapshot = this.readModel.getSnapshot();
    const jobs = [...snapshot.jobs];
    const runs = this.getItems();

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'jobs', value: String(snapshot.totalJobs), valueColor: snapshot.totalJobs > 0 ? C.info : C.dim },
        { label: 'runs', value: String(snapshot.totalRuns), valueColor: snapshot.totalRuns > 0 ? C.value : C.dim },
        { label: 'active', value: String(snapshot.activeRunIds.length), valueColor: snapshot.activeRunIds.length > 0 ? C.warn : C.dim },
        { label: 'failed', value: String(snapshot.totalFailed), valueColor: snapshot.totalFailed > 0 ? C.error : C.dim },
      ], C),
      buildKeyValueLine(width, [
        { label: 'deliveries ok', value: String(snapshot.deliveryTotals.succeeded), valueColor: snapshot.deliveryTotals.succeeded > 0 ? C.ok : C.dim },
        { label: 'delivery fail', value: String(snapshot.deliveryTotals.failed), valueColor: snapshot.deliveryTotals.failed > 0 ? C.error : C.dim },
        { label: 'dead letters', value: String(snapshot.deliveryTotals.deadLettered), valueColor: snapshot.deliveryTotals.deadLettered > 0 ? C.warn : C.dim },
        { label: 'sources', value: String(snapshot.sourceCount), valueColor: snapshot.sourceCount > 0 ? C.info : C.dim },
      ], C),
      buildGuidanceLine(width, '/schedule list', 'manage jobs and use the web or surface controls for retries, delivery, and cross-surface sessions', C),
    ];

    if (jobs.length === 0 && runs.length === 0) {
      return this.renderList(width, height, {
        title: 'Automation Control',
        header: headerLines,
        emptyMessage: ' No automation activity recorded.',
      });
    }

    this.clampSelection();
    const selectedRun = runs[this.selectedIndex];
    const jobName = selectedRun ? (jobs.find((job) => job.id === selectedRun.jobId)?.name ?? selectedRun.jobId) : 'n/a';

    const footerLines: Line[] = [];
    if (selectedRun) {
      footerLines.push(
        buildPanelLine(width, [
          ['  Run: ', C.label],
          [selectedRun.id, C.value],
          ['  Status: ', C.label],
          [selectedRun.status, runStatusColor(selectedRun.status)],
        ]),
        buildPanelLine(width, [
          ['  Job: ', C.label],
          [jobName, C.value],
          ['  Agent: ', C.label],
          [selectedRun.agentId ?? 'n/a', C.info],
        ]),
        buildPanelLine(width, [
          ['  Queue: ', C.label],
          [formatTime(selectedRun.queuedAt), C.dim],
          ['  End: ', C.label],
          [formatTime(selectedRun.endedAt), C.dim],
        ]),
        buildPanelLine(width, [
          ['  Trigger: ', C.label],
          [selectedRun.triggeredBy.kind, C.info],
          ['  Target: ', C.label],
          [selectedRun.target.kind, C.value],
        ]),
        buildPanelLine(width, [
          ['  Deliveries: ', C.label],
          [String(selectedRun.deliveryIds.length), selectedRun.deliveryIds.length > 0 ? C.info : C.dim],
          ['  Route: ', C.label],
          [selectedRun.routeId ?? 'n/a', C.dim],
        ]),
      );
      if (selectedRun.error) {
        footerLines.push(buildPanelLine(width, [
          ['  Error: ', C.label],
          [truncateDisplay(selectedRun.error, Math.max(0, width - 10)), C.error],
        ]));
      }
    } else {
      footerLines.push(buildPanelLine(width, [['  No run selected.', C.dim]]));
    }

    // Jobs quick view
    if (jobs.length > 0) {
      const enabledJobs = jobs.filter((job) => job.enabled).length;
      footerLines.push(buildSectionHeader(width, `Jobs (${enabledJobs} enabled / ${jobs.length})`, C));
      footerLines.push(
        ...jobs.slice(0, 6).map((job) => buildPanelLine(width, [
          [' ', C.label],
          [job.enabled ? 'ENABLED ' : 'PAUSED  ', job.enabled ? C.ok : C.warn],
          [truncateDisplay(job.name, 24).padEnd(24), C.value],
          [` next ${truncateDisplay(formatTime(job.nextRunAt), Math.max(0, width - 43))}`, C.dim],
        ])),
      );
    }
    footerLines.push(
      this.filterActive
        ? buildKeyboardHints(width, [
            { keys: 'type', label: 'filter runs' },
            { keys: 'Enter', label: 'apply' },
            { keys: 'Esc', label: 'clear' },
          ], C)
        : buildKeyboardHints(width, [
            { keys: 'Up/Down', label: 'select run' },
            { keys: '/', label: 'filter' },
          ], C),
    );

    return this.renderList(width, height, {
      title: 'Automation Control',
      header: headerLines,
      footer: footerLines,
    });
  }
}
