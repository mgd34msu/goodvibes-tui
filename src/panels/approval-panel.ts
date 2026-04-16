import type { Line } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import type { PolicyRuntimeState } from '@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime';
import { buildPermissionRuleSuggestions } from '@pellux/goodvibes-sdk/platform/runtime/permissions/rule-suggestions';

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

type ApprovalRow = (typeof APPROVAL_ROWS)[number];

export class ApprovalPanel extends ScrollableListPanel<ApprovalRow> {
  private readonly policyRuntimeState: Pick<PolicyRuntimeState, 'getSnapshot'>;

  public constructor(policyRuntimeState: Pick<PolicyRuntimeState, 'getSnapshot'>) {
    super('approval', 'Approval', 'A', 'monitoring');
    this.policyRuntimeState = policyRuntimeState;
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No approval lanes defined.'; }

  protected getItems(): readonly ApprovalRow[] {
    return APPROVAL_ROWS;
  }

  protected renderItem(row: ApprovalRow, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      ['  ', C.label],
      [row[0].padEnd(10), C.info, bg],
      [row[1].slice(0, Math.max(0, width - 18)), C.value, bg],
    ]);
  }

  public handleInput(key: string): boolean {
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
    return super.handleInput(key);
  }

  public getSelectedCommand(): string | null {
    const selected = APPROVAL_ROWS[this.selectedIndex] ?? null;
    return selected ? selected[2].replace('review via ', '').trim() : null;
  }

  public render(width: number, height: number): Line[] {
    this.clampSelection();
    const policySnapshot = this.policyRuntimeState.getSnapshot();
    const approvalCount = policySnapshot.recentPermissionAudit.filter((e) => e.approved === true).length;
    const denialCount = policySnapshot.recentPermissionAudit.filter((e) => e.approved === false).length;
    const pendingCount = policySnapshot.recentPermissionAudit.filter((e) => e.approved === undefined).length;

    const selected = APPROVAL_ROWS[this.selectedIndex] ?? null;
    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(buildPanelLine(width, [['  Selected Lane', C.label]]));
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

    const headerLines: Line[] = [
      buildPanelLine(width, [['  Approval posture', C.label]]),
      buildKeyValueLine(width, [
        { label: 'why prompted', value: 'risk summary', valueColor: C.value },
        { label: 'what-if', value: '/policy simulate + preflight', valueColor: C.info },
        { label: 'operator', value: '/security + /cockpit', valueColor: C.good },
      ], C),
      buildPanelLine(width, [
        ['  \u2713 ', C.good],
        [`approvals (${approvalCount})  `, C.good],
        ['\u2715 ', C.bad],
        [`denials (${denialCount})  `, C.bad],
        ['\u25cb ', C.info],
        [`pending (${pendingCount})`, C.info],
      ]),
      buildGuidanceLine(width, '/approval review shell', 'inspect the highest-risk approval lane and refine scoped review posture', C),
      ...detailLines,
      ...recentAuditLines,
      ...ruleSuggestionLines,
    ];

    return this.renderList(width, height, {
      title: 'Approval Control Room',
      header: headerLines,
      footer: [buildPanelLine(width, [[`  Up/Down move  Home/End jump  selected lane opens the next command path`, C.dim]])],
    });
  }
}
