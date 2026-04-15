import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types/grid';
import { BasePanel } from './base-panel.ts';
import type { UiAutomationSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '@pellux/goodvibes-sdk/platform/utils/terminal-width';
import {
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
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

export class AutomationControlPanel extends BasePanel {
  private readonly readModel?: UiReadModel<UiAutomationSnapshot>;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(readModel?: UiReadModel<UiAutomationSnapshot>) {
    super('automation', 'Automation', 'M', 'monitoring');
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const runs = this.runs();
    if (runs.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(runs.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private runs() {
    if (!this.readModel) return [];
    return [...this.readModel.getSnapshot().runs];
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
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
    const runs = this.runs();

    const summarySection: PanelWorkspaceSection = {
      title: 'Posture',
      lines: [
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
      ],
    };

    if (jobs.length === 0 && runs.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Automation Control',
        intro,
        sections: [
          summarySection,
          {
            lines: buildEmptyState(
              width,
              ' No automation activity recorded.',
              'Create a job, run one manually, or let a watcher/surface trigger automation to populate this control room.',
              [
                { command: '/schedule add cron 0 * * * * repo sweep', summary: 'create a recurring automation job' },
                { command: '/schedule list', summary: 'inspect jobs and run history from the shell' },
              ],
              C,
            ),
          },
        ],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, runs.length - 1));
    const selectedRun = runs[this.selectedIndex];
    const jobName = selectedRun ? (jobs.find((job) => job.id === selectedRun.jobId)?.name ?? selectedRun.jobId) : 'n/a';

    const jobSection: PanelWorkspaceSection = {
      title: 'Jobs',
      lines: jobs.slice(0, 6).map((job) => buildPanelLine(width, [
        [' ', C.label],
        [job.enabled ? 'ENABLED ' : 'PAUSED  ', job.enabled ? C.ok : C.warn],
        [truncateDisplay(job.name, 24).padEnd(24), C.value],
        [` next ${truncateDisplay(formatTime(job.nextRunAt), Math.max(0, width - 43))}`, C.dim],
      ])),
    };

    const detailSection: PanelWorkspaceSection = selectedRun
      ? {
          title: 'Selected Run',
          lines: [
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
            ...(selectedRun.error ? [
              buildPanelLine(width, [
                ['  Error: ', C.label],
                [truncateDisplay(selectedRun.error, Math.max(0, width - 10)), C.error],
              ]),
            ] : []),
          ],
        }
      : {
          title: 'Selected Run',
          lines: [buildPanelLine(width, [['  No run selected.', C.dim]])],
        };

    const resolvedRuns = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down move through runs', C.dim]])],
      palette: C,
      beforeSections: [summarySection],
      section: {
        title: 'Recent Runs',
        scrollableLines: runs.map((run, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          const name = jobs.find((job) => job.id === run.jobId)?.name ?? run.jobId;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [run.status.padEnd(11), runStatusColor(run.status), bg],
            [` ${truncateDisplay(name, 22).padEnd(22)}`, C.value, bg],
            [` ${truncateDisplay(run.target.kind, 12).padEnd(12)}`, C.info, bg],
            [` ${truncateDisplay(formatTime(run.queuedAt), Math.max(0, width - 49))}`, C.dim, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 5,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection, jobSection],
    });
    this.scrollOffset = resolvedRuns.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      summarySection,
      resolvedRuns.section,
      detailSection,
      jobSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Automation Control',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move through runs', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
