import type { Line } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { PanelIntegrationContext } from './types.ts';
import {
  buildBodyText,
  buildDetailBlock,
  buildGuidanceLine,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildStatusBadge,
  DEFAULT_PANEL_PALETTE,
  type StatusBadgeKind,
} from './polish.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import type { PolicyRuntimeState, PermissionAuditEntry } from '@/runtime/index.ts';
import { buildPermissionRuleSuggestions } from '@/runtime/index.ts';

// Splits a computed '/command arg1 arg2' string into the { name, args } shape
// ctx.executeCommand expects — same leading-slash-stripping approach used by
// remote-panel.ts / session-browser-panel.ts for their own dispatched commands.
function parseCommand(command: string): { name: string; args: string[] } | null {
  const parts = command.replace(/^\//, '').split(/\s+/).filter(Boolean);
  const [name, ...args] = parts;
  return name ? { name, args } : null;
}

// Base chrome only — title band comes straight from DEFAULT_PANEL_PALETTE
// (WO-002).
const C = DEFAULT_PANEL_PALETTE;

// Reference catalog of approval lanes and where each one is reviewed. Used to
// resolve the next-step command for a live request and as a fallback reference
// when no live requests are present.
const LANE_REVIEW: Record<string, { command: string; why: string }> = {
  shell:    { command: '/security', why: 'side effects, destructive ops, secret exposure, escalation' },
  file:     { command: '/approval review file', why: 'config mutation, notebook edits, secret-bearing paths' },
  network:  { command: '/approval review network', why: 'external hosts, fetch scope, egress policy' },
  delegate: { command: '/approval review delegate', why: 'recursive agents, spawn ceilings, write-set inheritance' },
  mcp:      { command: '/mcp trust', why: 'trust escalation, host scope, path scope, coherence mismatch' },
  remote:   { command: '/remote', why: 'runner trust, remote write scope, artifact requirements' },
  hook:     { command: '/hooks', why: 'deny/mutate authority, blocking behavior, runner provenance' },
  plugin:   { command: '/marketplace', why: 'install/update lifecycle, provenance, capability grants' },
  sandbox:  { command: '/sandbox review', why: 'WSL/VM isolation changes alter host risk posture' },
};

function laneOf(entry: PermissionAuditEntry): string {
  const key = (entry.category || entry.tool || '').toLowerCase();
  for (const lane of Object.keys(LANE_REVIEW)) {
    if (key.includes(lane)) return lane;
  }
  return key || 'shell';
}

function reviewFor(entry: PermissionAuditEntry): { command: string; why: string } {
  return LANE_REVIEW[laneOf(entry)] ?? { command: '/security', why: 'review approval posture' };
}

function decisionOf(entry: PermissionAuditEntry): 'pending' | 'approved' | 'denied' {
  return entry.approved === undefined ? 'pending' : entry.approved ? 'approved' : 'denied';
}

function badgeKind(decision: 'pending' | 'approved' | 'denied'): StatusBadgeKind {
  return decision === 'pending' ? 'pending' : decision === 'approved' ? 'completed' : 'failed';
}

function riskColor(risk: string): string {
  const r = risk.toLowerCase();
  if (r.includes('critical') || r.includes('high')) return C.bad;
  if (r.includes('medium') || r.includes('moderate')) return C.warn;
  return C.good;
}

function fmtAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

export class ApprovalPanel extends ScrollableListPanel<PermissionAuditEntry> {
  private readonly policyRuntimeState: Pick<PolicyRuntimeState, 'getSnapshot'>;
  // p / 1-3 = dispatch '/policy simulate' or a rule-suggestion command via the
  // handleInput -> handlePanelIntegrationAction bridge (handleInput has no
  // ctx.executeCommand — same pattern as remote-panel.ts / session-browser-panel.ts).
  private pendingCommand: { name: string; args: string[] } | null = null;

  public constructor(policyRuntimeState: Pick<PolicyRuntimeState, 'getSnapshot'>) {
    super('approval', 'Approval', 'A', 'security-policy');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.policyRuntimeState = policyRuntimeState;
  }

  private getRuleSuggestions() {
    const audit = this.policyRuntimeState.getSnapshot().recentPermissionAudit;
    return buildPermissionRuleSuggestions(audit).slice(0, 3);
  }

  override handleInput(key: string): boolean {
    if (key === 'p') {
      this.pendingCommand = parseCommand('/policy simulate');
      return true;
    }
    if (key === '1' || key === '2' || key === '3') {
      const suggestion = this.getRuleSuggestions()[Number(key) - 1];
      if (!suggestion) return false;
      this.pendingCommand = parseCommand(suggestion.command);
      return true;
    }
    return super.handleInput(key);
  }

  /** Drains `pendingCommand` (set by 'p' or '1'/'2'/'3') via the ctx.executeCommand bridge. */
  handlePanelIntegrationAction(_key: string, ctx: PanelIntegrationContext): boolean {
    if (!this.pendingCommand) return false;
    const { name, args } = this.pendingCommand;
    this.pendingCommand = null;
    void ctx.executeCommand?.(name, args);
    return true;
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No approval pressure right now.'; }
  protected override getEmptyStateActions() {
    return [
      { command: '/security', summary: 'inspect trust, tokens, quarantines, and incident pressure' },
      { command: '/policy simulate', summary: 'preview which requests a rule change would auto-approve' },
    ];
  }

  // Pending requests (those still needing a decision) are surfaced first so the
  // operator sees actionable items at the top, then most-recent decisions.
  protected getItems(): readonly PermissionAuditEntry[] {
    const audit = this.policyRuntimeState.getSnapshot().recentPermissionAudit;
    const pending = audit.filter((e) => e.approved === undefined);
    const decided = audit.filter((e) => e.approved !== undefined);
    return [...pending, ...decided];
  }

  protected renderItem(entry: PermissionAuditEntry, _index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    const decision = decisionOf(entry);
    const badge = buildStatusBadge(badgeKind(decision), decision)[0]!;
    const detailWidth = Math.max(0, width - 40);
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [`${badge.text} `.padEnd(12), badge.fg, bg],
      [`${truncateDisplay(entry.tool, 12)} `.padEnd(13), C.value, bg],
      [`${truncateDisplay(entry.riskLevel, 6)} `.padEnd(7), riskColor(entry.riskLevel), bg],
      [truncateDisplay(entry.summary, detailWidth), C.dim, bg],
    ]);
  }

  /** Next-step review command for the currently selected request (if any). */
  public getSelectedCommand(): string | null {
    const selected = this.getSelectedItem();
    return selected ? reviewFor(selected).command : null;
  }

  public render(width: number, height: number): Line[] {
    this.clampSelection();
    const audit = this.policyRuntimeState.getSnapshot().recentPermissionAudit;
    const approvalCount = audit.filter((e) => e.approved === true).length;
    const denialCount = audit.filter((e) => e.approved === false).length;
    const pendingCount = audit.filter((e) => e.approved === undefined).length;

    const selected = this.getSelectedItem() ?? null;

    // ---- Posture summary (severity + counts first) ----
    const headerLines: Line[] = [
      buildPanelLine(width, [
        ['  ', C.label],
        ...buildStatusBadge('pending', 'pending', { count: pendingCount }),
        ['   ', C.dim],
        ...buildStatusBadge('completed', 'approved', { count: approvalCount }),
        ['   ', C.dim],
        ...buildStatusBadge('failed', 'denied', { count: denialCount }),
      ]),
      pendingCount > 0
        ? buildPanelLine(width, [[`  ${pendingCount} request${pendingCount !== 1 ? 's' : ''} awaiting a decision — select one to see its review path.`, C.warn]])
        : buildPanelLine(width, [
            ['  p ', C.info],
            ['/policy simulate — preview which requests a scoped rule change would auto-approve', C.dim],
          ]),
    ];

    // ---- Detail block for the selected request ----
    const detailLines: Line[] = [];
    if (selected) {
      const review = reviewFor(selected);
      const decision = decisionOf(selected);
      detailLines.push(...buildDetailBlock(width, `Request · ${selected.tool}`, [
        buildKeyValueLine(width, [
          { label: 'decision', value: decision, valueColor: decision === 'pending' ? C.info : decision === 'approved' ? C.good : C.bad },
          { label: 'risk', value: selected.riskLevel, valueColor: riskColor(selected.riskLevel) },
          { label: 'lane', value: laneOf(selected), valueColor: C.info },
        ], C),
        buildKeyValueLine(width, [
          { label: 'requested', value: fmtAgo(selected.requestedAt), valueColor: C.dim },
          ...(selected.decidedAt ? [{ label: 'decided', value: fmtAgo(selected.decidedAt), valueColor: C.dim }] : []),
          ...(selected.target ? [{ label: 'target', value: truncateDisplay(selected.target, 24), valueColor: C.value }] : []),
        ], C),
        ...buildBodyText(width, selected.summary, C, C.value),
        ...(selected.reasons[0]
          ? buildBodyText(width, `why prompted: ${selected.reasons[0]}`, C, C.dim)
          : buildBodyText(width, `why prompted: ${review.why}`, C, C.dim)),
        buildGuidanceLine(width, review.command, `review and decide the ${laneOf(selected)} request`, C),
      ], C));
    }

    // ---- Durable-rule suggestions from repeated denials (dispatchable via 1/2/3) ----
    const suggestions = this.getRuleSuggestions();
    const ruleSuggestionLines: Line[] = [];
    suggestions.forEach((suggestion, index) => {
      ruleSuggestionLines.push(buildPanelLine(width, [
        [`  ${index + 1}) `, C.info],
        [truncateDisplay(suggestion.summary, Math.max(0, width - 8)), C.info],
      ]));
      ruleSuggestionLines.push(buildGuidanceLine(width, suggestion.command, suggestion.reason, C));
    });
    if (ruleSuggestionLines.length > 0) {
      ruleSuggestionLines.unshift(buildPanelLine(width, [['  Suggested durable rules (press 1/2/3 to apply)', C.label]]));
    }

    // ---- Context-aware footer: only show review key when a request is selected ----
    const hints = selected
      ? [
          { keys: '↑/↓', label: 'select' },
          { keys: 'Enter', label: `review (${reviewFor(selected).command})` },
          { keys: 'g/G', label: 'top/bottom' },
        ]
      : [
          { keys: '↑/↓', label: 'select' },
          { keys: 'g/G', label: 'top/bottom' },
        ];
    if (suggestions.length > 0) hints.push({ keys: '1-3', label: 'apply rule suggestion' });
    if (pendingCount === 0) hints.push({ keys: 'p', label: 'policy simulate' });

    return this.renderList(width, height, {
      title: 'Approval Control Room',
      header: headerLines,
      footer: [...detailLines, ...ruleSuggestionLines, buildKeyboardHints(width, hints, C)],
    });
  }

  protected override onSelect(item: PermissionAuditEntry): void {
    void item; // Enter is wired by the shell to open getSelectedCommand(); selection model lives here.
  }
}
