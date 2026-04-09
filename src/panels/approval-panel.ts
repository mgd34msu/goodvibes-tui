import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getPolicyRuntimeState } from '../runtime/permissions/policy-runtime.ts';
import { buildPermissionRuleSuggestions } from '../runtime/permissions/rule-suggestions.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  headerBg: '#111827',
} as const;

const APPROVAL_ROWS = [
  ['shell', 'why prompted: side effects, destructive ops, secret exposure, escalation', 'review via /security and /policy preflight'],
  ['file', 'why prompted: config mutation, notebook edits, secret-bearing paths', 'review via /approval review file'],
  ['network', 'why prompted: external hosts, fetch scope, egress policy', 'review via /approval review network'],
  ['delegate', 'why prompted: recursive agents, spawn ceilings, write-set inheritance', 'review via /approval review delegate'],
  ['mcp', 'why prompted: trust escalation, host scope, path scope, coherence mismatch', 'review via /mcp trust and /security'],
  ['remote', 'why prompted: runner trust, remote write scope, artifact requirements', 'review via /remote and /sandbox'],
  ['hook', 'why prompted: deny/mutate authority, blocking behavior, runner provenance', 'review via /hooks and /security'],
  ['plugin', 'why prompted: install/update lifecycle, provenance, capability grants', 'review via /marketplace and /security'],
  ['sandbox', 'why prompted: WSL/VM isolation changes alter host risk posture', 'review via /sandbox preset and /sandbox review'],
] as const;

export class ApprovalPanel extends BasePanel {
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor() {
    super('approval', 'Approval', 'A', 'monitoring');
  }

  public handleInput(key: string): boolean {
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(APPROVAL_ROWS.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedIndex = APPROVAL_ROWS.length - 1;
      this.markDirty();
      return true;
    }
    if (key === 'enter' || key === 'return') {
      return true;
    }
    return false;
  }

  public getSelectedCommand(): string | null {
    const selected = APPROVAL_ROWS[this.selectedIndex] ?? null;
    return selected ? selected[2].replace('review via ', '').trim() : null;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const policySnapshot = getPolicyRuntimeState().getSnapshot();
    const postureLines = [
      buildKeyValueLine(width, [
        { label: 'why prompted', value: 'risk summary', valueColor: C.value },
        { label: 'what-if', value: '/policy simulate + preflight', valueColor: C.info },
        { label: 'operator', value: '/security + /cockpit', valueColor: C.good },
      ], C),
      buildKeyValueLine(width, [
        { label: 'recent approvals', value: String(policySnapshot.recentPermissionAudit.filter((entry) => entry.approved === true).length), valueColor: C.good },
        { label: 'recent denials', value: String(policySnapshot.recentPermissionAudit.filter((entry) => entry.approved === false).length), valueColor: C.bad },
        { label: 'pending', value: String(policySnapshot.recentPermissionAudit.filter((entry) => entry.approved === undefined).length), valueColor: C.info },
      ], C),
      buildGuidanceLine(width, '/approval review shell', 'inspect the highest-risk approval lane and refine scoped review posture', C),
    ];
    const footerLines = [buildPanelLine(width, [[`  Up/Down move  Home/End jump  selected lane opens the next command path`, C.dim]])];
    const selected = APPROVAL_ROWS[this.selectedIndex] ?? null;
    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(buildKeyValueLine(width, [
        { label: 'lane', value: selected[0], valueColor: C.info },
        { label: 'next review', value: selected[2], valueColor: C.dim },
      ], C));
      detailLines.push(buildPanelLine(width, [[` ${selected[1]}`, C.value]]));
      detailLines.push(buildGuidanceLine(width, selected[2].replace('review via ', ''), `open the ${selected[0]} review path`, C));
    }
    const recentAuditLines: Line[] = [];
    for (const entry of policySnapshot.recentPermissionAudit.slice(0, 5)) {
      const decision = entry.approved === undefined ? 'pending' : entry.approved ? 'approved' : 'denied';
      const decisionColor = entry.approved === undefined ? C.info : entry.approved ? C.good : C.bad;
      recentAuditLines.push(buildPanelLine(width, [
        [`  ${decision.padEnd(8)}`, decisionColor],
        [`${entry.tool}`.padEnd(14), C.label],
        [entry.summary.slice(0, Math.max(0, width - 28)), C.value],
      ]));
      if (entry.reasons[0]) {
        recentAuditLines.push(buildPanelLine(width, [[`    ${entry.reasons[0]}`, C.dim]]));
      }
    }
    if (recentAuditLines.length === 0) {
      recentAuditLines.push(buildPanelLine(width, [[`  No recent approval pressure. Live requests and decisions will appear here.`, C.dim]]));
    }
    const ruleSuggestionLines: Line[] = [];
    for (const suggestion of buildPermissionRuleSuggestions(policySnapshot.recentPermissionAudit).slice(0, 3)) {
      ruleSuggestionLines.push(buildPanelLine(width, [[`  ${suggestion.summary}`, C.info]]));
      ruleSuggestionLines.push(buildGuidanceLine(width, suggestion.command, suggestion.reason, C));
    }
    if (ruleSuggestionLines.length === 0) {
      ruleSuggestionLines.push(buildPanelLine(width, [[`  No repeated denials currently suggest a durable rule.`, C.dim]]));
    }
    const postureSection: PanelWorkspaceSection = { title: 'Approval posture', lines: postureLines };
    const selectedSection: PanelWorkspaceSection = { title: 'Selected Lane', lines: detailLines };
    const pressureSection: PanelWorkspaceSection = { title: 'Recent Pressure', lines: recentAuditLines };
    const rulesSection: PanelWorkspaceSection = { title: 'Rule Suggestions', lines: ruleSuggestionLines };
    const resolvedLanesSection = resolvePrimaryScrollableSection(width, height, {
      intro: 'Action-specific review lanes for approvals, denials, escalations, and preflight guidance.',
      footerLines,
      palette: C,
      beforeSections: [postureSection, selectedSection, pressureSection, rulesSection],
      section: {
        title: 'Review Lanes',
        scrollableLines: APPROVAL_ROWS.map((row, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            ['  ', C.label],
            [row[0].padEnd(10), C.info, bg],
            [row[1].slice(0, Math.max(0, width - 18)), C.value, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
    });
    this.scrollOffset = resolvedLanesSection.scrollOffset;
    const lines = buildPanelWorkspace(width, height, {
      title: 'Approval Control Room',
      intro: 'Action-specific review lanes for approvals, denials, escalations, and preflight guidance.',
      sections: [
        postureSection,
        selectedSection,
        pressureSection,
        rulesSection,
        resolvedLanesSection.section,
      ],
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
