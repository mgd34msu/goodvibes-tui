import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import type { ForensicsRegistry } from '@pellux/goodvibes-sdk/platform/runtime/forensics/registry';
import { BasePanel } from './base-panel.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

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

export class IncidentReviewPanel extends BasePanel {
  private readonly registry?: ForensicsRegistry;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(registry?: ForensicsRegistry) {
    super('incident', 'Incident Review', 'N', 'monitoring');
    this.registry = registry;
    this.unsub = registry ? registry.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const reports = this.registry?.getAll() ?? [];
    if (reports.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(reports.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedIndex = reports.length - 1;
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
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

    const reports = this.registry.getAll();
    if (reports.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: 'Incident Review Workspace',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No incidents recorded yet.',
            'The incident workspace fills automatically when failures produce forensics reports, replay mismatches, or policy-linked fallout.',
            [
              { command: '/incident latest', summary: 'inspect the latest report once one exists' },
              { command: '/recall capture incident latest', summary: 'promote incident evidence into project knowledge' },
            ],
            C,
          ),
        }],
        palette: C,
      });
    }

    this.selectedIndex = Math.min(this.selectedIndex, reports.length - 1);
    const selected = reports[this.selectedIndex]!;
    const bundle = this.registry.buildBundle(selected.id);

    const summaryLines = [
      buildKeyValueLine(width, [
        { label: 'incidents', value: String(reports.length), valueColor: C.value },
        { label: 'selected', value: `${this.selectedIndex + 1}/${reports.length}`, valueColor: C.info },
        { label: 'classification', value: selected.classification, valueColor: classificationColor(selected.classification) },
      ], C),
      buildPanelLine(width, [['  Up/Down move  Home/End jump  selected incident drives the action rail below', C.dim]]),
    ];

    const selectedLines: Line[] = [];
    if (bundle) {
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'id', value: selected.id, valueColor: C.dim },
        { label: 'trace', value: selected.traceId, valueColor: C.dim },
      ], C));
      selectedLines.push(...buildBodyText(width, `Root cause: ${bundle.evidence.rootCause ?? 'n/a'}`, C, C.value));
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'Permissions denied', value: String(bundle.evidence.deniedPermissionCount), valueColor: bundle.evidence.deniedPermissionCount > 0 ? C.warn : C.dim },
        { label: 'Budget breaches', value: String(bundle.evidence.budgetBreachCount), valueColor: bundle.evidence.budgetBreachCount > 0 ? C.warn : C.dim },
        { label: 'Replay mismatches', value: String(bundle.replay.mismatchCount), valueColor: bundle.replay.mismatchCount > 0 ? C.bad : C.dim },
      ], C));
      selectedLines.push(buildPanelLine(width, [
        ['  Related IDs: ', C.label],
        [`turn=${bundle.evidence.relatedIds.turnId ?? 'n/a'} task=${bundle.evidence.relatedIds.taskId ?? 'n/a'} agent=${bundle.evidence.relatedIds.agentId ?? 'n/a'}`.slice(0, Math.max(0, width - 14)), C.info],
      ]));
      if (bundle.evidence.slowPhases.length > 0) {
        selectedLines.push(buildPanelLine(width, [
          ['  Slow phases: ', C.label],
          [bundle.evidence.slowPhases.join(', ').slice(0, Math.max(0, width - 15)), C.warn],
        ]));
      }
      const rootCause = selected.causalChain.find((entry) => entry.isRootCause);
      if (rootCause) {
        selectedLines.push(buildPanelLine(width, [
          ['  Root event: ', C.label],
          [`${rootCause.sourceEventType} - ${rootCause.description}`.slice(0, Math.max(0, width - 14)), C.dim],
        ]));
      }
      const denied = selected.permissionEvidence.find((entry) => entry.approved === false);
      if (denied) {
        selectedLines.push(buildPanelLine(width, [
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
        selectedLines.push(buildPanelLine(width, [
          ['  ', C.label],
          [replayDetail.slice(0, Math.max(0, width - 2)), C.bad],
        ]));
      } else {
        const ownerBreakdown = Object.entries(bundle.replay.mismatchBreakdown.byOwnerDomain)
        .filter(([, count]) => count > 0)
        .slice(0, 3)
        .map(([domain, count]) => `${domain}:${count}`)
        .join(', ');
        if (ownerBreakdown.length > 0) {
          selectedLines.push(buildPanelLine(width, [
            ['  Replay owners: ', C.label],
            [ownerBreakdown.slice(0, Math.max(0, width - 17)), C.info],
          ]));
        }
      }
    }

    const actionLines = [
      buildPanelLine(width, [[`  /incident latest   /incident export ${selected.id}   /recall capture incident ${selected.id}`, C.info]]),
    ];

    const summarySection: PanelWorkspaceSection = { title: 'Summary', lines: summaryLines };
    const actionSection: PanelWorkspaceSection = { title: 'Action Rail', lines: actionLines };
    const selectedIncidentSection: PanelWorkspaceSection = { title: 'Selected Incident', lines: selectedLines };
    const incidentsSection = resolveScrollablePanelSection(width, height, {
      intro,
      palette: C,
      beforeSections: [summarySection],
      section: {
        title: 'Incidents',
        scrollableLines: reports.map((report, globalIndex) => {
          const bg = globalIndex === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [report.id.slice(0, 8).padEnd(9), C.dim, bg],
            [report.classification.padEnd(20), classificationColor(report.classification), bg],
            [report.summary.slice(0, Math.max(0, width - 31)), C.value, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [actionSection, selectedIncidentSection],
    });
    this.scrollOffset = incidentsSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      summarySection,
      incidentsSection.section,
      actionSection,
      selectedIncidentSection,
    ];

    return buildPanelWorkspace(width, height, {
      title: 'Incident Review Workspace',
      intro,
      sections,
      palette: C,
    });
  }
}
