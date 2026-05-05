import type { Line } from '../types/grid.ts';
import type { ForensicsRegistry } from '@/runtime/index.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusPill,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';
import type { FailureReport } from '@/runtime/index.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#cbd5e1',
  headerBg: '#0f172a',
  warn: '#f59e0b',
  bad: '#ef4444',
  selectBg: '#111827',
} as const;

function classificationColor(value: string): string {
  switch (value) {
    case 'cancelled':
      return C.dim;
    case 'max_tokens':
    case 'unknown':
      return C.warn;
    default:
      return C.bad;
  }
}

export class IncidentReviewPanel extends ScrollableListPanel<FailureReport> {
  private readonly registry?: ForensicsRegistry;
  private readonly unsub: (() => void) | null;

  public constructor(registry?: ForensicsRegistry) {
    super('incident', 'Incident Review', 'N', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.registry = registry;
    this.unsub = registry ? registry.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly FailureReport[] {
    return this.registry?.getAll() ?? [];
  }

  protected renderItem(report: FailureReport, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [report.id.slice(0, 8).padEnd(9), C.dim, bg],
      [report.classification.padEnd(20), classificationColor(report.classification), bg],
      [report.summary.slice(0, Math.max(0, width - 31)), C.value, bg],
    ]);
  }

  protected override getEmptyStateMessage(): string {
    return ' No incidents recorded yet.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/incident latest', summary: 'inspect the latest report once one exists' },
      { command: '/recall capture incident latest', summary: 'promote incident evidence into project knowledge' },
    ];
  }

  public render(width: number, height: number): Line[] {
    const intro = 'Failure bundles, replay mismatches, permission fallout, and exportable review evidence.';

    if (!this.registry) {
      return buildPanelWorkspace(width, height, {
        title: 'Incident Review Workspace',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Forensics registry not wired into this panel yet.',
            'Incident review needs the live forensics registry so it can inspect failure bundles, replay mismatches, and causal evidence.',
            [
              { command: '/incident latest', summary: 'inspect the latest incident from the command surface' },
              { command: '/security', summary: 'open the broader trust and incident posture control room' },
            ],
            C,
          ),
        }],
        palette: C,
      });
    }

    const reports = this.getItems();
    if (reports.length === 0) {
      return this.renderList(width, height, { title: 'Incident Review Workspace' });
    }

    this.clampSelection();
    const selected = reports[this.selectedIndex]!;
    const bundle = this.registry.buildBundle(selected.id);

    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'incidents', value: String(reports.length), valueColor: C.value },
        { label: 'selected', value: `${this.selectedIndex + 1}/${reports.length}`, valueColor: C.info },
        { label: 'classification', value: selected.classification, valueColor: classificationColor(selected.classification) },
      ], C),
      buildPanelLine(width, [['  Up/Down move  Home/End jump  selected incident drives the action rail below', C.dim]]),
    ];

    const footerLines: Line[] = [];
    if (bundle) {
      footerLines.push(buildKeyValueLine(width, [
        { label: 'id', value: selected.id, valueColor: C.dim },
        { label: 'trace', value: selected.traceId, valueColor: C.dim },
      ], C));
      footerLines.push(...buildBodyText(width, `Root cause: ${bundle.evidence.rootCause ?? 'n/a'}`, C, C.value));
      footerLines.push(buildKeyValueLine(width, [
        { label: 'Permissions denied', value: String(bundle.evidence.deniedPermissionCount), valueColor: bundle.evidence.deniedPermissionCount > 0 ? C.warn : C.dim },
        { label: 'Budget breaches', value: String(bundle.evidence.budgetBreachCount), valueColor: bundle.evidence.budgetBreachCount > 0 ? C.warn : C.dim },
        { label: 'Replay mismatches', value: String(bundle.replay.mismatchCount), valueColor: bundle.replay.mismatchCount > 0 ? C.bad : C.dim },
      ], C));
      footerLines.push(buildPanelLine(width, [
        ['  Related IDs: ', C.label],
        [`turn=${bundle.evidence.relatedIds.turnId ?? 'n/a'} task=${bundle.evidence.relatedIds.taskId ?? 'n/a'} agent=${bundle.evidence.relatedIds.agentId ?? 'n/a'}`.slice(0, Math.max(0, width - 14)), C.info],
      ]));
      if (bundle.evidence.slowPhases.length > 0) {
        footerLines.push(buildPanelLine(width, [
          ['  Slow phases: ', C.label],
          ...buildStatusPill('warn', bundle.evidence.slowPhases.join(', ').slice(0, Math.max(0, width - 15))),
        ]));
      }
      const rootCause = selected.causalChain.find((entry) => entry.isRootCause);
      if (rootCause) {
        footerLines.push(buildPanelLine(width, [
          ['  Root event: ', C.label],
          [`${rootCause.sourceEventType} - ${rootCause.description}`.slice(0, Math.max(0, width - 14)), C.dim],
        ]));
      }
      const denied = selected.permissionEvidence.find((entry) => entry.approved === false);
      if (denied) {
        footerLines.push(buildPanelLine(width, [
          ['  Permission: ', C.label],
          [`${denied.tool} denied${denied.riskLevel ? ` (${denied.riskLevel})` : ''}${denied.summary ? ` - ${denied.summary}` : ''}`.slice(0, Math.max(0, width - 14)), C.warn],
        ]));
      }
      if (bundle.replay.relatedMismatches.length > 0) {
        const mismatch = bundle.replay.relatedMismatches[0]!;
        const ownerBreakdown = Object.entries(bundle.replay.mismatchBreakdown.byOwnerDomain)
          .filter(([, count]) => count > 0)
          .slice(0, 3)
          .map(([domain, count]) => `${domain}:${count}`)
          .join(', ');
        const replayDetail = ownerBreakdown.length > 0
          ? `Replay link: ${mismatch.kind}${mismatch.ownerDomain ? `/${mismatch.ownerDomain}` : ''} - ${mismatch.description}  Replay owners: ${ownerBreakdown}`
          : `Replay link: ${mismatch.kind}${mismatch.ownerDomain ? `/${mismatch.ownerDomain}` : ''} - ${mismatch.description}`;
        footerLines.push(buildPanelLine(width, [
          ['  ', C.label],
          ...buildStatusPill('bad', replayDetail.slice(0, Math.max(0, width - 2))),
        ]));
      } else {
        const ownerBreakdown = Object.entries(bundle.replay.mismatchBreakdown.byOwnerDomain)
          .filter(([, count]) => count > 0)
          .slice(0, 3)
          .map(([domain, count]) => `${domain}:${count}`)
          .join(', ');
        if (ownerBreakdown.length > 0) {
          footerLines.push(buildPanelLine(width, [
            ['  Replay owners: ', C.label],
            [ownerBreakdown.slice(0, Math.max(0, width - 17)), C.info],
          ]));
        }
      }
    }
    footerLines.push(buildPanelLine(width, [['  Action Rail', C.label]]));
    footerLines.push(buildPanelLine(width, [[`  /incident latest   /incident export ${selected.id}   /recall capture incident ${selected.id}`, C.info]]));
    footerLines.push(buildGuidanceLine(width, '/security', 'open the broader trust and incident posture control room', C));

    return this.renderList(width, height, {
      title: 'Incident Review Workspace',
      header: headerLines,
      footer: footerLines,
    });
  }
}
