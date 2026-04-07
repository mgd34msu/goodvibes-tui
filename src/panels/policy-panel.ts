import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { PolicyRuntimeState } from '../runtime/permissions/policy-runtime.ts';
import type { PolicyPanelSnapshot } from '../runtime/diagnostics/panels/policy.ts';
import {
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';
import { getVisibleWindow } from '../renderer/surface-layout.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#475569',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  info: '#38bdf8',
  empty: '#334155',
} as const;

function fmtTime(value: string | undefined): string {
  if (!value) return 'n/a';
  return value.replace('T', ' ').slice(0, 19);
}

function fmtRate(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function gateColor(status: string | undefined): string {
  switch (status) {
    case 'allowed':
      return C.ok;
    case 'blocked':
      return C.error;
    case 'no_data':
      return C.warn;
    default:
      return C.dim;
  }
}

export class PolicyPanel extends BasePanel {
  private readonly _state: PolicyRuntimeState;
  private readonly _unsub: (() => void) | null;
  private _scrollOffset = 0;

  public constructor(state: PolicyRuntimeState) {
    super('policy', 'Policy', 'U', 'monitoring');
    this._state = state;
    this._unsub = state.subscribe(() => this.markDirty());
  }

  public override onActivate(): void {
    super.onActivate();
    this._scrollOffset = 0;
  }

  public override onDestroy(): void {
    this._unsub?.();
  }

  public handleInput(key: string): boolean {
    if (key === 'up' || key === 'k') {
      this._scrollOffset = Math.max(0, this._scrollOffset - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this._scrollOffset++;
      this.markDirty();
      return true;
    }
    if (key === 'r') {
      this._state.recordTrendEntry();
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const snapshot = this._state.getSnapshot();
    const content = this._buildContent(width, snapshot);
    const contentWindow = getVisibleWindow(content.length, this._scrollOffset, Math.max(4, height - 8));
    const maxScroll = Math.max(0, content.length - contentWindow.count);
    const offset = Math.min(this._scrollOffset, maxScroll);
    const visible = content.slice(offset, offset + contentWindow.count);
    const lines = buildPanelWorkspace(width, height, {
      title: 'Policy And Governance',
      sections: [{ title: 'Governance', lines: visible }],
      footerLines: [buildPanelLine(width, [['  Up/Down scroll  r record divergence trend snapshot', C.dim]])],
      palette: C,
    });
    while (lines.length < height) {
      lines.push(createEmptyLine(width));
    }
    return lines.slice(0, height);
  }

  private _buildContent(width: number, snapshot: PolicyPanelSnapshot): Line[] {
    const lines: Line[] = [];
    const current = snapshot.current;
    const candidate = snapshot.candidate;
    const divergence = snapshot.divergence;
    const permissionAudit = snapshot.recentPermissionAudit;
    const lintFindings = snapshot.lintFindings;
    const simulationSummary = snapshot.lastSimulationSummary;
    const preflightReview = snapshot.lastPreflightReview;

    if (!current && !candidate) {
      lines.push(buildPanelLine(width, [[' No policy bundles loaded. Use /policy load to begin.', C.empty]]));
    }

    if (current) {
      lines.push(buildPanelLine(width, [[' Current', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  Bundle: ', C.label],
        [current.bundle.bundleId, C.value],
        ['  State: ', C.label],
        [current.state, C.info],
      ]));
      lines.push(buildPanelLine(width, [
        ['  Loaded: ', C.label],
        [fmtTime(current.loadedAt), C.dim],
        ['  Active: ', C.label],
        [fmtTime(current.activatedAt), C.dim],
      ]));
    }

    if (candidate) {
      lines.push(buildPanelLine(width, [[' Candidate', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  Bundle: ', C.label],
        [candidate.bundle.bundleId, C.value],
        ['  State: ', C.label],
        [candidate.state, C.info],
      ]));
      lines.push(buildPanelLine(width, [
        ['  Loaded: ', C.label],
        [fmtTime(candidate.loadedAt), C.dim],
        ['  Rules: ', C.label],
        [String(candidate.rules.length), C.value],
      ]));
    }

    if (snapshot.diff) {
      lines.push(buildPanelLine(width, [[' Diff', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  Changes: ', C.label],
        [String(snapshot.diff.totalChanges), C.value],
        ['  Added: ', C.label],
        [String(snapshot.diff.added.length), C.ok],
        ['  Removed: ', C.label],
        [String(snapshot.diff.removed.length), C.error],
        ['  Changed: ', C.label],
        [String(snapshot.diff.changed.length), C.warn],
      ]));
    }

    if (divergence) {
      lines.push(buildPanelLine(width, [[' Governance Gate', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  Mode: ', C.label],
        [divergence.mode, C.info],
        ['  Gate: ', C.label],
        [divergence.gate.status, gateColor(divergence.gate.status)],
        ['  Divergence: ', C.label],
        [fmtRate(divergence.gate.divergenceRate ?? divergence.report.overall.divergenceRate), C.value],
      ]));
      lines.push(buildPanelLine(width, [
        ['  Evaluations: ', C.label],
        [String(divergence.report.overall.totalEvaluations), C.value],
        ['  Trend points: ', C.label],
        [String(divergence.trend.length), C.value],
      ]));
    }

    if (snapshot.history.length > 0) {
      lines.push(buildPanelLine(width, [[' History', C.label]]));
      for (const version of snapshot.history.slice(0, 5)) {
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [version.bundle.bundleId, C.value],
          ['  ', C.label],
          [version.state, C.dim],
          ['  ', C.label],
          [fmtTime(version.activatedAt ?? version.loadedAt), C.dim],
        ]));
      }
    }

    if (permissionAudit.length > 0) {
      lines.push(buildPanelLine(width, [[' Permission Audit', C.label]]));
      for (const entry of permissionAudit.slice(0, 5)) {
        const outcome = entry.approved === undefined ? 'pending' : entry.approved ? 'approved' : 'denied';
        const outcomeColor = entry.approved === undefined ? C.warn : entry.approved ? C.ok : C.error;
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [entry.tool, C.value],
          ['  ', C.label],
          [entry.riskLevel.toUpperCase(), outcomeColor],
          ['  ', C.label],
          [outcome, outcomeColor],
        ]));
        lines.push(buildPanelLine(width, [
          ['    ', C.label],
          [entry.summary.slice(0, Math.max(0, width - 6)), C.dim],
        ]));
      }
    }

    if (lintFindings.length > 0) {
      lines.push(buildPanelLine(width, [[' Policy Lint', C.label]]));
      for (const finding of lintFindings.slice(0, 5)) {
        const color = finding.severity === 'error' ? C.error : finding.severity === 'warn' ? C.warn : C.info;
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [finding.severity.toUpperCase(), color],
          ['  ', C.label],
          [finding.message.slice(0, Math.max(0, width - 14)), color],
        ]));
      }
    }

    if (!preflightReview) {
      if (!current && !candidate && !divergence && snapshot.history.length === 0 && permissionAudit.length === 0 && lintFindings.length === 0 && !simulationSummary) {
        lines.push(buildPanelLine(width, [[' Preflight Review', C.label]]));
        lines.push(buildPanelLine(width, [['  No proactive preflight review recorded yet.', C.empty]]));
      }
    } else {
      lines.push(buildPanelLine(width, [[' Preflight Review', C.label]]));
      const statusColor =
        preflightReview.status === 'pass'
          ? C.ok
          : preflightReview.status === 'warn'
            ? C.warn
            : C.error;
      lines.push(buildPanelLine(width, [
        ['  Status: ', C.label],
        [preflightReview.status.toUpperCase(), statusColor],
        ['  Issues: ', C.label],
        [String(preflightReview.issueCount), C.value],
        ['  Generated: ', C.label],
        [fmtTime(preflightReview.generatedAt), C.dim],
      ]));
      lines.push(buildPanelLine(width, [
        ['  ', C.label],
        [preflightReview.summary.slice(0, Math.max(0, width - 2)), C.dim],
      ]));
      for (const issue of preflightReview.issues.slice(0, 4)) {
        const issueColor = issue.severity === 'error' ? C.error : issue.severity === 'warn' ? C.warn : C.info;
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [issue.severity.toUpperCase(), issueColor],
          ['  ', C.label],
          [issue.message.slice(0, Math.max(0, width - 14)), issueColor],
        ]));
      }
    }

    if (!simulationSummary) {
      if (!current && !candidate && !divergence && snapshot.history.length === 0 && permissionAudit.length === 0 && lintFindings.length === 0 && !preflightReview) {
        lines.push(buildPanelLine(width, [[' Simulation Samples', C.label]]));
        lines.push(buildPanelLine(width, [['  No concrete simulation samples recorded yet.', C.empty]]));
      }
    } else {
      lines.push(buildPanelLine(width, [[' Simulation Samples', C.label]]));
      lines.push(buildPanelLine(width, [
        ['  Mode: ', C.label],
        [simulationSummary.mode, C.info],
        ['  Diverged: ', C.label],
        [`${simulationSummary.divergentScenarios}/${simulationSummary.totalScenarios}`, simulationSummary.divergentScenarios > 0 ? C.warn : C.ok],
        ['  Allowed(actual/sim): ', C.label],
        [`${simulationSummary.allowedByActual}/${simulationSummary.allowedBySimulated}`, C.value],
      ]));
      for (const result of simulationSummary.results.slice(0, 4)) {
        const color = result.diverged ? C.warn : (result.authoritativeDecision.allowed ? C.ok : C.error);
        lines.push(buildPanelLine(width, [
          ['  ', C.label],
          [result.scenario.label.slice(0, Math.max(0, width - 40)), C.value],
          ['  ', C.label],
          [(result.authoritativeDecision.allowed ? 'allow' : 'deny').toUpperCase(), color],
          ['  ', C.label],
          [result.diverged ? (result.divergenceType ?? 'diverged') : 'aligned', color],
        ]));
      }
    }

    lines.push(buildPanelLine(width, [['  /policy opens this panel. Press r to record a divergence trend snapshot.', C.dim]]));
    return lines;
  }
}
